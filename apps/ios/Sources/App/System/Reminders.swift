import Foundation
import UserNotifications

/// The leave reminders on this phone (TripReminders decides): local
/// notifications scheduled ahead from each answer, so they go on time with
/// the app closed. A later answer moves them; a push for the same trip
/// (worded by the notification service) takes their place.
@MainActor enum Reminders {
    private static var d: UserDefaults { Shared.defaults }
    private static var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }

    /// Bumped by each update, so one waiting on the permission can tell a later answer came meanwhile.
    private static var asked = 0

    /// Brings the scheduled reminders in line with the latest plan.
    static func update(_ plan: NextAnswer, checked: Date) {
        asked += 1
        guard TripPrefs.leaveAlerts else { return clear() }
        guard Push.notificationsAllowed else {
            // Refused: none. Merely not known yet (a launch in the background
            // can answer before Push.checkPermission has): asked, then this
            // again, rather than clearing reminders that are allowed.
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
        let step = TripReminders.step(plan, soonTrip: d.string(forKey: "soonTrip"), soonAt: d.object(forKey: "soonAt") as? Date, now: now)
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
                schedule(TripReminders.soonID, at: soon, now: now, plan: plan, trip: trip, leaveNow: false, checked: checked)
            }
            schedule(TripReminders.nowID, at: leaveAt, now: now, plan: plan, trip: trip, leaveNow: true, checked: checked)
        }
    }

    /// Every leave reminder goes, shown or still to come.
    static func clear() {
        let ids = [TripReminders.soonID, TripReminders.nowID]
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }

    /// Signed out: the reminders and what they were for.
    static func forget() {
        clear()
        d.removeObject(forKey: "soonTrip")
        d.removeObject(forKey: "soonAt")
    }

    /// The card's "Not going", with the server's own words, as the reminders' one button.
    private static func setCategory(_ plan: NextAnswer) {
        registerCategories(skipLabel: plan.card?.actions.first { $0.id == "skipped" }?.label)
    }

    /// The trip category and its "Not going" button, at launch too: a
    /// pushed alert carries the category on a phone that has never
    /// scheduled a reminder, and without it there'd be no button.
    static func registerCategories(skipLabel: String? = nil) {
        let skip = UNNotificationAction(identifier: TripReminders.skipAction, title: skipLabel ?? L("Not going"), options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: TripReminders.category, actions: [skip], intentIdentifiers: [])
        ])
    }

    private static func schedule(_ id: String, at: Date, now: Date, plan: NextAnswer, trip: String, leaveNow: Bool, checked: Date) {
        let words = TripReminders.words(plan, leaveNow: leaveNow, firesAt: max(at, now), checked: checked)
        let c = UNMutableNotificationContent()
        c.title = words.title
        c.subtitle = words.subtitle
        c.body = words.body
        c.sound = .default
        c.threadIdentifier = "trip"
        c.categoryIdentifier = plan.card?.actions.contains { $0.id == "skipped" } == true ? TripReminders.category : ""
        c.userInfo = ["trip": plan.card?.actions.first { $0.id == "skipped" }?.trip ?? trip]
        c.interruptionLevel = .timeSensitive
        c.relevanceScore = 1
        // Both on the server's clock, so the wait is right on a phone whose clock is out.
        let wait = at.timeIntervalSince(now)
        let trigger = wait > 1 ? UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false) : nil
        center.add(UNNotificationRequest(identifier: id, content: c, trigger: trigger))
    }
}
