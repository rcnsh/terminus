import Foundation
import Testing

@testable import Terminus

/// What the widgets and the Live Activity decide by themselves: how often a
/// widget asks to be reloaded, the countdown's range, when an activity no
/// push can reach is over, and the Live Activity's updates one at a time.

private func state(phase: String = "riding", leaveAt: Date? = nil, departAt: Date? = nil, arriveAt: Date? = nil)
    -> TripAttributes.ContentState
{
    func s(_ d: Date?) -> Int? { d.map { Int($0.timeIntervalSince1970) } }
    return .init(
        phase: phase, phaseText: nil, headline: "On the R2", line: "", glance: "", to: nil, svc: "R2", color: nil, stop: nil, off: nil,
        leaveAt: s(leaveAt), departAt: s(departAt), arriveAt: s(arriveAt), estimated: false, gone: false, late: false, staleAt: nil)
}

private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

// MARK: the widgets' reloads

@Test func widgetReloadsNoSoonerThanFiveMinutes() {
    #expect(WidgetTiming.reloadAt(t0.addingTimeInterval(60), now: t0) == t0.addingTimeInterval(WidgetTiming.minReload))
    #expect(WidgetTiming.reloadAt(t0, now: t0) == t0.addingTimeInterval(5 * 60))
    // A later moment is kept as it is.
    let later = t0.addingTimeInterval(20 * 60)
    #expect(WidgetTiming.reloadAt(later, now: t0) == later)
}

// MARK: the Live Activity's countdown

@Test func countdownRangeNeverRunsBackwards() throws {
    let s = state(departAt: t0, arriveAt: t0.addingTimeInterval(600))
    let c = try #require(s.countdown(phoneNow: t0.addingTimeInterval(100), skew: 0))
    #expect(c.kind == "off")
    #expect(c.range.lowerBound == t0.addingTimeInterval(100))
    #expect(c.range.upperBound == t0.addingTimeInterval(600))
    // Over by the server's clock: nothing to count.
    #expect(s.countdown(phoneNow: t0.addingTimeInterval(601), skew: 0) == nil)
}

@Test func countdownFollowsTheServersClock() throws {
    let s = state(departAt: t0, arriveAt: t0.addingTimeInterval(600))
    // The phone is a minute slow: the server's 10:00 is the phone's 09:59.
    let c = try #require(s.countdown(phoneNow: t0.addingTimeInterval(100), skew: 60))
    #expect(c.range.upperBound == t0.addingTimeInterval(540))
    // By the phone's clock it would still count; by the server's it's over.
    #expect(s.countdown(phoneNow: t0.addingTimeInterval(570), skew: 60) == nil)
}

// MARK: activities no push can end

@MainActor @Test func unpushedActivityEndsAfterArrivingAndTheLinger() {
    let arrive = t0.addingTimeInterval(600)
    let s = state(departAt: t0, arriveAt: arrive)
    #expect(s.overAt(linger: LiveTrip.lingerS) == arrive.addingTimeInterval(LiveTrip.lingerS))
    #expect(!LiveTrip.isOver(s, now: arrive))
    #expect(!LiveTrip.isOver(s, now: arrive.addingTimeInterval(LiveTrip.lingerS - 1)))
    #expect(LiveTrip.isOver(s, now: arrive.addingTimeInterval(LiveTrip.lingerS)))
}

@MainActor @Test func unpushedActivityWithoutArrivalEndsAnHourAfterTheBus() {
    let s = state(phase: "heading", leaveAt: t0, departAt: t0.addingTimeInterval(300))
    #expect(s.overAt(linger: LiveTrip.lingerS) == t0.addingTimeInterval(300 + TripAttributes.ContentState.unheardS))
    #expect(!LiveTrip.isOver(s, now: t0.addingTimeInterval(1800)))
    #expect(LiveTrip.isOver(s, now: t0.addingTimeInterval(300 + 3600)))
    #expect(state(phase: "due").overAt(linger: 0) == nil)
    #expect(!LiveTrip.isOver(state(phase: "due"), now: .distantFuture))
}

// MARK: one step at a time

@MainActor private final class StepLog {
    var lines: [String] = []
    var running = 0
}

@MainActor @Test func liveTripStepsRunOneAtATimeInOrder() async {
    let log = StepLog()
    func step(_ name: String) -> @MainActor () async -> Void {
        {
            log.running += 1
            #expect(log.running == 1)
            log.lines.append(name + ">")
            // Suspends, as ActivityKit's calls do: the next step mustn't start here.
            try? await Task.sleep(nanoseconds: 20_000_000)
            log.lines.append("<" + name)
            log.running -= 1
        }
    }
    async let a: Void = LiveTrip.serially(step("a"))
    async let b: Void = LiveTrip.serially(step("b"))
    async let c: Void = LiveTrip.serially(step("c"))
    _ = await (a, b, c)
    #expect(log.lines.count == 6)
    // Each step finished before the next began, whatever order they were queued in.
    for i in stride(from: 0, to: log.lines.count, by: 2) {
        #expect(log.lines[i].dropLast() == log.lines[i + 1].dropFirst())
    }
}
