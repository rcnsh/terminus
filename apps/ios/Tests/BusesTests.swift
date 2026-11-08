import XCTest

@testable import Terminus

/// The Stops tab's rules (BusesLogic.swift), as Android's BusesTest.
final class BusesTests: XCTestCase {
    private func row(_ json: String) throws -> BoardRow {
        try JSONDecoder().decode(BoardRow.self, from: Data(json.utf8))
    }

    // MARK: pins and pages

    func testPinsToggle() {
        XCTAssertEqual(BusPins.toggle([], "COM3"), ["COM3"])
        XCTAssertEqual(BusPins.toggle(["COM3", "UTOWN"], "COM3"), ["UTOWN"])
        // Full: nothing more is pinned, but one can still be unpinned.
        XCTAssertEqual(BusPins.toggle(["A", "B"], "C", max: 2), ["A", "B"])
        XCTAssertEqual(BusPins.toggle(["A", "B"], "A", max: 2), ["B"])
    }

    func testTheHomeShowsEachPinOnceUpToTheLimit() {
        XCTAssertEqual(BusPins.shown([]), [])
        XCTAssertEqual(BusPins.shown(["COM3", "PGP", "COM3"]), ["COM3", "PGP"])
        XCTAssertEqual(BusPins.shown(["A", "B", "C"], max: 2), ["A", "B"])
    }

    // MARK: the home

    func testThePageShowingIsTheChosenOneWhileItsPinnedElseTheFirst() {
        XCTAssertNil(BusPinned.page([], selected: "COM3"))
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: nil), "COM3")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: "UTOWN"), "UTOWN")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: "KV"), "COM3")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: BusPinned.addPage), BusPinned.addPage)
    }

    func testACardFilledFromItsBoardKeepsOnlyItsGuessesNeverAnOldLiveTime() throws {
        // The card from /me/stops: a live next and then, and a guess after.
        let card = [
            try row(
                #"{"svc":"D2","etaS":120,"quality":"live","dest":"via UTown","later":[{"etaS":600,"quality":"live","eta":"10 min"},{"etaS":1500,"quality":"scheduled","eta":"~25 min"}]}"#
            )
        ]
        // A minute later the board still sends both live times: the guess stays, a minute nearer.
        let both = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","later":[{"etaS":540,"quality":"live"}]}"#)], since: 60)
        XCTAssertEqual(both[0].later.map(\.etaS), [540, 1440])
        XCTAssertEqual(both[0].later.map(\.quality), ["live", "scheduled"])
        // Its times from the board, its words still the card's: the board has no "via UTown".
        XCTAssertEqual(both[0].etaS, 60)
        XCTAssertEqual(both[0].dest, "via UTown")
        // The night's last bus: the board drops the "then". The card's old live
        // then isn't carried on counting down; only the guess is.
        let last = BusPinned.filled(card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","later":[]}"#)], since: 60)
        XCTAssertEqual(last[0].later.map(\.etaS), [1440])
        XCTAssertEqual(last[0].later.map(\.quality), ["scheduled"])
        // Four minutes on the first has gone and the board shows one bus (the
        // card's second, a little early): the guess after it says ~21, worded
        // from the time left, not the server's "~25 min".
        let later = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","eta":"1 min","later":[]}"#)], since: 240)
        XCTAssertEqual(NearbyCells.cells(later[0]).map(\.text), ["1 min", "~21", "–"])
        // The rest is the board's: a service that has stopped for the night, or how full it is, shows at once.
        let ended = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","quality":"ended","running":false,"stopped":"ended","crowd":"low","later":[]}"#)], since: 60)
        XCTAssertFalse(ended[0].running)
        XCTAssertEqual(ended[0].stopped, "ended")
        XCTAssertEqual(ended[0].crowd, "low")
        XCTAssertEqual(ended[0].dest, "via UTown")
    }

    func testABusRunningAheadOfItsGuessIsNotShownTwice() throws {
        // The card at 0 s: D1 in 100 s, then 700 s, then a guess at 1300 s.
        let card = [
            try row(
                #"{"svc":"D1","etaS":100,"quality":"live","later":[{"etaS":700,"quality":"live"},{"etaS":1300,"quality":"scheduled"}]}"#)
        ]
        // 100 s on, the first has come; the board has the other two, the guessed one running ahead (1150, not 1200).
        let filled = BusPinned.filled(
            card, from: [try row(#"{"svc":"D1","etaS":600,"quality":"live","later":[{"etaS":1150,"quality":"live"}]}"#)], since: 100)
        XCTAssertEqual(filled[0].later.map(\.etaS), [1150])
        XCTAssertEqual(filled[0].later.map(\.quality), ["live"])
    }

    func testEachBoardIsMergedFromTheCardsOwnAnswer() throws {
        // The card's answer at 0 s: D2 in 50 s, then 600 live, and two guesses.
        let card = [
            try row(
                #"{"svc":"D2","etaS":50,"quality":"live","later":[{"etaS":600,"quality":"live"},{"etaS":1200,"quality":"scheduled"},{"etaS":1800,"quality":"scheduled"}]}"#
            )
        ]
        // At 10 s the board shows only the next; at 20 s it shows the 600 bus again.
        let first = BusPinned.filled(card, from: [try row(#"{"svc":"D2","etaS":40,"quality":"live","later":[]}"#)], since: 10)
        XCTAssertEqual(first[0].later.map(\.etaS), [1190, 1790])
        let second = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":30,"quality":"live","later":[{"etaS":580,"quality":"live"}]}"#)], since: 20)
        // Both guesses still after it: neither went missing with the first board.
        XCTAssertEqual(second[0].later.map(\.etaS), [580, 1180, 1780])
    }

    func testAGuessOnlyTheBoardHadDoesNotComeBack() throws {
        // The card has D1 and nothing after; the board had its own guess, then didn't.
        let card = [try row(#"{"svc":"D1","etaS":300,"quality":"live","later":[]}"#)]
        let withGuess = BusPinned.filled(
            card, from: [try row(#"{"svc":"D1","etaS":225,"quality":"live","later":[{"etaS":880,"quality":"scheduled"}]}"#)], since: 75)
        XCTAssertEqual(withGuess[0].later.map(\.etaS), [880])
        let without = BusPinned.filled(card, from: [try row(#"{"svc":"D1","etaS":210,"quality":"live","later":[]}"#)], since: 90)
        XCTAssertEqual(without[0].later.map(\.etaS), [])
    }

    func testAServiceTheBoardDoesNotHaveStaysCountedDown() throws {
        let card = [
            try row(#"{"svc":"D1","etaS":100,"quality":"live","later":[{"etaS":700,"quality":"scheduled"}]}"#),
            try row(#"{"svc":"D2","etaS":200,"quality":"live","later":[{"etaS":900,"quality":"scheduled"}]}"#),
        ]
        let s = BusPinned.filled(
            card, from: [try row(#"{"svc":"D1","etaS":40,"quality":"live","later":[{"etaS":640,"quality":"live"}]}"#)], since: 60)
        XCTAssertEqual(s.map(\.svc), ["D1", "D2"])
        XCTAssertEqual(s[0].later.map(\.etaS), [640])
        // D2 a minute on, no longer live, its guess after it.
        XCTAssertEqual(s[1].etaS, 140)
        XCTAssertEqual(s[1].quality, "stale")
        XCTAssertEqual(s[1].later.map(\.etaS), [840])
    }

    func testOneServiceBothWaysKeepsEachWaysOwnRowInTheCardsOrder() throws {
        let card = [
            try row(
                #"{"svc":"D1","towards":["A"],"dest":"to A","etaS":100,"quality":"live","later":[{"etaS":700,"quality":"scheduled"}]}"#),
            try row(
                #"{"svc":"D1","towards":["B"],"dest":"to B","etaS":200,"quality":"live","later":[{"etaS":1000,"quality":"scheduled"}]}"#),
        ]
        let s = BusPinned.filled(
            card,
            from: [
                try row(#"{"svc":"D1","towards":["B"],"etaS":130,"quality":"live","later":[]}"#),
                try row(#"{"svc":"D1","towards":["A"],"etaS":50,"quality":"live","later":[]}"#),
            ], since: 60)
        XCTAssertEqual(
            s.map { "\($0.towards[0]) \($0.etaS ?? -1) \($0.later.map(\.etaS)) \($0.dest ?? "")" }, ["A 50 [640] to A", "B 130 [940] to B"])
    }

    func testAWayTheBoardLacksDoesNotTakeTheOtherWaysRow() throws {
        let card = [
            try row(#"{"svc":"D1","towards":["A"],"dest":"to A","etaS":100,"quality":"live","later":[]}"#),
            try row(#"{"svc":"D1","towards":["B"],"dest":"to B","etaS":200,"quality":"live","later":[]}"#),
        ]
        let s = BusPinned.filled(card, from: [try row(#"{"svc":"D1","towards":["B"],"etaS":130,"quality":"live","later":[]}"#)], since: 60)
        // A: its own time counted down, stale. B: the board's.
        XCTAssertEqual(s.map { "\($0.towards[0]) \($0.etaS ?? -1) \($0.quality)" }, ["A 40 stale", "B 130 live"])
    }

    func testARowMatchedByServiceAloneKeepsItsOwnWay() throws {
        let card = [try row(#"{"svc":"D1","towards":["A"],"toText":"to A","dest":"to A","etaS":100,"quality":"live","later":[]}"#)]
        let board = [try row(#"{"svc":"D1","towards":["B"],"toText":"to B","etaS":40,"quality":"live","later":[]}"#)]
        let s = BusPinned.filled(card, from: board, since: 60)
        // The board's time, the card's way and words, as Android and the web show it.
        XCTAssertEqual(s.map { "\($0.towards[0]) \($0.toText ?? "-") \($0.etaS ?? -1) \($0.quality)" }, ["A to A 40 live"])
    }

    func testPublicBusesStayOffThePinnedCard() throws {
        let card = [try row(#"{"svc":"D1","etaS":100,"quality":"live","later":[]}"#)]
        let s = BusPinned.filled(
            card,
            from: [
                try row(#"{"svc":"95","paid":true,"etaS":30,"quality":"live","later":[]}"#),
                try row(#"{"svc":"D1","etaS":40,"quality":"live","later":[]}"#),
            ], since: 60)
        XCTAssertEqual(s.map(\.svc), ["D1"])
    }

    func testACancelledAskIsNotAFailure() {
        // The page that asked went (replaced beside the list), or the session did: asked again, not shown as failed.
        XCTAssertTrue(BusAsk.cancelled(CancellationError()))
        XCTAssertTrue(BusAsk.cancelled(URLError(.cancelled)))
        // Not reached, or refused: a failure to show.
        XCTAssertFalse(BusAsk.cancelled(URLError(.timedOut)))
        XCTAssertFalse(BusAsk.cancelled(URLError(.notConnectedToInternet)))
        XCTAssertFalse(BusAsk.cancelled(ApiError(status: 503, message: "down")))
    }

    func testUnpinningTheStopShowingShowsTheOneThatTookItsPlace() {
        // Another stop unpinned: the same one stays.
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "C"], selected: "C"), "C")
        // The one showing: the next takes its place, or the one before when it was last.
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "C"], selected: "B"), "C")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "B"], selected: "C"), "B")
        // It and the one after it gone at once (Settings): the next still pinned.
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C", "D"], new: ["A", "D"], selected: "B"), "D")
        // None left: no page; a new pin keeps the page; the last page stays the last page.
        XCTAssertNil(BusPinned.selection(old: ["A"], new: [], selected: "A"))
        XCTAssertEqual(BusPinned.selection(old: ["A", "B"], new: ["A", "B", "C"], selected: "B"), "B")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B"], new: ["A"], selected: BusPinned.addPage), BusPinned.addPage)
        // Never chosen: still the first.
        XCTAssertNil(BusPinned.selection(old: ["A", "B"], new: ["B"], selected: nil))
        // Chosen while not yet shown (pinned elsewhere, then unpinned): the first.
        XCTAssertEqual(BusPinned.selection(old: ["A"], new: ["A", "B"], selected: "Z"), "A")
    }

    func testTheStopShowingIsAskedForWithItsNeighbours() {
        let pins = ["A", "B", "C", "D"]
        XCTAssertEqual(BusPinned.window(pins, selected: nil), ["A", "B"])
        XCTAssertEqual(BusPinned.window(pins, selected: "C"), ["B", "C", "D"])
        XCTAssertEqual(BusPinned.window(pins, selected: "D"), ["C", "D"])
        // The last page: its neighbour is the last stop.
        XCTAssertEqual(BusPinned.window(pins, selected: BusPinned.addPage), ["C", "D"])
        XCTAssertEqual(BusPinned.focus(pins, selected: BusPinned.addPage), "D")
        XCTAssertEqual(BusPinned.window(["A"], selected: "A"), ["A"])
        XCTAssertEqual(BusPinned.window([], selected: nil), [])
    }

    func testAStopAskedForMomentsAgoIsntAskedAgainUnlessPulled() {
        let now = Date()
        let asked = ["A": now.addingTimeInterval(-3), "B": now.addingTimeInterval(-12)]
        XCTAssertEqual(BusPinned.toFetch(["A", "B", "C"], now: now, gap: 10) { asked[$0] }, ["B", "C"])
        XCTAssertEqual(BusPinned.toFetch(["A", "B", "C"], now: now, gap: 10, force: true) { asked[$0] }, ["A", "B", "C"])
        XCTAssertEqual(BusPinned.toFetch(["A"], now: now, gap: 10) { asked[$0] }, [])
    }

    func testAPinnedRequestSettlesEachStopItAskedFor() {
        // Answered: each one that came back; one the server left out is missing, not still "Checking…".
        XCTAssertEqual(
            BusPinnedResult.of(asked: ["A", "B", "C"], returned: ["A", "C"], cancelled: false),
            BusPinnedResult(answered: ["A", "C"], missing: ["B"]))
        // Codes as the server writes them, whatever case they were asked in.
        XCTAssertEqual(BusPinnedResult.of(asked: ["kv"], returned: ["KV"], cancelled: false), BusPinnedResult(answered: ["kv"]))
        // Failed: every one couldn't be reached.
        XCTAssertEqual(BusPinnedResult.of(asked: ["A", "B"], returned: nil, cancelled: false), BusPinnedResult(failed: ["A", "B"]))
        // Cancelled (a swipe): none failed, all asked for again.
        XCTAssertEqual(BusPinnedResult.of(asked: ["A", "B"], returned: nil, cancelled: true), BusPinnedResult(askAgain: ["A", "B"]))
    }

    func testAPinnedStopsTimesCountDownOnceItsOld() throws {
        let json =
            #"{"stop":{"code":"COM3","name":"COM 3"},"walkS":60,"board":[{"svc":"D1","etaS":240,"quality":"live","eta":"4 min","later":[{"etaS":900,"quality":"live"}]}]}"#
        let stop = try JSONDecoder().decode(NearbyStop.self, from: Data(json.utf8))
        let got = Date(timeIntervalSince1970: 1_000_000)
        // Fresh: as it came.
        XCTAssertEqual(stop.aged(got: got, now: got.addingTimeInterval(10)).board[0].etaS, 240)
        XCTAssertEqual(stop.aged(got: got, now: got.addingTimeInterval(10)).board[0].quality, "live")
        // Old: counted down, and no longer passed off as live.
        let old = stop.aged(got: got, now: got.addingTimeInterval(120)).board[0]
        XCTAssertEqual(old.etaS, 120)
        XCTAssertEqual(old.quality, "stale")
        XCTAssertNil(old.eta)
        XCTAssertEqual(old.later.map(\.etaS), [780])
        XCTAssertEqual(NearbyCells.cells(old)[0].mark, "~")
        // Never got (a placeholder): nothing to age.
        XCTAssertEqual(stop.aged(got: nil, now: got.addingTimeInterval(600)).board[0].etaS, 240)
    }

    func testAServicesPageBringsTheListItsNewerCountAndAnOlderListKeepsIt() throws {
        let one = LineCount(out: 1, outText: "1 out")
        let none = LineCount(out: 0, outText: "None out")
        // The page's own count, as /api/line gives it; none from an older server.
        let page = #"{"svc": "K", "stops": [], "buses": [], "out": {"out": 0, "outText": "None out", "stale": false}}"#
        let line = try JSONDecoder().decode(Line.self, from: Data(page.utf8))
        XCTAssertEqual(line.out, none)
        XCTAssertNil(try JSONDecoder().decode(Line.self, from: Data(#"{"svc": "K", "stops": [], "buses": []}"#.utf8)).out)
        let t = { (s: TimeInterval) in Date(timeIntervalSince1970: 1_000_000 + s) }
        // The list counted K's last bus a moment before it left the feed; K's page, later, has none out.
        let outs = BusOuts().listed(["K": one, "D1": one], asOf: t(0)).paged("K", line.out, at: t(30))
        XCTAssertEqual(outs.shown, ["K": none, "D1": one])
        // A list counted before the page keeps the page's count; a newer one wins.
        XCTAssertEqual(outs.listed(["K": one, "D1": one], asOf: t(10)).shown, ["K": none, "D1": one])
        XCTAssertEqual(outs.listed(["K": one, "D1": none], asOf: t(50)).shown, ["K": one, "D1": none])
        // An older answer for the page changes nothing; no count, nothing; no list, nothing shown.
        XCTAssertEqual(outs.paged("K", one, at: t(20)), outs)
        XCTAssertEqual(outs.paged("K", nil, at: t(40)), outs)
        XCTAssertEqual(outs.listed([:], asOf: .distantPast).shown, [:])
    }

    func testTheLiveDotIsOnlyForAFreshCountOfBusesOut() {
        XCTAssertTrue(BusLines.showsDot(LineCount(out: 3, outText: "3 out")))
        XCTAssertFalse(BusLines.showsDot(LineCount(out: 3, outText: "3 out", stale: true)))
        XCTAssertFalse(BusLines.showsDot(LineCount(out: 0, outText: "None out")))
    }

    func testTheLinesCountsAreAskedAtMostOnceAMinute() {
        let now = Date()
        XCTAssertEqual(BusLines.wait(last: nil, now: now), 0)
        XCTAssertEqual(BusLines.wait(last: now.addingTimeInterval(-20), now: now), 40, accuracy: 0.001)
        XCTAssertEqual(BusLines.wait(last: now.addingTimeInterval(-60), now: now), 0)
        XCTAssertEqual(BusLines.wait(last: now.addingTimeInterval(-300), now: now), 0)
        // A clock put back: never longer than a minute.
        XCTAssertEqual(BusLines.wait(last: now.addingTimeInterval(30), now: now), 60, accuracy: 0.001)
    }

    func testALineRowIsReadAsOne() {
        Lang.pref = "en"
        let count = LineCount(out: 3, outText: "3 out")
        XCTAssertEqual(
            BusLines.spoken(svc: "D2", name: "Loop from COM 3", via: "via PGP, KR MRT, UTown", count: count),
            "Bus D2, Loop from COM 3, via PGP, KR MRT, UTown, 3 out")
        // No stops between its ends, and the feed not answering: neither said.
        XCTAssertEqual(BusLines.spoken(svc: "K", name: "PGP to PGP Foyer", via: nil, count: nil), "Bus K, PGP to PGP Foyer")
        Lang.pref = "zh"
        defer { Lang.pref = "en" }
        XCTAssertEqual(
            BusLines.spoken(svc: "R1", name: "Kent Vale 至 PGP", via: "经 UTown", count: LineCount(out: 2, outText: "2 辆在路上")),
            "R1 巴士，Kent Vale 至 PGP，经 UTown，2 辆在路上")
    }

    func testTheLinesAndTheirCountsAsTheServerWordsThem() throws {
        Lang.pref = "en"
        let json = #"""
            {"stops":[{"code":"COM3","name":"COM 3"},{"code":"PGP","name":"PGP"}],
             "routes":{"D1":{"seq":["COM3","PGP"],"loop":true,"name":"Loop from COM 3","via":"via UTown, CLB, AS 5"},
               "K":{"seq":["PGP","COM3"],"loop":false,"via":null}}}
            """#
        let campus = try JSONDecoder().decode(BusCampus.self, from: Data(json.utf8))
        let name = { (code: String) in campus.stop(code)?.fullName ?? code }
        XCTAssertEqual(campus.routes["D1"].flatMap { BusLines.name($0, stopName: name) }, "Loop from COM 3")
        XCTAssertEqual(campus.routes["D1"]?.via, "via UTown, CLB, AS 5")
        // An older campus without a name: worded here.
        XCTAssertEqual(campus.routes["K"].flatMap { BusLines.name($0, stopName: name) }, "PGP to COM 3")
        XCTAssertNil(campus.routes["K"]?.via)
        // A service the feed didn't answer for (null) is left out, not "None out".
        struct R: Decodable { let lines: [String: Lossy<LineCount>] }
        let lines = try JSONDecoder().decode(
            R.self,
            from: Data(
                #"{"lines":{"A1":{"out":3,"outText":"3 out","stale":false},"A2":{"out":0,"outText":"None out"},"K":null},"asOf":"x"}"#.utf8)
        ).lines.compactMapValues(\.value)
        XCTAssertEqual(lines, ["A1": LineCount(out: 3, outText: "3 out"), "A2": LineCount(out: 0, outText: "None out")])
    }

    func testAPinnedStopWithoutALocationHasNoWalk() throws {
        let json =
            #"{"stops":[{"stop":{"code":"COM3","name":"COM 3"},"walkS":null,"available":true,"board":[]},{"stop":{"code":"KV","name":"Kent Vale"},"walkS":240,"board":[]}],"asOf":"x"}"#
        struct R: Decodable { let stops: [NearbyStop] }
        let stops = try JSONDecoder().decode(R.self, from: Data(json.utf8)).stops
        XCTAssertNil(stops[0].walkS)
        XCTAssertEqual(stops[1].walkS, 240)
    }

    func testAServiceSaysWhereItGoes() throws {
        Lang.pref = "en"
        let json = #"""
            {"stops":[{"code":"COM3","name":"COM 3","services":["D1"]},{"code":"PGP","name":"PGP","longName":"Prince George's Park"},
              {"code":"PGPR","name":"PGP Foyer"}],
             "routes":{"D1":{"seq":["COM3","PGP"],"loop":true,"color":"#c1a6ff"},"K":{"seq":["PGP","COM3","PGPR"],"loop":false},"X":{}}}
            """#
        let campus = try JSONDecoder().decode(BusCampus.self, from: Data(json.utf8))
        XCTAssertEqual(campus.services, ["D1", "K", "X"])
        XCTAssertEqual(campus.color("D1"), "#c1a6ff")
        // Stops by their long names where they have one, as the web and Android say them.
        let name = { (code: String) in campus.stop(code)?.fullName ?? code }
        XCTAssertEqual(campus.routes["D1"].flatMap { BusWords.route($0, name: name) }, "Loop from COM 3")
        XCTAssertEqual(campus.routes["K"].flatMap { BusWords.route($0, name: name) }, "Prince George's Park to PGP Foyer")
        // A route without its stops: nothing under the service.
        XCTAssertNil(campus.routes["X"].flatMap { BusWords.route($0, name: name) })
    }

    // MARK: the search

    /// The shared cases every client is held to (fixtures/search.json, busesTab).
    func testSearchMatchesTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../fixtures/search.json")
        let all = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let tab = all["busesTab"] as! [String: Any]
        let campusJSON = try JSONSerialization.data(withJSONObject: tab["campus"]!)
        let campus = try JSONDecoder().decode(BusCampus.self, from: campusJSON)
        let index = BusSearch.index(campus)
        XCTAssertEqual(index.map(\.id), tab["index"] as! [String])
        let limit = tab["limit"] as! Int
        for q in tab["queries"] as! [[String: Any]] {
            let query = q["q"] as! String
            XCTAssertEqual(
                BusSearch.search(query, in: index, max: limit).map(\.id), q["expect"] as! [String], "\(query): \(q["why"] ?? "")")
        }
    }

    // MARK: a line

    func testLineItemsPutBusesAtAndBetweenStops() throws {
        let json = """
            {"svc":"D2","stops":[{"code":"A","name":"A"},{"code":"B","name":"B"},{"code":"C","name":"C"}],
             "buses":[{"id":"1","at":1},{"id":"2","after":0},{"id":"3","after":9}],
             "stop":{"code":"B","index":1}}
            """
        let line = try JSONDecoder().decode(Line.self, from: Data(json.utf8))
        let items = BusLineItem.of(line)
        XCTAssertEqual(items.map(\.id), ["s0", "b0", "s1", "s2"])
        if case .stop(_, _, let buses, let here) = items[2] {
            XCTAssertEqual(buses.map(\.id), ["1"])
            XCTAssertTrue(here)
        } else {
            XCTFail()
        }
        if case .between(_, let buses) = items[1] { XCTAssertEqual(buses.map(\.id), ["2"]) } else { XCTFail() }
    }

    // MARK: words

    func testThenIsTheServersElseWorkedOut() throws {
        Lang.pref = "en"
        XCTAssertEqual(BusWords.then(try row(#"{"svc":"A1","etaS":60,"laterText":"then 9 min","later":[{"etaS":600}]}"#)), "then 9 min")
        XCTAssertEqual(
            BusWords.then(
                try row(#"{"svc":"A1","etaS":60,"quality":"live","later":[{"etaS":1200,"quality":"live"},{"etaS":600,"quality":"live"}]}"#)),
            "then 10, 20 min")
        XCTAssertEqual(
            BusWords.then(try row(#"{"svc":"A1","etaS":60,"quality":"live","later":[{"etaS":600,"quality":"scheduled"}]}"#)),
            "then 10 min, estimated")
        XCTAssertNil(BusWords.then(try row(#"{"svc":"A1","etaS":60}"#)))
        // Two later buses at most, as the server words them.
        XCTAssertEqual(
            BusWords.then(try row(#"{"svc":"A1","etaS":60,"later":[{"etaS":600},{"etaS":1200},{"etaS":1800}]}"#)), "then 10, 20 min")
    }

    func testDestinationIsTheEndOfTheLineWithTheNextStopUnder() throws {
        Lang.pref = "en"
        let two = try row(
            #"{"svc":"A1","etaS":60,"towards":["AS 5","Kent Ridge Bus Terminal"],"toText":"to AS 5, Kent Ridge Bus Terminal"}"#)
        XCTAssertEqual(BusWords.destination(two), "Kent Ridge Bus Terminal")
        XCTAssertEqual(BusWords.nextStop(two), "Next stop AS 5")
        let one = try row(#"{"svc":"A1","etaS":60,"towards":["Kent Ridge Bus Terminal"]}"#)
        XCTAssertEqual(BusWords.destination(one), "Kent Ridge Bus Terminal")
        XCTAssertNil(BusWords.nextStop(one))
        let end = try row(#"{"svc":"A1","etaS":60,"towards":[],"endsHere":true}"#)
        XCTAssertEqual(BusWords.destination(end), "Ends here")
        XCTAssertNil(BusWords.nextStop(end))
        // An older server's sentence, without the names.
        XCTAssertEqual(BusWords.destination(try row(#"{"svc":"A1","etaS":60,"toText":"to Central Library"}"#)), "to Central Library")
    }

    func testLiveOnlyWithATime() throws {
        XCTAssertTrue(BusWords.isLive(try row(#"{"svc":"A1","etaS":60,"quality":"live"}"#)))
        XCTAssertFalse(BusWords.isLive(try row(#"{"svc":"A1","etaS":60,"quality":"scheduled"}"#)))
        XCTAssertFalse(BusWords.isLive(try row(#"{"svc":"A1","quality":"live"}"#)))
    }

    func testRunningFirst() throws {
        let rows = [try row(#"{"svc":"R1","running":false}"#), try row(#"{"svc":"A1","etaS":60}"#)]
        XCTAssertEqual(BusWords.runningFirst(rows).map(\.svc), ["A1", "R1"])
    }

    func testEndingSoonOnlyWithinTwoHoursOnceEach() throws {
        let now = parseISODate("2026-10-07T13:30:00Z")!
        let rows = [
            try row(#"{"svc":"K","endsAt":"2026-10-07T15:04:00Z"}"#),
            try row(#"{"svc":"A2","endsAt":"2026-10-07T15:00:00Z"}"#),
            try row(#"{"svc":"A2","endsAt":"2026-10-07T15:00:00Z"}"#),
            try row(#"{"svc":"D1","endsAt":"2026-10-07T16:00:00Z"}"#),
            try row(#"{"svc":"BTC","endsAt":"2026-10-07T13:00:00Z"}"#),
        ]
        XCTAssertEqual(BusWords.endingSoon(rows, now: now).map(\.svc), ["A2", "K"])
    }

    func testUpdated() {
        Lang.pref = "en"
        let t = Date()
        XCTAssertEqual(BusWords.updated(t, now: t.addingTimeInterval(3)), "Updated just now")
        XCTAssertEqual(BusWords.updated(t, now: t.addingTimeInterval(42)), "Updated 42 s ago")
        XCTAssertEqual(BusWords.updated(t, now: t.addingTimeInterval(130)), "Updated 2 min ago")
        // A clock a little behind the server's never says "-2 s ago".
        XCTAssertEqual(BusWords.updated(t, now: t.addingTimeInterval(-2)), "Updated just now")
    }

    func testSpokenTimes() {
        Lang.pref = "en"
        XCTAssertEqual(BusWords.spoken(30, quality: "live"), "Arriving")
        XCTAssertEqual(BusWords.spoken(70, quality: "live"), "1 minute")
        XCTAssertEqual(BusWords.spoken(360, quality: "scheduled"), "about 6 minutes")
        XCTAssertNil(BusWords.spoken(nil, quality: "live"))
    }

    func testAgedTimesAreCountedDownAndNotLive() throws {
        let r = try row(#"{"svc":"A1","etaS":300,"quality":"live","eta":"5 min","later":[{"etaS":900,"quality":"live"}]}"#)
        let got = Date()
        // Fresh: as it came.
        XCTAssertEqual(BusTimes.aged(r, got: got, now: got.addingTimeInterval(20)).etaS, 300)
        // Missed a refresh: counted down, no longer live, the server's words dropped.
        let old = BusTimes.aged(r, got: got, now: got.addingTimeInterval(60))
        XCTAssertEqual(old.etaS, 240)
        XCTAssertEqual(old.quality, "stale")
        XCTAssertNil(old.eta)
        XCTAssertEqual(old.later.map(\.etaS), [840])
    }
}
