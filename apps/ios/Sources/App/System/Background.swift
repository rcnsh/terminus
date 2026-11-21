import BackgroundTasks
import Foundation

@MainActor enum Background {
    static let id = "sh.rcn.terminus.refresh"
    nonisolated static let minGap: TimeInterval = 15 * 60

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

    static func schedule(now: Date = Date()) {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id)
        guard TokenStore.read() != nil, TripSync.followed else { return }
        let req = BGAppRefreshTaskRequest(identifier: id)
        req.earliestBeginDate = refreshAt(WidgetStore.plan(), now: now, skew: ServerClock.skew)
        try? BGTaskScheduler.shared.submit(req)
    }

    nonisolated static func refreshAt(_ plan: (NextAnswer, Date)?, now: Date, skew: TimeInterval) -> Date {
        let at =
            plan.map { a, fetched in
                WidgetTiming.nextRefreshAt(a, fetchedAt: fetched.addingTimeInterval(skew), now: now.addingTimeInterval(skew))
                    .addingTimeInterval(-skew)
            } ?? now
        return max(at, now.addingTimeInterval(minGap))
    }
}
