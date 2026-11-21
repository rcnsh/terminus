import Testing

@testable import Terminus

@Test func theWeeksAClassRunsAreListedRunByRun() {
    #expect(weeksLabel([1, 2, 3, 4, 5, 6]) == "weeks 1–6")
    #expect(weeksLabel([1, 3, 5, 7, 9, 11]) == "weeks 1, 3, 5, 7, 9, 11")
    #expect(weeksLabel([1, 2, 3, 8, 9, 10, 11, 12, 13]) == "weeks 1–3, 8–13")
    #expect(weeksLabel([7]) == "weeks 7")
    #expect(weeksLabel([5, 3, 4, 4]) == "weeks 3–5")
    #expect(weeksLabel(Array(1...13)) == nil)
    #expect(weeksLabel([]) == nil)
    #expect(weeksLabel(nil) == nil)
}

@Test func inkIsWhicheverReadsBetter() {
    #expect(inkIsWhite(on: 0x000000))
    #expect(!inkIsWhite(on: 0xFFFFFF))
    #expect(!inkIsWhite(on: 0xFB923C))
    #expect(inkIsWhite(on: 0xC2410C))
    #expect(abs(luminance(0x1C1917) - 0.0100) < 0.0005)
}

@Test func pillsWithTheSameServiceNameHaveIdsOfTheirOwn() {
    let rows = [
        BoardRow(svc: "D2", etaS: 60, quality: "live"),
        BoardRow(svc: "151", etaS: 120, quality: "live", paid: true),
        BoardRow(svc: "151", etaS: 300, quality: "live", paid: true),
        BoardRow(svc: "33", etaS: 200, quality: "scheduled", paid: true),
        BoardRow(svc: "33", etaS: 400, quality: "scheduled", paid: true),
    ]
    let ids = NearbyBoard.pillIDs(rows)
    #expect(ids == ["D2", "151 $", "151 $#1", "33 $", "33 $#1"])
    #expect(Set(ids).count == rows.count)
}
