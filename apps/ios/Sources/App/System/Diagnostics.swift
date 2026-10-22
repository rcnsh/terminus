import BackgroundTasks
import UIKit
import UserNotifications

/// What the developer menu shows about the app's state, and the text it
/// copies for a bug report: the version and phone, the server and its clock,
/// what the alerts and push need, and the last answer. Nothing that
/// identifies the account, and no place. As Android's Diagnostics.
enum Diagnostics {
    struct Facts {
        var version: String
        var build: String
        var channel: String
        var debug: Bool
        var ios: String
        var device: String
        var language: String
        var server: String
        var skewS: TimeInterval
        var signedIn: Bool
        var anonymous: Bool
        /// Nil: not asked yet.
        var notifications: Bool?
        var leaveAlerts: Bool
        var liveActivity: Bool
        /// Background App Refresh, in the phone's Settings.
        var backgroundRefresh: Bool
        /// The phone has its APNs token (a sideloaded build never does).
        var pushToken: Bool
        var pushSentAt: Date?
        var pushHeardAt: Date?
        var nextRefresh: Date?
        var nextReminder: Date?
        var answerAt: Date?
        var quality: String?
        var staleAt: Date?
        var remindAt: Date?
        var lastError: String?
    }

    /// [facts(_:notifications:nextRefresh:nextReminder:)], with what iOS says about notifications and the background refresh.
    @MainActor static func facts(_ app: AppModel) async -> Facts {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        let notifications = status == .notDetermined ? nil : [.authorized, .provisional, .ephemeral].contains(status)
        let reminder = await center.pendingNotificationRequests().compactMap {
            ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
                ?? ($0.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
        }.min()
        let refresh = await BGTaskScheduler.shared.pendingTaskRequests().compactMap(\.earliestBeginDate).min()
        return facts(app, notifications: notifications, nextRefresh: refresh, nextReminder: reminder)
    }

    /// What the app knows without asking iOS: shown at once, before its answers.
    @MainActor static func facts(_ app: AppModel, notifications: Bool?, nextRefresh: Date?, nextReminder: Date?) -> Facts {
        let d = Shared.defaults
        let last = WidgetStore.plan()
        return Facts(
            version: Api.version,
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "-",
            channel: Api.isBeta ? "beta" : "stable",
            debug: Servers.isDebug,
            ios: "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            device: model,
            language: Lang.header,
            server: Api.base,
            skewS: ServerClock.skew,
            signedIn: app.paired,
            anonymous: app.anonymous,
            notifications: notifications,
            leaveAlerts: TripPrefs.leaveAlerts,
            liveActivity: TripPrefs.liveActivity && LiveTrip.allowed,
            backgroundRefresh: UIApplication.shared.backgroundRefreshStatus == .available,
            pushToken: d.string(forKey: "push.apns") != nil,
            pushSentAt: d.object(forKey: "push.sentAt") as? Date,
            pushHeardAt: d.object(forKey: "push.heardAt") as? Date,
            nextRefresh: nextRefresh,
            nextReminder: nextReminder,
            answerAt: last?.1,
            quality: last.flatMap { $0.0.card?.quality ?? $0.0.quality },
            staleAt: last?.0.staleAt,
            remindAt: last?.0.card?.remindAt.flatMap(parseISODate),
            lastError: app.error
        )
    }

    /// "iPhone17,1": the model, which says more than "iPhone" without naming anyone.
    private static var model: String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// The text Copy diagnostics puts on the clipboard: English, for the
    /// operator, with times in Singapore's.
    static func report(_ f: Facts, requests: [RequestLog.Entry], now: Date) -> String {
        var out = ""
        func line(_ k: String, _ v: String?) { out += "\(k): \(v ?? "-")\n" }
        func yes(_ b: Bool?) -> String { b.map { $0 ? "yes" : "no" } ?? "-" }
        line("terminus", "\(f.version) (\(f.build)) \(f.channel)\(f.debug ? " debug" : "")")
        line("ios", f.ios)
        line("device", f.device)
        line("language", f.language)
        line("at", stamp(now))
        line("server", f.server)
        line("clock", skew(f.skewS))
        line("signed in", !f.signedIn ? "no" : f.anonymous ? "anonymous" : "yes")
        line("notifications", yes(f.notifications))
        line("leave alerts", yes(f.leaveAlerts))
        line("live activity", yes(f.liveActivity))
        line("background refresh", yes(f.backgroundRefresh))
        line("push", f.pushToken ? "active" : "not active")
        line("push sent", f.pushSentAt.flatMap { ago($0, now: now) })
        line("push heard", f.pushHeardAt.flatMap { ago($0, now: now) })
        line("next refresh", f.nextRefresh.map(stamp))
        line("next reminder", f.nextReminder.map(stamp))
        line("answer", f.answerAt.flatMap { ago($0, now: now) })
        line("quality", f.quality)
        line("stale at", f.staleAt.map(stamp))
        line("remind at", f.remindAt.map(stamp))
        line("last error", f.lastError)
        out += "\nrequests (newest first):\n"
        if requests.isEmpty { out += "none\n" }
        for r in requests { out += entry(r) + "\n" }
        return out
    }

    /// One request as a line: when, what, where, and how it went.
    static func entry(_ r: RequestLog.Entry) -> String { "\(time(r.at)) \(r.method) \(r.path) \(r.host) \(outcome(r)) \(r.tookMs) ms" }

    /// The status, or why there was none.
    static func outcome(_ r: RequestLog.Entry) -> String { r.status.map(String.init) ?? r.failure ?? "no answer" }

    /// "+42 s" when this phone is behind the server, "-42 s" ahead, "right" when it's within ServerClock's noise.
    static func skew(_ s: TimeInterval) -> String {
        let n = Int(s.rounded(.towardZero))
        return n == 0 ? "right" : "\(n > 0 ? "+" : "-")\(abs(n)) s"
    }

    /// How long ago `at` was, as "3 min ago" (seconds under a minute, hours over an hour).
    static func ago(_ at: Date, now: Date) -> String? {
        let s = Swift.max(0, Int(now.timeIntervalSince(at)))
        if s < 60 { return "\(s) s ago" }
        if s < 3600 { return "\(s / 60) min ago" }
        if s < 48 * 3600 { return "\(s / 3600) h ago" }
        return "\(s / 86_400) d ago"
    }

    private static func formatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Singapore")
        f.dateFormat = format
        return f
    }
    private static let stampFormat = formatter("yyyy-MM-dd HH:mm:ss")
    private static let timeFormat = formatter("HH:mm:ss")

    static func stamp(_ d: Date) -> String { stampFormat.string(from: d) }
    static func time(_ d: Date) -> String { timeFormat.string(from: d) }
}
