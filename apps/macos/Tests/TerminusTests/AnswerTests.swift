import Foundation
import Testing
@testable import Terminus

/// The API's golden answers, checked by its own tests: a change in the
/// response shape fails here too.
private func golden(_ name: String) throws -> NextAnswer {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let data = try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    return try JSONDecoder().decode(NextAnswer.self, from: data)
}

@Test(arguments: ["class-bus", "class-walk", "class-late", "class-from-dorm", "class-started", "place", "landmark", "arrived", "free", "rest", "home", "home-reached", "evening-home", "setup"])
func everyGoldenAnswerDecodesWithACard(name: String) throws {
    #expect(try golden(name).card != nil)
}

@Test func classCardLinesComeFromTheServer() throws {
    let a = try golden("class-bus")
    #expect(a.isClassPlan)
    #expect(a.catchHow == "Catch the ~09:42 R2 at PGP")
    #expect(a.catchArrive == "Arrive ~09:51 · 9 min early")
    #expect(a.goNowLine == "Or go now: R2 at 09:06 · arrive 09:15")
    #expect(a.crowdText == "Filling")
    let at = try #require(a.leaveAt)
    #expect(a.leaveHeadline(now: at.addingTimeInterval(-1)) == "Leave by ~09:36")
    #expect(a.leaveHeadline(now: at) == "Leave now")
}

@Test func otherKindsAreNotClassCards() throws {
    for name in ["place", "free", "rest", "arrived", "home", "setup"] { #expect(try !golden(name).isClassPlan, "\(name)") }
    #expect(try golden("class-late").leaveLate)
}

@Test func aDayWithoutClassesIsFree() throws {
    let a = try golden("free")
    #expect(a.isFree)
    #expect(a.departure == nil)
}

@Test func cardV2CarriesThePhaseAndButtons() throws {
    let a = try golden("class-late")
    #expect(a.card?.phase == "heading")
    #expect(a.tripUnderWay)
    #expect(a.card?.actions?.map(\.id) == ["boarded", "missed", "skipped"])
    #expect((a.card?.glance?.count ?? 99) <= 12)
}

@MainActor @Test func theMenuBarShowsTheTripPhase() throws {
    let m = AppModel(snapshot: true)
    m.answers[.plan] = try golden("class-late")
    #expect(m.menuTitle(at: Date()) == m.plan?.card?.glance)
    m.answers[.plan] = try golden("free")
    #expect(m.menuTitle(at: Date()) == nil, "no bus title on a free day")
}

@MainActor @Test func staleFollowsTheServer() throws {
    let a = try golden("class-bus")
    let at = try #require(a.staleAt)
    let m = AppModel(snapshot: true)
    #expect(!m.isOld(a, at: at.addingTimeInterval(-1)))
    #expect(m.isOld(a, at: at))
}

@Test func datesParseWithOrWithoutMilliseconds() {
    #expect(parseISODate("2026-09-28T01:14:02Z") != nil)
    #expect(parseISODate("2026-09-28T01:14:02.000Z") == parseISODate("2026-09-28T01:14:02Z"))
}

@Test func versionsCompareNumerically() {
    #expect(isNewer("1.0.10", than: "1.0.9"))
    #expect(!isNewer("1.3.5", than: "1.3.5"))
    #expect(isNewer("2.0.0-beta", than: "1.3.10"))
    #expect(isNewer("2.0.0", than: "2.0.0-beta"))
    #expect(isNewer("2.0.0-beta.2", than: "2.0.0-beta"))
    #expect(!isNewer("2.0.0-beta", than: "2.0.0"))
    #expect(!isNewer("2.0.0-beta", than: "2.0.0-beta"))
}
