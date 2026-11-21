import CryptoKit
import UIKit
import UserNotifications

@MainActor enum Push {
    private static var d: UserDefaults { Shared.defaults }

    static func launched(_ application: UIApplication) {
        #if DEBUG
            let env = ProcessInfo.processInfo.environment
            if env["TERMINUS_ALERTS"] == "1" {
                TripPrefs.leaveAlerts = true
                Task { _ = await askPermission() }
            }
            if env["TERMINUS_LIVE"] == "1" { TripPrefs.liveActivity = true }
        #endif
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        Reminders.registerCategories()
        Background.register()
        if TokenStore.read() != nil { application.registerForRemoteNotifications() }
        Task { await checkPermission() }
        LiveTrip.observeTokens()
    }

    static func registered(_ token: Data) {
        let t = Api.apnsToken(token)
        guard t != d.string(forKey: "push.apns") else { return sync() }
        d.set(t, forKey: "push.apns")
        sync(force: true)
    }

    static func received(_ userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard TokenStore.read() != nil else { return .noData }
        d.set(Date(), forKey: "push.heardAt")
        switch userInfo["kind"] as? String {
        case "term":
            if userInfo["aps"].flatMap({ ($0 as? [String: Any])?["alert"] }) != nil { return .noData }
            return await postNotice() ? .newData : .noData
        case "card", nil:
            return await TripSync.refresh(force: true) ? .newData : .failed
        default:
            return .noData
        }
    }

    static let resend: TimeInterval = 12 * 3600

    static var liveToken: String? {
        get { d.string(forKey: "push.live") }
        set { d.set(newValue, forKey: "push.live") }
    }

    static var startToken: String? {
        get { d.string(forKey: "push.start") }
        set { d.set(newValue, forKey: "push.start") }
    }

    static func tag(_ session: String) -> String {
        SHA256.hash(data: Data(session.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func sync(force: Bool = false) {
        Task { await send(force: force) }
    }

    private static var sending: Task<Void, Never>?

    static func send(force: Bool = false) async {
        let before = sending
        let task = Task {
            await before?.value
            await sendNow(force: force)
        }
        sending = task
        await task.value
    }

    private static func sendNow(force: Bool) async {
        guard let auth = TokenStore.read(), let apns = d.string(forKey: "push.apns") else { return }
        let live = TripPrefs.liveActivity
        let tokens = [apns] + [liveToken, live ? startToken : nil].compactMap { $0 }
        let alerts = TripPrefs.leaveAlerts
        let activity = liveToken != nil
        let h12 = Clock.hour12
        let sent = (tokens + [alerts ? "alerts" : "quiet", live ? "live" : "still", h12 ? "h12" : "h24"]).joined(separator: "|")
        let fresh =
            d.string(forKey: "push.sent") == sent && d.string(forKey: "push.for") == tag(auth)
            && (d.object(forKey: "push.sentAt") as? Date).map { -$0.timeIntervalSinceNow < resend } == true
        if fresh && !force { return }
        do {
            for t in tokens {
                try await Api(token: auth).registerPush(
                    apple: t, alerts: t == apns ? alerts : nil, live: t == apns ? live : nil, activity: t == apns ? activity : nil,
                    h12: t == apns ? h12 : nil)
            }
            guard TokenStore.read() == auth else { return }
            d.set(sent, forKey: "push.sent")
            d.set(tag(auth), forKey: "push.for")
            d.set(Date(), forKey: "push.sentAt")
        } catch {}
    }

    static func signedIn() {
        d.removeObject(forKey: "push.sent")
        UIApplication.shared.registerForRemoteNotifications()
    }

    static func signedOut() {
        if let auth = TokenStore.read(), d.string(forKey: "push.sent") != nil {
            Task { try? await Api(token: auth).unregisterPush() }
        }
        for k in ["push.sent", "push.for", "push.sentAt", "push.live", "live.tokenFor"] { d.removeObject(forKey: k) }
    }

    private(set) static var notificationsDenied = false
    private(set) static var notificationsAllowed = false

    static func checkPermission() async {
        let s = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        notificationsDenied = s == .denied
        notificationsAllowed = s == .authorized || s == .provisional || s == .ephemeral
    }

    static func askPermission() async -> Bool {
        let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await checkPermission()
        return ok
    }

    static func openSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
    }

    static func postNotice() async -> Bool {
        guard let token = TokenStore.read(), let n = try? await Api(token: token, fast: true).notice() else { return false }
        let c = UNMutableNotificationContent()
        c.title = n.title
        c.body = n.body
        c.sound = .default
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "term", content: c, trigger: nil))
        return true
    }
}

@MainActor final class NotificationDelegate: NSObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async
        -> UNNotificationPresentationOptions
    {
        [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let trip = info["trip"] as? String
        let action = response.actionIdentifier
        if action == TripReminders.skipAction, let trip {
            await TripSync.skip(trip: trip)
        } else if action == UNNotificationDismissActionIdentifier {
            guard response.notification.request.identifier == TripReminders.soonID, let key = info["soonKey"] as? String else { return }
            Reminders.dismissed(key)
        } else if action == UNNotificationDefaultActionIdentifier {
            Links.open(URL(string: "terminus://plan")!)
        }
    }
}
