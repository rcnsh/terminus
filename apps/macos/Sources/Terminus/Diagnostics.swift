import Foundation
import UserNotifications

/// The app's last requests to our server, kept in memory for the developer
/// menu (Settings, About) and the diagnostics it copies. Only the path is
/// kept, never the query: /api/me/next is asked with where you are.
enum RequestLog {
    /// One request: `status` nil when no answer came (`failure` says why).
    struct Entry: Equatable {
        let at: Date
        let method: String
        let path: String
        let host: String
        let status: Int?
        let tookMs: Int
        var failure: String? = nil
    }

    static let max = 50
    private static let lock = NSLock()
    nonisolated(unsafe) private static var list: [Entry] = []

    static func record(_ method: String, _ path: String, base: String, status: Int?, tookMs: Int, failure: Error?, at: Date = Date()) {
        let entry = Entry(
            at: at, method: method, path: pathOnly(path), host: URL(string: base)?.host ?? base, status: status, tookMs: tookMs,
            failure: failure.map(describe))
        lock.withLock {
            list.insert(entry, at: 0)
            if list.count > max { list.removeLast(list.count - max) }
        }
    }

    /// Newest first.
    static var entries: [Entry] { lock.withLock { list } }

    static func clear() { lock.withLock { list = [] } }

    static func pathOnly(_ path: String) -> String {
        String(path.prefix { $0 != "?" && $0 != "#" })
    }

    /// A URLError by its code's name (`cannotFindHost`), anything else by its type.
    static func describe(_ error: Error) -> String {
        if let e = error as? URLError { return "URLError \(e.code.rawValue)" }
        return String(describing: type(of: error))
    }
}

/// What the developer menu shows about the app's state, and the text it
/// copies for a bug report: the version and Mac, the server and its clock,
/// what the reminders need, and the last answer. Nothing that identifies the
/// account, and no place.
enum Diagnostics {
    struct Facts {
        var version: String
        var build: String
        var channel: String
        var debug: Bool
        var macOS: String
        var language: String
        var server: String
        var skewS: TimeInterval
        var signedIn: Bool
        var anonymous: Bool
        /// Nil: not asked yet (or no app bundle to ask for).
        var notifications: Bool?
        var leaveAlerts: Bool
        var nextReminder: Date?
        var answerAt: Date?
        var quality: String?
        var lastError: String?
    }

    /// [facts(_:notifications:nextReminder:)], with what macOS says about notifications.
    @MainActor static func facts(_ app: AppModel) async -> Facts {
        var notifications: Bool?
        var next: Date?
        // Run as a bare binary (swift run, tests) there's no bundle to ask for.
        if Bundle.main.bundleURL.pathExtension == "app" {
            let center = UNUserNotificationCenter.current()
            let status = await center.notificationSettings().authorizationStatus
            notifications = status == .notDetermined ? nil : [.authorized, .provisional].contains(status)
            next = await center.pendingNotificationRequests().compactMap {
                ($0.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
                    ?? ($0.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate()
            }.min()
        }
        return facts(app, notifications: notifications, nextReminder: next)
    }

    /// What the app knows without asking macOS: shown at once, before the notifications' answer.
    @MainActor static func facts(_ app: AppModel, notifications: Bool?, nextReminder next: Date?) -> Facts {
        Facts(
            version: Api.version ?? "dev",
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "-",
            channel: Api.isBeta ? "beta" : "stable",
            debug: Servers.isDebug,
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            language: Lang.header,
            server: Api.base,
            skewS: ServerClock.skew,
            signedIn: app.paired,
            anonymous: app.anonymous,
            notifications: notifications,
            leaveAlerts: LeaveNotifier.shared.enabled,
            nextReminder: next,
            answerAt: app.updated,
            quality: app.plan?.card?.quality ?? app.plan?.quality,
            lastError: app.error
        )
    }

    /// The text Copy diagnostics puts on the clipboard: English, for the
    /// operator, with times in Singapore's.
    static func report(_ f: Facts, requests: [RequestLog.Entry], now: Date) -> String {
        var out = ""
        func line(_ k: String, _ v: String?) { out += "\(k): \(v ?? "-")\n" }
        func yes(_ b: Bool?) -> String { b.map { $0 ? "yes" : "no" } ?? "-" }
        line("terminus", "\(f.version) (\(f.build)) \(f.channel)\(f.debug ? " debug" : "")")
        line("macos", f.macOS)
        line("language", f.language)
        line("at", stamp(now))
        line("server", f.server)
        line("clock", skew(f.skewS))
        line("signed in", !f.signedIn ? "no" : f.anonymous ? "anonymous" : "yes")
        line("notifications", yes(f.notifications))
        line("leave alerts", yes(f.leaveAlerts))
        line("next reminder", f.nextReminder.map(stamp))
        line("answer", f.answerAt.flatMap { ago($0, now: now) })
        line("quality", f.quality)
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

    /// "+42 s" when this Mac is behind the server, "-42 s" ahead, "right" when it's within ServerClock's noise.
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
