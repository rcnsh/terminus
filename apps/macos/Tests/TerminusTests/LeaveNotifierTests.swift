import Foundation
import Testing
@testable import Terminus

/// What the leave reminders do with each plan: `LeaveNotifier.step`.
private let now = Date(timeIntervalSince1970: 1_790_000_000)

private func iso(_ d: Date) -> String { ISO8601DateFormatter().string(from: d) }

private func plan(trip: String = "4:600:UTOWN", leaveIn: TimeInterval, phase: String = "idle", remind: Bool = true, reminder: Bool = true, gone: Bool = false) throws -> NextAnswer {
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
    #expect(step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
}

@Test func aLaterLeaveByAfterTheHeadsUpDoesNotBringItBack() throws {
    // The heads-up went a minute ago; the buses moved and so did the leave-by.
    let gone = now.timeIntervalSince1970 - 60
    let step = LeaveNotifier.step(try plan(leaveIn: 900), soonTrip: "4:600:UTOWN", soonAt: gone, now: now)
    #expect(step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: nil, leaveAt: now.addingTimeInterval(900)))
}

@Test func aHeadsUpStillToComeMovesWithTheLeaveBy() throws {
    let ahead = now.timeIntervalSince1970 + 120
    let step = LeaveNotifier.step(try plan(leaveIn: 900), soonTrip: "4:600:UTOWN", soonAt: ahead, now: now)
    #expect(step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: now.addingTimeInterval(600), leaveAt: now.addingTimeInterval(900)))
}

@Test func aDifferentTripClearsTheLastOnesFirst() throws {
    let gone = now.timeIntervalSince1970 - 60
    let step = LeaveNotifier.step(try plan(trip: "4:720:COM3", leaveIn: 600), soonTrip: "4:600:UTOWN", soonAt: gone, now: now)
    #expect(step == .schedule(clearFirst: true, trip: "4:720:COM3", soon: now.addingTimeInterval(300), leaveAt: now.addingTimeInterval(600)))
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
