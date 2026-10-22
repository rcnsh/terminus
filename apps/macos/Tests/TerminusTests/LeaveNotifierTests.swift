import Foundation
import Testing

@testable import Terminus

/// What the leave reminders do with each plan: `LeaveNotifier.step`.
private let now = Date(timeIntervalSince1970: 1_790_000_000)

private func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

private func plan(
    trip: String = "4:600:UTOWN", leaveIn: TimeInterval, phase: String = "idle", remind: Bool = true, reminder: Bool = true,
    gone: Bool = false
) throws -> NextAnswer {
    let leaveAt = now.addingTimeInterval(leaveIn)
    let remindAt = reminder ? "\"\(iso(leaveAt.addingTimeInterval(-300)))\"" : "null"
    let json = """
        {"label":"R2 · 09:42","detail":"","quality":"live","mode":"trip",
         "leave":{"at":"\(iso(leaveAt))","svc":"R2","stop":"PGP"},
         "card":{"kind":"class","phase":"\(phase)","remind":\(remind),"remindAt":\(remindAt),"gone":\(gone),
           "actions":[{"id":"skipped","label":"Not going","trip":"\(trip)"}]}}
        """
    return try JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
}

@Test func theFirstPlanSchedulesBoth() throws {
    let step = LeaveNotifier.step(try plan(leaveIn: 600), soonTrip: nil, soonAt: 0, now: now)
    #expect(
        step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
}

/// The key `update` keeps for the heads-up: the trip and the day it leaves, in campus time.
private func key(_ trip: String = "4:600:UTOWN", leaveIn: TimeInterval) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(identifier: "Asia/Singapore")!
    let d = cal.dateComponents([.year, .month, .day], from: now.addingTimeInterval(leaveIn))
    return "\(trip)@\(d.year!)-\(d.month!)-\(d.day!)"
}

@Test func theHeadsUpIsKeptByTheTripAndItsDay() throws {
    #expect(LeaveNotifier.soonKey(try plan(leaveIn: 600), now: now) == key(leaveIn: 600))
    // 1_790_000_000 is 2026-09-21 22:13 in Singapore: two hours on is the next day there.
    #expect(LeaveNotifier.soonKey(try plan(leaveIn: 7_200), now: now) == "4:600:UTOWN@2026-9-22")
}

@Test func aLaterLeaveByAfterTheHeadsUpDoesNotBringItBack() throws {
    // The heads-up went a minute ago; the buses moved and so did the leave-by.
    let gone = now.timeIntervalSince1970 - 60
    let step = LeaveNotifier.step(try plan(leaveIn: 900), soonTrip: key(leaveIn: 900), soonAt: gone, now: now)
    #expect(step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: nil, leaveAt: now.addingTimeInterval(900)))
}

@Test func aHeadsUpStillToComeMovesWithTheLeaveBy() throws {
    let ahead = now.timeIntervalSince1970 + 120
    let step = LeaveNotifier.step(try plan(leaveIn: 900), soonTrip: key(leaveIn: 900), soonAt: ahead, now: now)
    #expect(
        step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: now.addingTimeInterval(600), leaveAt: now.addingTimeInterval(900)))
}

@Test func aWeeklyClassGetsItsHeadsUpAgainNextWeek() throws {
    // The same class last week: its heads-up went then, and this week's still comes.
    let week: TimeInterval = 7 * 86_400
    let lastWeek = key(leaveIn: 600 - week)
    #expect(lastWeek != key(leaveIn: 600))
    let step = LeaveNotifier.step(try plan(leaveIn: 600), soonTrip: lastWeek, soonAt: now.timeIntervalSince1970 - week, now: now)
    #expect(
        step == .schedule(clearFirst: true, trip: "4:600:UTOWN", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
    // A key kept by the trip alone, as an older version kept it: not taken for today's.
    let before = LeaveNotifier.step(try plan(leaveIn: 600), soonTrip: "4:600:UTOWN", soonAt: now.timeIntervalSince1970 - week, now: now)
    #expect(
        before == .schedule(clearFirst: true, trip: "4:600:UTOWN", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
}

@Test func aDifferentTripClearsTheLastOnesFirst() throws {
    let gone = now.timeIntervalSince1970 - 60
    let step = LeaveNotifier.step(try plan(trip: "4:720:COM3", leaveIn: 600), soonTrip: key(leaveIn: 600), soonAt: gone, now: now)
    #expect(
        step == .schedule(clearFirst: true, trip: "4:720:COM3", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
}

@Test func phasesAndMissingRemindersEndThem() throws {
    #expect(LeaveNotifier.step(try plan(leaveIn: -60, phase: "heading"), soonTrip: nil, soonAt: 0, now: now) == .heading)
    // The bus gone and nothing known: "Leave now" goes too, as you may be on it.
    #expect(LeaveNotifier.step(try plan(leaveIn: -60, phase: "heading", gone: true), soonTrip: nil, soonAt: 0, now: now) == .over)
    for phase in ["waiting", "riding", "missed", "arrived", "skipped"] {
        #expect(LeaveNotifier.step(try plan(leaveIn: 600, phase: phase), soonTrip: nil, soonAt: 0, now: now) == .over, "\(phase)")
    }
    #expect(LeaveNotifier.step(try plan(leaveIn: 600, remind: false), soonTrip: nil, soonAt: 0, now: now) == .clear)
    #expect(LeaveNotifier.step(try plan(leaveIn: 600, reminder: false), soonTrip: nil, soonAt: 0, now: now) == .clear)
    // The leave-by has passed.
    #expect(LeaveNotifier.step(try plan(leaveIn: 0), soonTrip: nil, soonAt: 0, now: now) == .clear)
}
