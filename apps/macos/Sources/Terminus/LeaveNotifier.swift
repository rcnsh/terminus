import AppKit
import Foundation
import UserNotifications
import os

private let log = Logger(subsystem: "sh.rcn.terminus", category: "notify")

@MainActor
final class LeaveNotifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = LeaveNotifier()

    private static let soonID = "leave-soon"
    private static let nowID = "leave-now"
    private static let askID = "ask"

    private var center: UNUserNotificationCenter { UNUserNotificationCenter.current() }
    private let defaults = UserDefaults.standard
    private var generation = 0
    private var reworded = false

    var enabled: Bool {
        get { defaults.bool(forKey: "leaveAlerts") }
        set { defaults.set(newValue, forKey: "leaveAlerts") }
    }

    func start() {
        guard Bundle.main.bundleURL.pathExtension == "app" else { return }
        center.delegate = self
        center.setNotificationCategories([])
        if enabled { Task { _ = await requestPermission() } }
    }

    func requestPermission() async -> Bool {
        do {
            return try await center.requestAuthorization(options: [.alert, .sound])
        } catch {
            log.error("notification permission: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func openSettings() {
        let id = Bundle.main.bundleIdentifier ?? "sh.rcn.terminus"
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!)
    }

    func turnOff() {
        enabled = false
        center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
        center.removeDeliveredNotifications(withIdentifiers: [Self.soonID, Self.nowID, Self.askID])
    }

    func update(_ plan: NextAnswer?, now: Date = ServerClock.now) {
        guard enabled, let plan else { return }
        generation += 1
        reworded = false
        let card = plan.card
        switch Self.step(plan, soonTrip: defaults.string(forKey: "soonTrip"), soonAt: defaults.double(forKey: "soonAt"), now: now) {
        case .heading:
            center.removePendingNotificationRequests(withIdentifiers: [Self.soonID, Self.nowID])
            center.removeDeliveredNotifications(withIdentifiers: [Self.soonID])
        case .over:
            clearLeave()
            center.removeDeliveredNotifications(withIdentifiers: [Self.askID])
        case .clear:
            clearLeave()
        case .schedule(let clearFirst, let trip, let soon, let leaveAt):
            if clearFirst { clearLeave() }
            if let soon {
                defaults.set(Self.soonKey(plan, now: now) ?? trip, forKey: "soonTrip")
                defaults.set(max(soon, now).timeIntervalSince1970, forKey: "soonAt")
                schedule(Self.soonID, at: soon, now: now, title: card?.leaveBy ?? card?.title ?? plan.label, plan: plan)
            }
            schedule(Self.nowID, at: leaveAt, now: now, title: L("Leave now"), plan: plan)
        }
    }

    enum Step: Equatable {
        case heading
        case over
        case clear
        case schedule(clearFirst: Bool, trip: String, soon: Date?, leaveAt: Date)
    }

    nonisolated static func step(_ plan: NextAnswer, soonTrip: String?, soonAt lastSoonAt: Double, now: Date) -> Step {
        let card = plan.card
        let phase = card?.phase ?? "idle"
        if card?.gone == true { return .over }
        if phase == "heading" { return .heading }
        if phase != "idle" && phase != "due" { return .over }
        guard card?.remind != false, let trip = tripKey(plan), let soonAt = card?.remindAt.flatMap(parseISODate),
            let leaveAt = plan.leaveAt, leaveAt > now
        else {
            return .clear
        }
        let key = soonKey(plan, now: now)
        let clearFirst = soonTrip != nil && soonTrip != key
        let soonDone = soonTrip == key && lastSoonAt <= now.timeIntervalSince1970
        return .schedule(clearFirst: clearFirst, trip: trip, soon: soonDone ? nil : soonAt, leaveAt: leaveAt)
    }

    private nonisolated static func tripKey(_ plan: NextAnswer) -> String? {
        plan.card?.actions?.first?.trip
    }

    nonisolated static func soonKey(_ plan: NextAnswer, now: Date) -> String? {
        guard let trip = tripKey(plan) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .campus
        let day = cal.dateComponents([.year, .month, .day], from: plan.leaveAt ?? now)
        return "\(trip)@\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)"
    }

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
        content.userInfo = ["body": content.body, "at": at.timeIntervalSince1970]
        content.sound = .default
        content.threadIdentifier = "trip"
        let wait = at.timeIntervalSince(now)
        add(id, content: content, trigger: wait > 1 ? UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false) : nil)
    }

    private func add(_ id: String, content: UNNotificationContent, trigger: UNNotificationTrigger?) {
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: trigger)) { err in
            if let err { log.error("schedule \(id, privacy: .public): \(err.localizedDescription, privacy: .public)") }
        }
    }

    func unconfirmed(since checked: Date?) {
        guard enabled, let checked else { return }
        let note = L("Last checked %@. Times may have changed.", campusTime(checked))
        let gen = generation
        reworded = true
        Task {
            let pending = await center.pendingNotificationRequests()
            for r in pending where r.identifier == Self.soonID || r.identifier == Self.nowID {
                guard enabled, gen == generation else { return }
                guard let at = r.content.userInfo["at"] as? Double,
                    let content = r.content.mutableCopy() as? UNMutableNotificationContent
                else { continue }
                let wait = at - ServerClock.now.timeIntervalSince1970
                guard wait > 1 else { continue }
                let body = content.userInfo["body"] as? String ?? content.body
                let worded = body.isEmpty ? note : "\(body)\n\(note)"
                guard content.body != worded else { continue }
                content.body = worded
                add(r.identifier, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: wait, repeats: false))
            }
        }
    }

    func confirmed(_ plan: NextAnswer?) {
        if reworded { update(plan) }
    }

    private func where_(_ plan: NextAnswer) -> String {
        plan.card?.journey?.title ?? plan.card?.heading ?? plan.dest?.label ?? ""
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions
    {
        [.banner, .sound, .list]
    }
}
