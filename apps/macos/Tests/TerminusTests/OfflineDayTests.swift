import Foundation
import Testing
@testable import Terminus

/// The offline fallback, against the cases the web and Android apps are
/// checked against too (apps/api/test/fixtures/offline-day.json), on the
/// API's own /me/day golden.
private let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("../api/test/fixtures").standardized

private struct Spec: Decodable {
    struct Case: Decodable {
        let at: String
        let key: String?
        let step: String?
    }
    let day: String
    let cases: [Case]
}

private func load() throws -> (Spec, DayPlan) {
    let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: fixtures.appendingPathComponent("offline-day.json")))
    let day = try JSONDecoder().decode(DayPlan.self, from: Data(contentsOf: fixtures.appendingPathComponent(spec.day)))
    return (spec, day)
}

@Test func theDayPlanGivesTheNextThingAtEachMoment() throws {
    let (spec, day) = try load()
    #expect(day.date == "2026-08-27")
    for c in spec.cases {
        let now = try #require(parseISODate(c.at))
        let got = OfflineDay.next(day, now: now)
        #expect(got?.item.key == c.key, "\(c.at)")
        #expect(got?.step.rawValue == c.step, "\(c.at)")
    }
}

/// The plan's pick at an ISO time. (A #require can't hold another #require.)
private func pick(_ day: DayPlan, at iso: String) throws -> OfflineDay.Pick {
    let now = try #require(parseISODate(iso))
    return try #require(OfflineDay.next(day, now: now))
}

@Test func theMenuBarSaysWhenToLeave() throws {
    let (_, day) = try load()
    let first = try pick(day, at: "2026-08-27T01:00:00Z")
    #expect(OfflineDay.lines(first).head.hasPrefix("GEA1000 @ UTown · starts "))
    #expect(OfflineDay.lines(first).big.hasPrefix("Leave by ~"))
    #expect(OfflineDay.lines(first).how == "R2 from PGP")
    let walk = try pick(day, at: "2026-08-27T05:10:00Z")
    #expect(OfflineDay.lines(walk).how == "Walk")
    #expect(OfflineDay.menuTitle(walk)?.hasPrefix("Leave ~") == true)
    let late = try pick(day, at: "2026-08-27T01:40:00Z")
    #expect(OfflineDay.menuTitle(late) == "Leave now")
    let home = try pick(day, at: "2026-08-27T07:30:00Z")
    #expect(OfflineDay.menuTitle(home) == nil)
    #expect(OfflineDay.lines(home).big == "Home, from COM 3")
    #expect(OfflineDay.lines(home).how == nil)
}
