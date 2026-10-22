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
