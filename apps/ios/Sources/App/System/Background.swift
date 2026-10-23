import BackgroundTasks
import Foundation

/// The background refresh: iOS wakes the app now and then to fetch the plan,
/// so the widgets, the Live Activity and the reminders follow it with the
/// app closed. Asked for at the moment the answer says it changes, never
/// sooner than iOS allows (about 15 minutes) and only while something
/// outside the app shows it. iOS decides when it really runs; push brings
/// the changes that can't wait.
@MainActor enum Background {
    static let id = "sh.rcn.terminus.refresh"
    /// iOS runs them no more often than this, whatever's asked.
    nonisolated static let minGap: TimeInterval = 15 * 60

    /// At launch, before it ends (BGTaskScheduler's rule).
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: .main) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            let work = Task { @MainActor in
                let ok = await TripSync.refresh(force: false)
                schedule()
                task.setTaskCompleted(success: ok)
            }
            task.expirationHandler = { work.cancel() }
        }
    }

    /// The next refresh, when the kept answer next changes; none when signed
    /// out or when nothing outside the app shows it.
    static func schedule(now: Date = Date()) {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id)
        guard TokenStore.read() != nil, TripSync.followed else { return }
        let req = BGAppRefreshTaskRequest(identifier: id)
        req.earliestBeginDate = refreshAt(WidgetStore.plan(), now: now, skew: ServerClock.skew)
        try? BGTaskScheduler.shared.submit(req)
    }

    /// When to ask for the next refresh, on the phone's clock, for the kept
    /// answer and when it came (`plan`, the phone's clock). The answer's
    /// moments are the server's, so both ends go through `skew`.
    nonisolated static func refreshAt(_ plan: (NextAnswer, Date)?, now: Date, skew: TimeInterval) -> Date {
        let at =
            plan.map { a, fetched in
                WidgetTiming.nextRefreshAt(a, fetchedAt: fetched.addingTimeInterval(skew), now: now.addingTimeInterval(skew))
                    .addingTimeInterval(-skew)
            } ?? now
        return max(at, now.addingTimeInterval(minGap))
    }
}
