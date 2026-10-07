import AppKit
import Foundation
import UserNotifications
import os

private let log = Logger(subsystem: "sh.rcn.terminus", category: "notify")

/// When to leave, as local notifications (phase 7): a heads-up at the card's
/// `remindAt`, and "Leave now" at the leave-by. The server decides which trips
/// get one (no `remindAt`, no reminder) and words them, like every other client. Nothing asks what happened afterwards: the trip
/// follows the plan and the phone's location.
///
/// Local notifications don't need APNs or a paid Apple team, so they work for
/// the self-signed build. They're scheduled ahead from each refresh, so they
/// fire on time even while the refresh loop waits; a later refresh moves them
/// when the leave-by moves. When the refreshes stop (offline, asleep, locked)
/// they still go, but say when their times were last checked.
@MainActor
final class LeaveNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LeaveNotifier()

    private static let soonID = "leave-soon"
    private static let nowID = "leave-now"
    /// The question older versions posted ("On the 9:41 D2?"), cleared if still showing.
    private static let askID = "ask"

    /// Only touched by the running app: without an app bundle (tests,
    /// snapshot renders) asking for it throws.
    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }
    private let defaults = UserDefaults.standard
    /// Bumped by every change to the reminders, so a rewording that was
    /// waiting on macOS doesn't put back what a newer answer replaced.
    private var generation = 0
    /// The pending reminders say they're unconfirmed (`unconfirmed(since:)`).
    private var reworded = false

    /// The Settings toggle. Off until the user turns it on.
    var enabled: Bool {
        get { defaults.bool(forKey: "leaveAlerts") }
        set { defaults.set(newValue, forKey: "leaveAlerts") }
    }

    /// At launch: button taps on a notification come here, even when they started the app.
    func start() {
        // Run as a bare binary (snapshot renders, `swift run`) there's no bundle to notify for.
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        center.delegate = self
        center.setNotificationCategories([])
        // On, but macOS forgot (a reinstall, a reset): ask again rather than stay silent.
        if enabled { Task { _ = await requestPermission() } }
    }

    /// Asks macOS for permission. False if it was refused (then only System Settings can change it).
    func requestPermission() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            log.error("notification permission: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func openSettings() {
        // This build's own id: the beta is a different app with its own settings.
        let id = Bundle.main.bundleIdentifier ?? "sh.rcn.terminus"
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!)
    }

    func turnOff() {
        enabled = false
        center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
        center.removeDeliveredNotifications(withIdentifiers: [Self.soonID, Self.nowID, Self.askID])
    }

    /// Brings the scheduled notifications in line with the latest plan.
    /// `now` is on the server's clock, as the plan's times are.
    func update(_ plan: NextAnswer?, now: Date = ServerClock.now) {
        guard enabled, let plan else { return }
        generation += 1
        reworded = false
        let card = plan.card
        let phase = card?.phase ?? "idle"
        let trip = tripKey(plan)

        // Past the leave-by the phase is "heading" by the clock: "Leave now"
        // stays up (the heads-up it replaces goes).
        if phase == "heading" {
            center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
            center.removeDeliveredNotifications(withIdentifiers: [Self.soonID])
            return
        }
        // At the stop, on the bus, missed, there, or not going: the reminders are over.
        if phase != "idle" && phase != "due" {
            clearLeave()
            center.removeDeliveredNotifications(withIdentifiers: [Self.askID])
            return
        }
        guard card?.remind != false, let trip, let soonAt = card?.remindAt.flatMap(parseISODate), let leaveAt = plan.leaveAt, leaveAt > now else {
            clearLeave()
            return
        }
        // A different trip (the last one skipped or over): its reminders go.
        if let last = defaults.string(forKey: "soonTrip"), last != trip { clearLeave() }
        // The heads-up goes once per trip: once it has gone, a leave-by that
        // moves later doesn't bring it back.
        let soonDone = defaults.string(forKey: "soonTrip") == trip && defaults.double(forKey: "soonAt") <= now.timeIntervalSince1970
        if !soonDone {
            defaults.set(trip, forKey: "soonTrip")
            defaults.set(max(soonAt, now).timeIntervalSince1970, forKey: "soonAt")
            schedule(Self.soonID, at: soonAt, now: now, title: card?.leaveBy ?? card?.title ?? plan.label, plan: plan)
        }
        schedule(Self.nowID, at: leaveAt, now: now, title: L("Leave now"), plan: plan)
    }

    /// The trip a notification is about: the key the card's buttons carry.
    private func tripKey(_ plan: NextAnswer) -> String? {
        plan.card?.actions?.first?.trip
    }

    /// Removes the leave reminders, delivered or not (after "left", or when the trip moves on).
    func clearLeave() {
        generation += 1
        center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
        center.removeDeliveredNotifications(withIdentifiers: [Self.soonID, Self.nowID])
    }

    private func schedule(_ id: String, at: Date, now: Date, title: String, plan: NextAnswer) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = where_(plan)
        content.body = plan.card?.catch ?? plan.detail
        // The words as the server gave them, for `unconfirmed(since:)` to add
        // to, and when it's due on the server's clock: a time-interval
        // trigger's `nextTriggerDate()` counts its whole wait again from now.
        content.userInfo = ["body": content.body, "at": at.timeIntervalSince1970]
        content.sound = .default
        content.threadIdentifier = "trip"
        // Already due (a refresh after the moment, or a late wake): now, not never.
        // Both on the server's clock, so the wait is right on a Mac whose clock is out.
        let wait = at.timeIntervalSince(now)
        add(id, content: content, trigger: wait > 1 ? UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false) : nil)
    }

    private func add(_ id: String, content: UNNotificationContent, trigger: UNNotificationTrigger?) {
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { err in
            if let err { log.error("schedule \(id, privacy: .public): \(err.localizedDescription, privacy: .public)") }
        }
    }

    /// The refreshes have stopped (one failed, or the Mac is asleep or locked)
    /// with reminders still to come. They keep the last answer's words, since
    /// a late heads-up beats none, but say when it was checked (`checked`, on
    /// the server's clock), as the times on it may have moved since.
    func unconfirmed(since checked: Date?) {
        guard enabled, let checked else { return }
        let note = L("Last checked %@. Times may have changed.", campusTime(checked))
        let gen = generation
        reworded = true
        Task {
            let pending = await center.pendingNotificationRequests()
            for r in pending where r.identifier == Self.soonID || r.identifier == Self.nowID {
                // A newer answer or a clear got there first.
                guard enabled, gen == generation else { return }
                guard let at = r.content.userInfo["at"] as? Double,
                      let content = r.content.mutableCopy() as? UNMutableNotificationContent else { continue }
                // Its trigger counts from when it's added: the time left, not the whole wait again.
                let wait = at - ServerClock.now.timeIntervalSince1970
                guard wait > 1 else { continue }
                let body = content.userInfo["body"] as? String ?? content.body
                let worded = body.isEmpty ? note : "\(body)\n\(note)"
                // Already says so: each failed refresh needn't add it again.
                guard content.body != worded else { continue }
                content.body = worded
                // Added straight after the check, with no wait between them.
                add(r.identifier, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false))
            }
        }
    }

    /// A refresh answered: reminders that said they were unconfirmed are worded
    /// from the plan again (which may not have been fetched anew, if still current).
    func confirmed(_ plan: NextAnswer?) {
        if reworded { update(plan) }
    }

    /// "To GEA1000 @ UTown · starts 10:00", or the card's heading.
    private func where_(_ plan: NextAnswer) -> String {
        plan.card?.journey?.title ?? plan.card?.heading ?? plan.dest?.label ?? ""
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Shown even while the popover is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
