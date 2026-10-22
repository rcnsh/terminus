import XCTest

@testable import Terminus

/// The Buses tab's rules (BusesLogic.swift), as Android's BusesTest.
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

    func testPagesPutTheNearestStopFirstOnce() {
        XCTAssertEqual(BusPins.pages(nearest: nil, pins: []), [nil])
        XCTAssertEqual(BusPins.pages(nearest: "PGP", pins: ["COM3", "PGP", "COM3"]), ["PGP", "COM3"])
        XCTAssertEqual(BusPins.pages(nearest: nil, pins: ["COM3"]), [nil, "COM3"])
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
