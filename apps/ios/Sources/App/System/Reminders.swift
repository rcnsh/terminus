import Foundation
import UserNotifications

@MainActor enum Reminders {
    private static var d: UserDefaults { Shared.defaults }
    private static var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    private static var asked = 0

    static func update(_ plan: NextAnswer, checked: Date) {
        asked += 1
        guard TripPrefs.leaveAlerts else { return clear() }
        guard Push.notificationsAllowed else {
            if Push.notificationsDenied { return clear() }
            let mine = asked
            Task {
                await Push.checkPermission()
                guard mine == asked, Push.notificationsAllowed else { return }
                update(plan, checked: checked)
            }
            return
        }
        let now = ServerClock.now
        let step = TripReminders.step(
            plan, soonTrip: d.string(forKey: "soonTrip"), soonAt: d.object(forKey: "soonAt") as? Date,
            dismissed: d.string(forKey: "dismissedTrip"), now: now)
        switch step {
        case .heading:
            center.removePendingNotificationRequests(withIdentifiers: [TripReminders.soonID])
            center.removeDeliveredNotifications(withIdentifiers: [TripReminders.soonID])
        case .over, .clear:
            clear()
        case .schedule(let clearFirst, let trip, let soon, let leaveAt):
            if clearFirst { clear() }
            setCategory(plan)
            if let soon {
                d.set(TripReminders.soonKey(plan, now: now), forKey: "soonTrip")
                d.set(max(soon, now), forKey: "soonAt")
                schedule(
                    TripReminders.soonID, at: soon, now: now, plan: plan, trip: trip, leaveNow: false, checked: checked,
                    soonKey: TripReminders.soonKey(plan, now: now))
            }
            schedule(TripReminders.nowID, at: leaveAt, now: now, plan: plan, trip: trip, leaveNow: true, checked: checked)
        }
    }

    static func clear() {
        let ids = [TripReminders.soonID, TripReminders.nowID]
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    static func dismissed(_ key: String) {
        d.set(key, forKey: "dismissedTrip")
        center.removePendingNotificationRequests(withIdentifiers: [TripReminders.nowID])
    }

    static func forget() {
        clear()
        for k in ["soonTrip", "soonAt", "dismissedTrip"] { d.removeObject(forKey: k) }
    }

    private static func setCategory(_ plan: NextAnswer) {
        registerCategories(skipLabel: plan.card?.actions.first { $0.id == "skipped" }?.label)
    }

    static func registerCategories(skipLabel: String? = nil) {
        let skip = UNNotificationAction(identifier: TripReminders.skipAction, title: skipLabel ?? L("Not going"), options: [])
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: TripReminders.category, actions: [skip], intentIdentifiers: [], options: .customDismissAction),
            UNNotificationCategory(
                identifier: TripReminders.quietCategory, actions: [], intentIdentifiers: [], options: .customDismissAction),
        ])
    }

    private static func schedule(
        _ id: String, at: Date, now: Date, plan: NextAnswer, trip: String, leaveNow: Bool, checked: Date, soonKey: String? = nil
    ) {
        let words = TripReminders.words(plan, leaveNow: leaveNow, firesAt: max(at, now), checked: checked)
        let c = UNMutableNotificationContent()
        c.title = words.title
        c.subtitle = words.subtitle
        c.body = words.body
        c.sound = .default
        c.threadIdentifier = "trip"
        c.categoryIdentifier =
            plan.card?.actions.contains { $0.id == "skipped" } == true ? TripReminders.category : TripReminders.quietCategory
        var info: [String: Any] = ["trip": plan.card?.actions.first { $0.id == "skipped" }?.trip ?? trip]
        if let soonKey { info["soonKey"] = soonKey }
        c.userInfo = info
        c.interruptionLevel = .timeSensitive
        c.relevanceScore = 1
        let wait = at.timeIntervalSince(now)
        let trigger = wait > 1 ? UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false) : nil
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: trigger))
    }
}
