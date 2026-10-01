import AppKit
import Foundation
import UserNotifications
import os

private let log = Logger(subsystem: "sh.rcn.terminus", category: "notify")

/// When to leave for class, as local notifications (phase 7): a heads-up five
/// minutes before the leave-by, and "Leave now" at it. Worded from the card,
/// like every other client. Nothing asks what happened afterwards: the trip
/// follows the plan and the phone's location.
///
/// Local notifications don't need APNs or a paid Apple team, so they work for
/// the self-signed build. They're scheduled ahead from each refresh, so they
/// fire on time even while the refresh loop waits; a later refresh moves them
/// when the leave-by moves.
@MainActor
final class LeaveNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LeaveNotifier()

    private static let soonID = "leave-soon"
    private static let nowID = "leave-now"
    /// The question older versions posted ("On the 9:41 D2?"), cleared if still showing.
    private static let askID = "ask"
    /// A heads-up this long before the leave-by.
    static let headsUp: TimeInterval = 5 * 60

    /// Only touched by the running app: without an app bundle (tests,
    /// snapshot renders) asking for it throws.
    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }
    private let defaults = UserDefaults.standard

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
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=sh.rcn.terminus")!)
    }

    func turnOff() {
        enabled = false
        center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
        center.removeDeliveredNotifications(withIdentifiers: [Self.soonID, Self.nowID, Self.askID])
    }

    /// Brings the scheduled notifications in line with the latest plan.
    func update(_ plan: NextAnswer?, now: Date = Date()) {
        guard enabled, let plan else { return }
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
        guard plan.isClassPlan, card?.remind != false, let trip, let leaveAt = plan.leaveAt, leaveAt > now else {
            clearLeave()
            return
        }
        // A different trip (the last one skipped or over): its reminders go.
        if let last = defaults.string(forKey: "soonTrip"), last != trip { clearLeave() }
        let soonAt = leaveAt.addingTimeInterval(-Self.headsUp)
        // The heads-up goes once per trip: once it has gone, a leave-by that
        // moves later doesn't bring it back.
        let soonDone = defaults.string(forKey: "soonTrip") == trip && defaults.double(forKey: "soonAt") <= now.timeIntervalSince1970
        if !soonDone {
            defaults.set(trip, forKey: "soonTrip")
            defaults.set(max(soonAt, now).timeIntervalSince1970, forKey: "soonAt")
            schedule(Self.soonID, at: soonAt, now: now, title: card?.leaveBy ?? L("Leave by %@", campusTime(leaveAt)), plan: plan)
        }
        schedule(Self.nowID, at: leaveAt, now: now, title: L("Leave now"), plan: plan)
    }

    /// The trip a notification is about: the key the card's buttons carry.
    func tripKey(_ plan: NextAnswer) -> String? {
        plan.card?.actions?.first?.trip
    }

    /// Removes the leave reminders, delivered or not (after "left", or when the trip moves on).
    func clearLeave() {
        center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
        center.removeDeliveredNotifications(withIdentifiers: [Self.soonID, Self.nowID])
    }

    private func schedule(_ id: String, at: Date, now: Date, title: String, plan: NextAnswer) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.subtitle = where_(plan)
        content.body = plan.card?.catch ?? plan.detail
        content.sound = .default
        content.threadIdentifier = "trip"
        // Already due (a refresh after the moment, or a late wake): now, not never.
        let wait = at.timeIntervalSince(now)
        let trigger = wait > 1 ? UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false) : nil
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { err in
            if let err { log.error("schedule \(id, privacy: .public): \(err.localizedDescription, privacy: .public)") }
        }
    }

    /// "GEA1000 @ UTown · starts 09:00".
    private func where_(_ plan: NextAnswer) -> String {
        ([plan.dest?.label, plan.classAt.map { L("starts %@", campusTime($0)) }] as [String?]).compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: UNUserNotificationCenterDelegate

    /// Shown even while the popover is open.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
