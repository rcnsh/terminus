import Foundation
import Testing

@testable import Terminus

/// Buses near you on a widget: clock times worked out once, a gone bus giving
/// way to the next, which next stop to name, the minutes and when to redraw,
/// and which layout fits. As Android's NearbyBoardTest and NearbyFitTest.

private let fetched = Date(timeIntervalSince1970: 1_800_000_000)

private func at(_ s: TimeInterval) -> Date { fetched.addingTimeInterval(s) }

private func stops(_ json: String) -> [NearbyStop] {
    struct R: Decodable { let stops: [NearbyStop] }
    return (try? JSONDecoder().decode(R.self, from: Data(json.utf8)))?.stops ?? []
}

private func stop(_ code: String, opposite: String? = nil, board: String = "[]") -> NearbyStop {
    let opp = opposite.map { #","opposite":"\#($0)""# } ?? ""
    return stops(#"{"stops":[{"stop":{"code":"\#(code)","name":"\#(code)"},"walkS":60\#(opp),"board":\#(board)}]}"#)[0]
}

private let utown = stop(
    "UTOWN",
    board: """
        [{"svc":"D2","etaS":370,"quality":"live","color":"#8e44c9","towards":["University Health Centre","COM 3"],"crowd":"medium",
          "later":[{"etaS":960,"quality":"live"}]},
         {"svc":"D1","etaS":190,"quality":"live","color":"#ec4fa0","towards":["Yusof Ishak House","COM 3"],"crowd":"low",
          "later":[{"etaS":660,"quality":"scheduled"},{"etaS":1140,"quality":"live"}]},
         {"svc":"R1","etaS":540,"quality":"scheduled","towards":["Yusof Ishak House","Prince George's Park"]},
         {"svc":"E","etaS":null,"quality":"ended"}]
        """)

@Test func nearbySoonestFirstWithTheirClockTimes() {
    let buses = NearbyBoard.buses(utown, fetchedAt: fetched, now: fetched)
    #expect(buses.map(\.svc) == ["D1", "D2", "R1"])
    #expect(buses[0].at == at(190))
    #expect(buses[0].later == [at(660), at(1140)])
    #expect(buses[0].next == "Yusof Ishak House")
    #expect(buses[0].end == "COM 3")
    #expect(buses[0].color == "#ec4fa0")
}

@Test func nearbyBusStaysAMinuteAfterItsDueThenTheNextTakesItsPlace() throws {
    let due = at(190)
    #expect(NearbyBoard.buses(utown, fetchedAt: fetched, now: due.addingTimeInterval(59)).first { $0.svc == "D1" }?.at == due)
    let d1 = try #require(NearbyBoard.buses(utown, fetchedAt: fetched, now: due.addingTimeInterval(61)).first { $0.svc == "D1" })
    #expect(d1.at == at(660))
    #expect(d1.later == [at(1140)])
    // The next bus has its own Live, and no crowding: the server's is for the first.
    #expect(!d1.live)
    #expect(d1.crowd == nil)
}

@Test func nearbyServiceWithEveryBusGoneIsDropped() {
    #expect(NearbyBoard.buses(utown, fetchedAt: fetched, now: at(600)).map(\.svc) == ["D1", "D2"])
}

@Test func nearbyEndIsNamedOnlyWhenTwoBusesShownStopNextAtTheSamePlace() throws {
    let buses = NearbyBoard.buses(utown, fetchedAt: fetched, now: fetched)
    let d1 = try #require(buses.first { $0.svc == "D1" })
    let r1 = try #require(buses.first { $0.svc == "R1" })
    let d2 = try #require(buses.first { $0.svc == "D2" })
    // D1 and R1 both stop next at Yusof Ishak House: each says where it goes.
    #expect(NearbyBoard.endIfNeeded(d1, shown: buses) == "COM 3")
    #expect(NearbyBoard.endIfNeeded(r1, shown: buses) == "Prince George's Park")
    #expect(NearbyBoard.endIfNeeded(d2, shown: buses) == nil)
    // With R1 off screen, the next stop alone tells D1 apart.
    #expect(NearbyBoard.endIfNeeded(d1, shown: [d1, d2]) == nil)
}

@Test func nearbySameNextStopAndEndNeedsNoEnd() {
    let a = StopBus(
        svc: "A1", color: nil, paid: false, at: fetched, live: true, crowd: nil, next: "LT27", end: "Kent Ridge Bus Terminal",
        endsHere: false, later: [])
    let k = StopBus(
        svc: "K", color: nil, paid: false, at: fetched, live: true, crowd: nil, next: "LT27", end: "Kent Ridge Bus Terminal",
        endsHere: false, later: [])
    #expect(NearbyBoard.endIfNeeded(a, shown: [a, k]) == nil)
}

@Test func nearbyRedrawnWhenItsBusGoes() {
    let buses = NearbyBoard.buses(utown, fetchedAt: fetched, now: fetched)
    // D1 at 190 s, gone a minute after; then D2 at 370 s.
    #expect(NearbyBoard.redrawAt(buses, now: fetched) == at(190 + NearbyBoard.gone))
    #expect(NearbyBoard.redrawAt(buses, now: at(250)) == at(370 + NearbyBoard.gone))
    #expect(NearbyBoard.redrawAt([], now: fetched) == nil)
}

@Test func nearbyRedrawnAsEachMinuteGoesUntilTheTimesAreOld() {
    let buses = NearbyBoard.buses(utown, fetchedAt: fetched, now: fetched)
    let old = at(180)
    // D1 at 190 s and D2 at 370 s each go down a minute 10 s in and each minute after, R1 at 540 s on the minute.
    var moments: [Date] = []
    var t = fetched
    while moments.count < 6, let next = NearbyBoard.redrawAt(buses, now: t, minutesUntil: old) {
        moments.append(next)
        t = next
    }
    #expect(moments == [10, 60, 70, 120, 130, 250].map { at(TimeInterval($0)) })
    // The last of them is D1 going: after the times are old, nothing counts.
}

@Test func nearbyTimelineWorksTheBusesOutAgainAtEachMoment() {
    // From D1 going (250 s), its next bus at 660 s shows: it goes at 720 s, not before.
    let moments = NearbyBoard.redraws([utown], fetchedAt: fetched, now: at(200), until: at(800), minutesUntil: nil)
    #expect(moments == [250, 430, 600, 720].map { at(TimeInterval($0)) })
    #expect(NearbyBoard.redraws([utown], fetchedAt: fetched, now: fetched, until: at(3600), minutesUntil: nil, max: 2).count == 2)
}

@Test func nearbyMinutesRoundDownAndStopFarOff() {
    let due = at(3600)
    func left(_ before: TimeInterval) -> Int? { NearbyBoard.minutesLeft(due, now: due.addingTimeInterval(-before)) }
    #expect(left(6 * 60 + 59) == 6)
    #expect(left(6 * 60) == 6)
    #expect(left(6 * 60 - 0.001) == 5)
    // Its last minute is "now", and stays so while it may still be at the stop.
    #expect(left(59.999) == 0)
    #expect(left(-10) == 0)
    #expect(left(NearbyBoard.minutesUnder - 0.001) == 14)
    #expect(left(NearbyBoard.minutesUnder) == nil)
}

@Test func nearbyMinutesAreWorded() {
    #expect(NearbyBoard.minutesText(0, live: true) == L("now"))
    #expect(NearbyBoard.minutesText(0, live: false) == L("~%@ min", "1"))
    #expect(NearbyBoard.minutesText(6, live: true) == L("%@ min", "6"))
    #expect(NearbyBoard.minutesText(6, live: false) == L("~%@ min", "6"))
}

private func isoAt(_ s: TimeInterval) -> String { ISO8601DateFormatter().string(from: at(s)) }

private let night = stop(
    "PGPF",
    board: """
        [{"svc":"A2","etaS":null,"quality":"","towards":["TCOMS","Kent Ridge Bus Terminal"],"running":false,"stopped":"notYet",
          "resumesAt":"\(isoAt(20_000))"},
         {"svc":"K","etaS":null,"quality":"","towards":[],"running":false,"stopped":"notYet","resumesAt":"\(isoAt(19_000))"},
         {"svc":"E","etaS":null,"quality":"","running":false,"stopped":"noService"}]
        """)

@Test func nearbyWithNothingRunningEachServicesFirstBusSoonestFirst() {
    let buses = NearbyBoard.buses(night, fetchedAt: fetched, now: fetched, skew: 2)
    #expect(buses.map(\.svc) == ["K", "A2"])
    #expect(buses.allSatisfy { $0.first && !$0.live })
    // On the phone's clock: the server's time less how far ahead the server is.
    #expect(buses[0].at == at(19_000 - 2))
    #expect(buses[0].endsHere)
    #expect(buses[1].next == "TCOMS")
    // A timetable's first bus counts no minutes.
    #expect(NearbyBoard.redrawAt(buses, now: fetched, minutesUntil: at(30_000)) == at(19_000 - 2 + NearbyBoard.gone))
}

@Test func nearbyRunningBusHidesTheFirstBuses() {
    let mixed = stop(
        "PGPF",
        board: """
            [{"svc":"D2","etaS":300,"quality":"live","towards":["TCOMS","COM 3"]},
             {"svc":"K","etaS":null,"quality":"","running":false,"stopped":"notYet","resumesAt":"\(isoAt(19_000))"}]
            """)
    #expect(NearbyBoard.buses(mixed, fetchedAt: fetched, now: fetched).map(\.svc) == ["D2"])
}

@Test func nearbyFirstBusPastIsntShown() {
    #expect(NearbyBoard.buses(night, fetchedAt: fetched, now: at(19_500)).map(\.svc) == ["A2"])
}

@Test func nearbyFirstBusSaysWhichDay() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    // Wednesday 22:00 on campus.
    let wed = cal.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 22))!
    #expect(NearbyBoard.firstLabel(wed.addingTimeInterval(1800), now: wed) == L("First bus"))
    #expect(NearbyBoard.firstLabel(wed.addingTimeInterval(9 * 3600), now: wed) == L("First bus tomorrow"))
    let f = DateFormatter()
    f.locale = Lang.locale
    f.timeZone = .campus
    f.setLocalizedDateFormatFromTemplate("EEEE")
    let fri = wed.addingTimeInterval(86400 + 9 * 3600)
    #expect(NearbyBoard.firstLabel(fri, now: wed) == L("First bus %@", f.string(from: fri)))
}

@Test func nearbyBesideIsTheOppositeStopAcrossTheRoad() {
    let bus = #"[{"svc":"A1","etaS":120,"quality":"live"}]"#
    let list = [stop("YIH", opposite: "YIH-OPP"), stop("CLB", board: bus), stop("YIH-OPP")]
    // The opposite stop, even with no bus, over a nearer stop that has one.
    #expect(NearbyBoard.beside(list) { NearbyBoard.buses($0, fetchedAt: fetched, now: fetched) }?.stop.code == "YIH-OPP")
}

@Test func nearbyWithNoOppositeStopBesideIsTheNextStopWithABus() {
    let bus = #"[{"svc":"D2","etaS":120,"quality":"live"}]"#
    let list = [stop("COM3"), stop("TCOMS"), stop("BIZ2", board: bus)]
    #expect(NearbyBoard.beside(list) { NearbyBoard.buses($0, fetchedAt: fetched, now: fetched) }?.stop.code == "BIZ2")
    #expect(NearbyBoard.beside(Array(list.prefix(2))) { NearbyBoard.buses($0, fetchedAt: fetched, now: fetched) } == nil)
}

@Test func nearbyBusKeepsThePlacesItPassesAndTheStopItsHeading() {
    let list = stops(
        #"{"stops":[{"stop":{"code":"YIH-OPP","name":"YIH"},"walkS":60,"viaText":"to Science, Kent Ridge MRT","board":[{"svc":"A2","etaS":120,"quality":"live","via":["Science","Kent Ridge MRT"," ","PGP"]}]},{"stop":{"code":"LT27","name":"LT 27"},"walkS":90,"board":[{"svc":"D2","etaS":60,"quality":"live"}]}]}"#
    )
    #expect(list[0].viaText == "to Science, Kent Ridge MRT")
    #expect(NearbyBoard.buses(list[0], fetchedAt: fetched, now: fetched).first?.via == ["Science", "Kent Ridge MRT", "PGP"])
    // From an older server: none.
    #expect(list[1].viaText == nil)
    #expect(list[1].board[0].via.isEmpty)
}

@Test func shortClockHasNoAmOrPm() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    let d = cal.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 21, minute: 5))!
    #expect(shortCampusTime(d) == (Clock.hour12 ? "9:05" : "21:05"))
}

// MARK: which layout fits

@Test func nearbyFitOneRowTall() {
    #expect(NearbyFit.of(width: 186, height: 100, sky: 72).kind == .mini)
    #expect(NearbyFit.of(width: 387, height: 100, sky: 72) == NearbyFit(kind: .bar, cols: 2))
}

@Test func nearbyFitNarrowIsRows() {
    #expect(NearbyFit.of(width: 186, height: 212, sky: 72) == NearbyFit(kind: .rows, rows: 3))
    // The iPhone's small widget: two rows.
    #expect(NearbyFit.of(width: 170, height: 170, sky: 72) == NearbyFit(kind: .rows, rows: 2))
}

@Test func nearbyFitMediumIsTwoTiles() {
    #expect(NearbyFit.of(width: 364, height: 170, sky: 72) == NearbyFit(kind: .tiles, cols: 2, rows: 1))
    // Too short for a tile (a smaller iPhone's medium): rows.
    #expect(NearbyFit.of(width: 338, height: 158, sky: 72).kind == .rows)
}

@Test func nearbyFitTallerTakesMoreRowsWithTheRestUnderThem() {
    #expect(NearbyFit.of(width: 387, height: 324, sky: 72) == NearbyFit(kind: .tiles, cols: 3, rows: 2, footer: true))
    #expect(NearbyFit.of(width: 387, height: 436, sky: 72) == NearbyFit(kind: .tiles, cols: 3, rows: 3, footer: true))
    #expect(NearbyFit.of(width: 364, height: 382, sky: 72) == NearbyFit(kind: .tiles, cols: 2, rows: 3))
}

@Test func nearbyFitBothSides() {
    let sky = NearbyFit.sidesSky
    #expect(NearbyFit.sides(width: 387, height: 212, sky: sky, newcomer: false) == NearbyFit(kind: .sides, cols: 2, rows: 4))
    // New to NUS: a line more for each bus and each side, so a bus fewer.
    #expect(NearbyFit.sides(width: 387, height: 212, sky: sky, newcomer: true) == NearbyFit(kind: .sides, cols: 2, rows: 3))
    // The iPhone's medium widget.
    #expect(NearbyFit.sides(width: 364, height: 170, sky: sky, newcomer: false)?.rows == 3)
    #expect(NearbyFit.sides(width: 364, height: 170, sky: sky, newcomer: true)?.rows == 2)
}

@Test func nearbyFitBothSidesNeedTheWidthAndTwoRows() {
    let sky = NearbyFit.sidesSky
    #expect(NearbyFit.sides(width: 286, height: 212, sky: sky, newcomer: false) == nil)
    #expect(NearbyFit.sides(width: 387, height: 100, sky: sky, newcomer: false) == nil)
    #expect(NearbyFit.sides(width: 387, height: 130, sky: sky, newcomer: true) == nil)
    // Taller: more rows a side, up to eight (the iPhone's large widget fits ten).
    #expect(NearbyFit.sides(width: 387, height: 312, sky: sky, newcomer: false)?.rows == 7)
    #expect(NearbyFit.sides(width: 364, height: 382, sky: sky, newcomer: false)?.rows == 8)
}

// MARK: Nearby's board in the app (NearbyCells)

private func nearbyList() throws -> [NearbyStop] {
    struct R: Decodable { let stops: [NearbyStop] }
    return try JSONDecoder().decode(R.self, from: Data(contentsOf: fixtures.appendingPathComponent("answers/nearby-list.json"))).stops
}

private func row(_ json: String) -> BoardRow { stop("X", board: "[\(json)]").board[0] }

private func clock12(_ d: Date) -> String { clockText(d, in: .campus, hour12: true, zh: false) }
private func clockZh(_ d: Date) -> String { clockText(d, in: .campus, hour12: true, zh: true) }
private func clock24(_ d: Date) -> String { clockText(d, in: .campus, hour12: false, zh: true) }

/// At 11:55 AM on campus: one struck at 11:57, then 12:09 PM, then a guess at 12:21 PM.
private let noon = row(
    #"{"svc":"D1","etaS":120,"quality":"live","eta":"2 min","at":"2026-11-04T03:57:00Z","tooSoon":true,"dest":"via UTown","destPlace":"UTown","later":[{"etaS":840,"quality":"live","eta":"14 min","at":"2026-11-04T04:09:00Z"},{"etaS":1560,"quality":"scheduled","eta":"~26 min","at":"2026-11-04T04:21:00Z"}]}"#
)

@Test func nearbyRowsCarryWhereTheyreGoing() throws {
    let pgp = try #require(try nearbyList().first { $0.stop.code == "PGP" })
    let d2 = try #require(pgp.board.first { $0.svc == "D2" })
    #expect(d2.dest == "via Kent Ridge MRT")
    #expect(d2.destPlace == "Kent Ridge MRT")
    #expect(NearbyCells.dest(d2) == ("via ", "Kent Ridge MRT", ""))
    // "Ends here": no place to set apart, the whole of it muted.
    let r1 = try #require(pgp.board.first { $0.svc == "R1" })
    #expect(r1.destPlace == nil)
    #expect(NearbyCells.dest(r1) == ("Ends here", nil, ""))
    // An older server: the end of its line, else its own words.
    let old = row(#"{"svc":"A1","etaS":60,"quality":"live","towards":["LT27","Kent Ridge Bus Terminal"]}"#)
    #expect(old.dest == nil)
    #expect(NearbyCells.dest(old) == (L("to %@", "Kent Ridge Bus Terminal"), nil, ""))
    #expect(NearbyCells.dest(row(#"{"svc":"K","etaS":60,"quality":"live","toText":"to PGP"}"#)) == ("to PGP", nil, ""))
}

@Test func nearbyDestinationNeedsItsNarrowestTwoLines() {
    func dest(_ d: String, _ p: String?) -> BoardRow {
        row(#"{"svc":"A1","etaS":60,"quality":"live","dest":"\#(d)","destPlace":\#(p.map { "\"\($0)\"" } ?? "null")}"#)
    }
    // Broken at any space, a place's no-break ones too: keeping the place whole is never a reason to stack.
    #expect(NearbyCells.lines(dest("to KR\u{00A0}Bus\u{00A0}Ter", "KR\u{00A0}Bus\u{00A0}Ter")) == ["to KR", "Bus Ter"])
    #expect(NearbyCells.lines(dest("via Kent Ridge MRT", "Kent Ridge MRT")) == ["via Kent", "Ridge MRT"])
    #expect(NearbyCells.lines(dest("Ends here", nil)) == ["Ends", "here"])
    #expect(NearbyCells.lines(dest("UTown", "UTown")) == ["UTown"])
    // Kept whole when there's room: the place alone on its line.
    #expect(NearbyCells.wholeLines(dest("via Kent Ridge MRT", "Kent Ridge MRT")) == ["via", "Kent Ridge MRT"])
    #expect(NearbyCells.wholeLines(dest("UTown", "UTown")) == ["UTown"])
    #expect(NearbyCells.wholeLines(dest("Ends here", nil)) == ["Ends", "here"])
}

@Test func nearbyMinutesTheUnitOnlyInNextAndTheFirstYouCanCatchPicked() throws {
    let pgp = try #require(try nearbyList().first { $0.stop.code == "PGP" })
    let d2 = try #require(pgp.board.first { $0.svc == "D2" })
    let c = NearbyCells.cells(d2, asClock: false)
    // Next is too soon: struck, one run of text with its unit.
    #expect(c[0] == NearbyCell(figure: "4", trail: " min", struck: true, spoken: c[0].spoken))
    #expect(c[0].text == "4 min")
    #expect(c[0].spoken.hasSuffix(L(", too soon to catch")))
    // Then is the one to catch, bare; After a guess, marked.
    #expect(c[1] == NearbyCell(figure: "14", pick: true, spoken: c[1].spoken))
    #expect(c[2] == NearbyCell(mark: "~", figure: "26", spoken: c[2].spoken))
    // Nothing struck: Next is the pick.
    let r2 = try #require(pgp.board.first { $0.svc == "R2" })
    #expect(NearbyCells.cells(r2, asClock: false).map(\.pick) == [true, false, false])
}

@Test func nearbyNoBusIsADashAndNeverThePick() throws {
    let k = try #require(try nearbyList().first { $0.stop.code == "PGP" }?.board.first { $0.svc == "K" })
    let c = NearbyCells.cells(k, asClock: true)
    #expect(c.map(\.text) == ["–", "–", "–"])
    #expect(!c.contains { $0.pick || $0.hasBus })
    // A struck Next and no other bus: nothing to pick.
    let one = row(#"{"svc":"A1","etaS":60,"quality":"live","eta":"1 min","tooSoon":true}"#)
    #expect(NearbyCells.cells(one, asClock: false).map(\.pick) == [false, false, false])
    #expect(NearbyCells.cells(one, asClock: false).map(\.text) == ["1 min", "–", "–"])
}

@Test func nearbyServersWordsGiveTheNumberAndUnitWithAGuessMarkedTheSameInChinese() {
    let zh = row(#"{"svc":"D1","etaS":360,"quality":"scheduled","eta":"约 6 分钟"}"#)
    #expect(
        NearbyCells.cells(zh, asClock: false)[0]
            == NearbyCell(mark: "~", figure: "6", trail: " 分钟", pick: true, spoken: NearbyCells.cells(zh, asClock: false)[0].spoken))
    // No figures from a bus seen: said as it is, no mark.
    let now = row(#"{"svc":"D1","etaS":20,"quality":"live","eta":"now"}"#)
    #expect(NearbyCells.cells(now, asClock: false)[0].text == "now")
}

@Test func nearbyClockAmOrPmOnNextAndWhereTheHalfChanges() {
    let c = NearbyCells.cells(noon, asClock: true, clock: clock12)
    #expect(c.map(\.figure) == ["11:57", "12:09", "12:21"])
    #expect(c.map(\.trail) == ["\u{00A0}AM", "\u{00A0}PM", ""])
    #expect(c.map(\.lead) == ["", "", ""])
    #expect(c.map(\.mark) == ["", "", "~"])
    #expect(c.map(\.pick) == [false, true, false])
    // Struck, it's one run with its AM.
    #expect(c[0].text == "11:57\u{00A0}AM")
    // Read out whole, every time with its half.
    #expect(c[2].spoken == Spoken.spell("~12:21\u{00A0}PM"))
}

@Test func nearbyClockInChineseHasTheHalfBefore() {
    let c = NearbyCells.cells(noon, asClock: true, clock: clockZh)
    #expect(c.map(\.lead) == ["上午\u{00A0}", "下午\u{00A0}", ""])
    #expect(c.map(\.trail) == ["", "", ""])
    #expect(c[0].text == "上午\u{00A0}11:57")
    #expect(NearbyCells.clockParts("下午\u{00A0}6:02") == ("6:02", "下午", true))
    #expect(NearbyCells.clockParts("6:02\u{00A0}PM") == ("6:02", "PM", false))
}

@Test func nearbyClock24HourHasNoHalf() {
    let c = NearbyCells.cells(noon, asClock: true, clock: clock24)
    #expect(c.map(\.text) == ["11:57", "12:09", "~12:21"])
}

@Test func nearbyClockWithoutTheServersTimeShowsMinutes() {
    let old = row(#"{"svc":"D1","etaS":190,"quality":"live","later":[{"etaS":660,"quality":"scheduled"}]}"#)
    #expect(NearbyCells.cells(old, asClock: true, clock: clock12).map(\.text) == NearbyCells.cells(old, asClock: false).map(\.text))
}

@Test func nearbyStruckRowIsReadWithTheOneToCatch() {
    let c = NearbyCells.cells(noon, asClock: false)
    let said = NearbyCells.spoken(noon, cells: c)
    print("A struck row is read: \(said)")
    let next = Spoken.eta(120, quality: "live")! + L(", too soon to catch")
    // Live or estimated only for the first bus; "about" marks a later guess.
    let then = L("next you can catch, %@", Spoken.eta(840, quality: "live", withQuality: false)!)
    let after = L("then %@", Spoken.eta(1560, quality: "scheduled", withQuality: false)!)
    #expect(said == [L("Bus %@", "D1"), "via UTown", next, then, after].joined(separator: Lang.zh ? "，" : ", "))
    // As Android reads it.
    if !Lang.zh {
        #expect(said == "Bus D1, via UTown, 2 minutes, live, too soon to catch, next you can catch, 14 minutes, then about 26 minutes")
    }
}

@Test func nearbyFootExplainsOnlyWhatsShowing() {
    let tap = L("Tap a service to see its whole line.")
    let struck = L("Crossed out: you can't walk there in time.")
    let guess = L("~ is a guess from the timetable, not a live time.")
    #expect(NearbyCells.foot([NearbyCells.cells(noon, asClock: false)]) == [struck, guess, tap])
    let plain = row(#"{"svc":"A1","etaS":300,"quality":"live","eta":"5 min","later":[{"etaS":1020,"quality":"live","eta":"17 min"}]}"#)
    #expect(NearbyCells.foot([NearbyCells.cells(plain, asClock: false)]) == [tap])
    #expect(NearbyCells.foot([]) == [tap])
}

/// What gives way when the rows are short of room, in order: the gaps, then
/// the times to 0.85 at most, then every row on two lines with its times at
/// full size, or none: the columns read straight down the page.
@Test func nearbyColumnsGiveWayInOrderForEveryRowAtOnce() {
    let t: [CGFloat] = [60, 50, 40]
    let h: [CGFloat] = [30, 30, 30]
    func at(_ room: CGFloat) -> NearbyCells.Layout { NearbyCells.layout(times: t, heads: h, need: 50, room: room, line: room + 60) }
    #expect(at(228) == .init(between: 14, zoom: 1, widths: t, stacked: false))
    #expect(at(216) == .init(between: 8, zoom: 1, widths: t, stacked: false))
    #expect(at(200) == .init(between: 8, zoom: 0.88, widths: [53, 44, 36], stacked: false))
    // Under 0.85 it would need: every row stacks, its times at full size, 14 pt apart on their own line.
    #expect(at(190) == .init(between: 14, zoom: 1, widths: t, stacked: true))
    #expect(NearbyCells.layout(times: t, heads: h, need: 50, room: 100, line: 170).between == 8)
    // A heading is never shrunk: its column is at least as wide.
    #expect(NearbyCells.layout(times: [20, 20, 20], heads: h, need: 10, room: 300, line: 360).widths == [30, 30, 30])
    // A place kept whole is asked for first, but never stacks the rows: then the place breaks.
    func keeping(_ whole: CGFloat, _ room: CGFloat) -> NearbyCells.Layout {
        NearbyCells.layout(times: t, heads: h, whole: whole, need: 50, room: room, line: room + 60)
    }
    #expect(keeping(80, 258) == .init(between: 14, zoom: 1, widths: t, stacked: false))
    #expect(keeping(80, 230) == .init(between: 8, zoom: 0.88, widths: [53, 44, 36], stacked: false))
    #expect(keeping(80, 216) == at(216))
    #expect(keeping(80, 190) == at(190))
}

/// An estimate is never "now" or "Arriving", which would pass for a bus at the stop: "~1 min".
@Test func nearbyEstimateUnderAMinuteIsAboutAMinute() {
    #expect(BusTimes.words(20, quality: "scheduled") == L("~%@ min", "1"))
    #expect(BusTimes.words(20, quality: "stale") == L("~%@ min", "1"))
    #expect(BusTimes.words(20, quality: "live") == L("Arriving"))
    #expect(NearbyBoard.minutesText(0, live: false) == L("~%@ min", "1"))
    #expect(Spoken.eta(20, quality: "scheduled") == L("about %@, estimated", L("1 minute")))
    #expect(Spoken.eta(20, quality: "live") == L("Arriving"))
    // In the grid: the mark and the figure, as any other guess.
    let soon = row(#"{"svc":"D1","etaS":20,"quality":"scheduled"}"#)
    #expect(
        NearbyCells.cells(soon, asClock: false)[0]
            == NearbyCell(
                mark: "~", figure: "1", trail: L("~%@ min", "1").replacingOccurrences(of: "~1", with: ""), pick: true,
                spoken: L("about %@, estimated", L("1 minute"))))
    // Aged past its reading, a live time under a minute is stale: "~1 min" too.
    let live = row(#"{"svc":"D1","etaS":90,"quality":"live","eta":"2 min"}"#)
    let aged = BusTimes.aged(live, got: fetched, now: at(60))
    #expect(aged.etaText == L("~%@ min", "1"))
}

@Test func nearbyClockSaysHowLongThereIsForTheOneToCatch() {
    let c = NearbyCells.cells(noon, asClock: true, clock: clock12)
    #expect(c[1].spoken == L("%@, in %@", Spoken.spell("12:09\u{00A0}PM"), Spoken.eta(840, quality: "live", withQuality: false)!))
    #expect(!c[2].spoken.contains("minute"))
    // An estimate to catch: "in about 13 minutes".
    let guess = row(#"{"svc":"D1","etaS":780,"quality":"scheduled","at":"2026-11-04T04:08:00Z"}"#)
    let g = NearbyCells.cells(guess, asClock: true, clock: clock12)[0]
    #expect(g.spoken == L("%@, in %@", Spoken.spell("~12:08\u{00A0}PM"), L("about %@", L("%@ minutes", "13"))))
    print("An estimated pick in clock time is read: \(g.spoken)")
    // A bus seen at the stop to catch: "in under a minute", never "in Arriving"; a guess as close, "in about 1 minute".
    let here = row(#"{"svc":"D1","etaS":20,"quality":"live","eta":"Arriving","at":"2026-11-04T04:08:00Z"}"#)
    #expect(
        NearbyCells.cells(here, asClock: true, clock: clock12)[0].spoken
            == L("%@, in %@", Spoken.spell("12:08\u{00A0}PM"), L("under a minute")))
    let near = row(#"{"svc":"D1","etaS":20,"quality":"scheduled","at":"2026-11-04T04:08:00Z"}"#)
    #expect(
        NearbyCells.cells(near, asClock: true, clock: clock12)[0].spoken
            == L("%@, in %@", Spoken.spell("~12:08\u{00A0}PM"), L("about %@", L("1 minute"))))
}

/// An older server's "now" for a guess is worded here: "~1 min", never "now".
@Test func nearbyAnOlderServersNowForAGuessIsAboutAMinute() {
    for quality in ["scheduled", "stale"] {
        let old = row(
            #"{"svc":"D1","etaS":20,"quality":"\#(quality)","eta":"now","later":[{"etaS":40,"quality":"\#(quality)","eta":"now"}]}"#)
        let c = NearbyCells.cells(old, asClock: false)
        #expect(c[0].text == L("~%@ min", "1"))
        #expect(c[0].mark == "~" && c[0].figure == "1")
        #expect(c[1].mark == "~" && c[1].figure == "1")
    }
}

/// The road line says "arriving at" only for a bus seen; a guess is "about 1 min" to the end.
@Test func theRoadLineSaysArrivingOnlyForALiveBus() {
    #expect(RoadLine.words(stop: "COM3", left: 20, live: true) == L("arriving at %@", "COM3"))
    #expect(RoadLine.words(stop: "COM3", left: 20, live: false) == L("reaches %@ in about %@ min", "COM3", "1"))
    #expect(RoadLine.words(stop: "COM3", left: 300, live: true) == L("reaches %@ in %@ min", "COM3", "5"))
    #expect(RoadLine.words(stop: "COM3", left: 300, live: false) == L("reaches %@ in about %@ min", "COM3", "5"))
    #expect(RoadLine.words(stop: "COM3", left: 0, live: false) == L("from %@", "COM3"))
}
