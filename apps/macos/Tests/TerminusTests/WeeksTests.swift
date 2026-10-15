import Testing

@testable import Terminus

/// A class that runs only some weeks, as Settings lists it under the class.
@Test func theWeeksAClassRunsAreListedRunByRun() {
    #expect(weeksLabel([1, 2, 3, 4, 5, 6]) == "weeks 1–6")
    // Odd weeks: each one, not "weeks 1–11".
    #expect(weeksLabel([1, 3, 5, 7, 9, 11]) == "weeks 1, 3, 5, 7, 9, 11")
    #expect(weeksLabel([1, 2, 3, 8, 9, 10, 11, 12, 13]) == "weeks 1–3, 8–13")
    #expect(weeksLabel([7]) == "weeks 7")
    #expect(weeksLabel([5, 3, 4, 4]) == "weeks 3–5")
    // Every week, or none known: nothing to say.
    #expect(weeksLabel(Array(1...13)) == nil)
    #expect(weeksLabel([]) == nil)
    #expect(weeksLabel(nil) == nil)
}

/// White or near-black on a service's colour, by WCAG contrast, as Android's Ink.on.
@Test func inkIsWhicheverReadsBetter() {
    #expect(inkIsWhite(on: 0x000000))
    #expect(!inkIsWhite(on: 0xFFFFFF))
    // The brand in dark mode (light orange) takes dark ink; in light mode, white.
    #expect(!inkIsWhite(on: 0xFB923C))
    #expect(inkIsWhite(on: 0xC2410C))
    // #1c1917's own luminance, about 0.010, not a rounded constant.
    #expect(abs(luminance(0x1C1917) - 0.0100) < 0.0005)
}

/// A two-way public bus is two rows with one name at a stop (151/1 and
/// 151/2): each pill still has an id of its own, the same every refresh.
@Test func pillsWithTheSameServiceNameHaveIdsOfTheirOwn() {
    let rows = [
        BoardRow(svc: "D2", etaS: 60, quality: "live"),
        BoardRow(svc: "151", etaS: 120, quality: "live", paid: true),
        BoardRow(svc: "151", etaS: 300, quality: "live", paid: true),
        BoardRow(svc: "33", etaS: 200, quality: "scheduled", paid: true),
        BoardRow(svc: "33", etaS: 400, quality: "scheduled", paid: true),
    ]
    let ids = FlowPills.pillIDs(rows)
    #expect(ids == ["D2", "151 $", "151 $#1", "33 $", "33 $#1"])
    #expect(Set(ids).count == rows.count)
}
