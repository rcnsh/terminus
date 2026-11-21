import XCTest

@testable import Terminus

final class BusesTests: XCTestCase {
    private func row(_ json: String) throws -> BoardRow {
        try JSONDecoder().decode(BoardRow.self, from: Data(json.utf8))
    }

    func testPinsToggle() {
        XCTAssertEqual(BusPins.toggle([], "COM3"), ["COM3"])
        XCTAssertEqual(BusPins.toggle(["COM3", "UTOWN"], "COM3"), ["UTOWN"])
        XCTAssertEqual(BusPins.toggle(["A", "B"], "C", max: 2), ["A", "B"])
        XCTAssertEqual(BusPins.toggle(["A", "B"], "A", max: 2), ["B"])
    }

    func testTheHomeShowsEachPinOnceUpToTheLimit() {
        XCTAssertEqual(BusPins.shown([]), [])
        XCTAssertEqual(BusPins.shown(["COM3", "PGP", "COM3"]), ["COM3", "PGP"])
        XCTAssertEqual(BusPins.shown(["A", "B", "C"], max: 2), ["A", "B"])
    }

    func testThePageShowingIsTheChosenOneWhileItsPinnedElseTheFirst() {
        XCTAssertNil(BusPinned.page([], selected: "COM3"))
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: nil), "COM3")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: "UTOWN"), "UTOWN")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: "KV"), "COM3")
        XCTAssertEqual(BusPinned.page(["COM3", "UTOWN"], selected: BusPinned.addPage), BusPinned.addPage)
    }

    func testACardFilledFromItsBoardKeepsOnlyItsGuessesNeverAnOldLiveTime() throws {
        let card = [
            try row(
                #"{"svc":"D2","etaS":120,"quality":"live","dest":"via UTown","later":[{"etaS":600,"quality":"live","eta":"10 min"},{"etaS":1500,"quality":"scheduled","eta":"~25 min"}]}"#
            )
        ]
        let both = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","later":[{"etaS":540,"quality":"live"}]}"#)], since: 60)
        XCTAssertEqual(both[0].later.map(\.etaS), [540, 1440])
        XCTAssertEqual(both[0].later.map(\.quality), ["live", "scheduled"])
        XCTAssertEqual(both[0].etaS, 60)
        XCTAssertEqual(both[0].dest, "via UTown")
        let last = BusPinned.filled(card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","later":[]}"#)], since: 60)
        XCTAssertEqual(last[0].later.map(\.etaS), [1440])
        XCTAssertEqual(last[0].later.map(\.quality), ["scheduled"])
        let later = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":60,"quality":"live","eta":"1 min","later":[]}"#)], since: 240)
        XCTAssertEqual(NearbyCells.cells(later[0]).map(\.text), ["1 min", "~21", "–"])
        let ended = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","quality":"ended","running":false,"stopped":"ended","crowd":"low","later":[]}"#)], since: 60)
        XCTAssertFalse(ended[0].running)
        XCTAssertEqual(ended[0].stopped, "ended")
        XCTAssertEqual(ended[0].crowd, "low")
        XCTAssertEqual(ended[0].dest, "via UTown")
    }

    func testABusRunningAheadOfItsGuessIsNotShownTwice() throws {
        let card = [
            try row(
                #"{"svc":"D1","etaS":100,"quality":"live","later":[{"etaS":700,"quality":"live"},{"etaS":1300,"quality":"scheduled"}]}"#)
        ]
        let filled = BusPinned.filled(
            card, from: [try row(#"{"svc":"D1","etaS":600,"quality":"live","later":[{"etaS":1150,"quality":"live"}]}"#)], since: 100)
        XCTAssertEqual(filled[0].later.map(\.etaS), [1150])
        XCTAssertEqual(filled[0].later.map(\.quality), ["live"])
    }

    func testEachBoardIsMergedFromTheCardsOwnAnswer() throws {
        let card = [
            try row(
                #"{"svc":"D2","etaS":50,"quality":"live","later":[{"etaS":600,"quality":"live"},{"etaS":1200,"quality":"scheduled"},{"etaS":1800,"quality":"scheduled"}]}"#
            )
        ]
        let first = BusPinned.filled(card, from: [try row(#"{"svc":"D2","etaS":40,"quality":"live","later":[]}"#)], since: 10)
        XCTAssertEqual(first[0].later.map(\.etaS), [1190, 1790])
        let second = BusPinned.filled(
            card, from: [try row(#"{"svc":"D2","etaS":30,"quality":"live","later":[{"etaS":580,"quality":"live"}]}"#)], since: 20)
        XCTAssertEqual(second[0].later.map(\.etaS), [580, 1180, 1780])
    }

    func testAGuessOnlyTheBoardHadDoesNotComeBack() throws {
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
        XCTAssertEqual(s.map { "\($0.towards[0]) \($0.etaS ?? -1) \($0.quality)" }, ["A 40 stale", "B 130 live"])
    }

    func testARowMatchedByServiceAloneKeepsItsOwnWay() throws {
        let card = [try row(#"{"svc":"D1","towards":["A"],"toText":"to A","dest":"to A","etaS":100,"quality":"live","later":[]}"#)]
        let board = [try row(#"{"svc":"D1","towards":["B"],"toText":"to B","etaS":40,"quality":"live","later":[]}"#)]
        let s = BusPinned.filled(card, from: board, since: 60)
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
        XCTAssertTrue(BusAsk.cancelled(CancellationError()))
        XCTAssertTrue(BusAsk.cancelled(URLError(.cancelled)))
        XCTAssertFalse(BusAsk.cancelled(URLError(.timedOut)))
        XCTAssertFalse(BusAsk.cancelled(URLError(.notConnectedToInternet)))
        XCTAssertFalse(BusAsk.cancelled(ApiError(status: 503, message: "down")))
    }

    func testUnpinningTheStopShowingShowsTheOneThatTookItsPlace() {
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "C"], selected: "C"), "C")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "C"], selected: "B"), "C")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C"], new: ["A", "B"], selected: "C"), "B")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B", "C", "D"], new: ["A", "D"], selected: "B"), "D")
        XCTAssertNil(BusPinned.selection(old: ["A"], new: [], selected: "A"))
        XCTAssertEqual(BusPinned.selection(old: ["A", "B"], new: ["A", "B", "C"], selected: "B"), "B")
        XCTAssertEqual(BusPinned.selection(old: ["A", "B"], new: ["A"], selected: BusPinned.addPage), BusPinned.addPage)
        XCTAssertNil(BusPinned.selection(old: ["A", "B"], new: ["B"], selected: nil))
        XCTAssertEqual(BusPinned.selection(old: ["A"], new: ["A", "B"], selected: "Z"), "A")
    }

    func testTheStopShowingIsAskedForWithItsNeighbours() {
        let pins = ["A", "B", "C", "D"]
        XCTAssertEqual(BusPinned.window(pins, selected: nil), ["A", "B"])
        XCTAssertEqual(BusPinned.window(pins, selected: "C"), ["B", "C", "D"])
        XCTAssertEqual(BusPinned.window(pins, selected: "D"), ["C", "D"])
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
        XCTAssertEqual(
            BusPinnedResult.of(asked: ["A", "B", "C"], returned: ["A", "C"], cancelled: false),
            BusPinnedResult(answered: ["A", "C"], missing: ["B"]))
        XCTAssertEqual(BusPinnedResult.of(asked: ["kv"], returned: ["KV"], cancelled: false), BusPinnedResult(answered: ["kv"]))
        XCTAssertEqual(BusPinnedResult.of(asked: ["A", "B"], returned: nil, cancelled: false), BusPinnedResult(failed: ["A", "B"]))
        XCTAssertEqual(BusPinnedResult.of(asked: ["A", "B"], returned: nil, cancelled: true), BusPinnedResult(askAgain: ["A", "B"]))
    }

    func testAPinnedStopsTimesCountDownOnceItsOld() throws {
        let json =
            #"{"stop":{"code":"COM3","name":"COM 3"},"walkS":60,"board":[{"svc":"D1","etaS":240,"quality":"live","eta":"4 min","later":[{"etaS":900,"quality":"live"}]}]}"#
        let stop = try JSONDecoder().decode(NearbyStop.self, from: Data(json.utf8))
        let got = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(stop.aged(got: got, now: got.addingTimeInterval(10)).board[0].etaS, 240)
        XCTAssertEqual(stop.aged(got: got, now: got.addingTimeInterval(10)).board[0].quality, "live")
        let old = stop.aged(got: got, now: got.addingTimeInterval(120)).board[0]
        XCTAssertEqual(old.etaS, 120)
        XCTAssertEqual(old.quality, "stale")
        XCTAssertNil(old.eta)
        XCTAssertEqual(old.later.map(\.etaS), [780])
        XCTAssertEqual(NearbyCells.cells(old)[0].mark, "~")
        XCTAssertEqual(stop.aged(got: nil, now: got.addingTimeInterval(600)).board[0].etaS, 240)
    }

    func testAServicesPageBringsTheListItsNewerCountAndAnOlderListKeepsIt() throws {
        let one = LineCount(out: 1, outText: "1 out")
        let none = LineCount(out: 0, outText: "None out")
        let page = #"{"svc": "K", "stops": [], "buses": [], "out": {"out": 0, "outText": "None out", "stale": false}}"#
        let line = try JSONDecoder().decode(Line.self, from: Data(page.utf8))
        XCTAssertEqual(line.out, none)
        XCTAssertNil(try JSONDecoder().decode(Line.self, from: Data(#"{"svc": "K", "stops": [], "buses": []}"#.utf8)).out)
        let t = { (s: TimeInterval) in Date(timeIntervalSince1970: 1_000_000 + s) }
        let outs = BusOuts().listed(["K": one, "D1": one], asOf: t(0)).paged("K", line.out, at: t(30))
        XCTAssertEqual(outs.shown, ["K": none, "D1": one])
        XCTAssertEqual(outs.listed(["K": one, "D1": one], asOf: t(10)).shown, ["K": none, "D1": one])
        XCTAssertEqual(outs.listed(["K": one, "D1": none], asOf: t(50)).shown, ["K": one, "D1": none])
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
        XCTAssertEqual(BusLines.wait(last: now.addingTimeInterval(30), now: now), 60, accuracy: 0.001)
    }

    func testALineRowIsReadAsOne() {
        Lang.pref = "en"
        let count = LineCount(out: 3, outText: "3 out")
        XCTAssertEqual(
            BusLines.spoken(svc: "D2", name: "Loop from COM 3", via: "via PGP, KR MRT, UTown", count: count),
            "Bus D2, Loop from COM 3, via PGP, KR MRT, UTown, 3 out")
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
        XCTAssertEqual(campus.routes["D1"]?.name, "Loop from COM 3")
        XCTAssertEqual(campus.routes["D1"]?.via, "via UTown, CLB, AS 5")
        XCTAssertNil(campus.routes["K"]?.name)
        XCTAssertNil(campus.routes["K"]?.via)
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
    }

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
        let end = try row(#"{"svc":"A1","etaS":60,"towards":[],"toText":"Ends here"}"#)
        XCTAssertEqual(BusWords.destination(end), "Ends here")
        XCTAssertNil(BusWords.nextStop(end))
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
        XCTAssertEqual(BusTimes.aged(r, got: got, now: got.addingTimeInterval(20)).etaS, 300)
        let old = BusTimes.aged(r, got: got, now: got.addingTimeInterval(60))
        XCTAssertEqual(old.etaS, 240)
        XCTAssertEqual(old.quality, "stale")
        XCTAssertNil(old.eta)
        XCTAssertEqual(old.later.map(\.etaS), [840])
    }
}
