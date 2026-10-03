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

@Test func crowdIsShownOnceWhenTheDetailSaysIt() throws {
    // "… · crowding: high · or D2 in 14 min": not said again under it.
    let a = try golden("place")
    #expect(a.detail.contains("crowding: high"))
    #expect(a.crowdText == nil)
}

@Test func classCardLinesComeFromTheServer() throws {
    let a = try golden("class-bus")
    #expect(a.isClassPlan)
    #expect(a.catchHow == "Catch the ~09:42 R2 at PGP")
    #expect(a.catchArrive == "Arrive ~09:51 · 9 min early")
    #expect(a.goNowLine == "Or go now: R2 at 09:06 · arrive 09:15")
    #expect(a.card?.crowd == "Crowding: medium")
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

@Test func cardV2CarriesThePhaseAndOnlyPlans() throws {
    let a = try golden("class-late")
    #expect(a.card?.phase == "heading")
    #expect(a.tripUnderWay)
    #expect(a.card?.actions?.map(\.id) == ["skipped"])
    #expect((a.card?.glance?.count ?? 99) <= 12)
}

/// An older server's question decodes without trouble and is simply not shown.
@Test func aSuggestionDecodesAndAnOldQuestionIsIgnored() throws {
    let json = """
    {"label":"On the R2","detail":"Off at UTown","mode":"trip","card":{"kind":"trip","phase":"riding",
    "ask":{"trip":"4:600:UTOWN","question":"On the 9:41 R2?","actions":[{"id":"boarded","label":"On it","trip":"4:600:UTOWN"},
    {"id":"missed","label":"Missed it","trip":"4:600:UTOWN"}]},"remind":false,
    "suggestion":{"id":"quiet:4:600:UTOWN","text":"Stop reminders?","accept":"Stop reminders","dismiss":"Keep them"}}}
    """
    let a = try JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
    #expect(a.card?.remind == false)
    #expect(a.card?.suggestion?.accept == "Stop reminders")
    let g = try golden("class-bus")
    #expect(g.card?.remind == true)
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
    #expect(!isNewer("", than: "2.1.0"))
    #expect(isNewer("2.1.0", than: ""))
}

@Test func todaySaysTheBusYoureOnOrWhenToLeave() throws {
    let json = """
    {"date":"2026-10-01","items":[
      {"kind":"class","key":"a","label":"GEA1000 @ UTown","status":"next","fromName":"PGP","toName":"UTown","startsAt":"2026-10-01T02:00:00Z","onBus":{"svc":"D2","off":"UTown","arrive":"2026-10-01T01:50:00Z"}},
      {"kind":"class","key":"b","label":"CS2030 @ COM1","status":"later","fromName":"UTown","toName":"COM 3","startsAt":"2026-10-01T05:00:00Z","leave":{"at":"2026-10-01T04:40:00Z","estimated":true,"svc":"D2","stop":"UTown"},"timing":{"status":"late","text":"~3 min late"}},
      {"kind":"class","key":"c","label":"MA1100 @ LT21","status":"skipped","toName":"LT21","startsAt":"2026-10-01T07:00:00Z"},
      {"kind":"home","key":"h","label":"Home","status":"later","fromName":"COM 3","toName":"PGP","startsAt":"2026-10-01T09:00:00Z"}
    ],"note":null}
    """
    let day = try JSONDecoder().decode(DayPlan.self, from: Data(json.utf8))
    #expect(day.items[0].sub?.hasPrefix("On the D2 · off at UTown · arrive ") == true)
    let later = try #require(day.items[1].sub)
    #expect(later.hasPrefix("Leave by ~"))
    #expect(later.hasSuffix(" · D2 from UTown · ~3 min late"))
    #expect(day.items[2].sub == "Not going")
    #expect(day.items[3].title == "Home, from COM 3")
    #expect(day.items[3].sub == nil)
}

@Test func theServersErrorsAreShownAsSentences() {
    #expect(sentence("not a valid NUSMods share link") == "Not a valid NUSMods share link.")
    #expect(sentence("Nothing imported: no stop. Your timetable was not changed.") == "Nothing imported: no stop. Your timetable was not changed.")
}
