import CryptoKit
import UIKit
import UserNotifications

/// Push: Apple's push service. The server says when the card changes, so the
/// phone doesn't have to keep asking. A push is a nudge (`kind: card`, with
/// its phase): the app fetches /me/next itself and the widgets, the Live
/// Activity and the reminders follow. An alert (a trip that's due, a missed
/// bus) comes with the server's words, through Apple, and the notification
/// service re-words it on the phone from a fresh answer when it can. The
/// Live Activity's pushes carry its state (the bus, the stop, the times).
/// The other kind, `term`, is the new semester's reminder.
/// Everything still works without push, from the app and the background refresh.
@MainActor enum Push {
    private static var d: UserDefaults { Shared.defaults }

    static func launched(_ application: UIApplication) {
        #if DEBUG
            // For the UI tests and screenshots: the trip settings on from the start.
            let env = ProcessInfo.processInfo.environment
            if env["TERMINUS_ALERTS"] == "1" {
                TripPrefs.leaveAlerts = true
                Task { _ = await askPermission() }
            }
            if env["TERMINUS_LIVE"] == "1" { TripPrefs.liveActivity = true }
        #endif
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
        // Before any push: an alert carrying the trip category needs its "Not going" button.
        Reminders.registerCategories()
        Background.register()
        // A token for silent pushes needs no permission: asked for whenever signed in.
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

    /// A push the app hears (in the foreground, or woken for it in the background).
    static func received(_ userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        guard TokenStore.read() != nil else { return .noData }
        d.set(Date(), forKey: "push.heardAt")
        switch userInfo["kind"] as? String {
        case "term":
            // The alert itself was worded by the notification service; a silent one is posted here.
            if userInfo["aps"].flatMap({ ($0 as? [String: Any])?["alert"] }) != nil { return .noData }
            return await postNotice() ? .newData : .noData
        case "card", nil:
            // Asked for even just after another refresh: the card changed since.
            return await TripSync.refresh(force: true) ? .newData : .failed
        default:
            return .noData
        }
    }

    // MARK: the token

    /// The same tokens are sent again after this long: the server drops one
    /// Apple stopped delivering to, and nothing tells the phone.
    static let resend: TimeInterval = 12 * 3600

    /// The Live Activity's token (`apnsla:`), while one is running.
    static var liveToken: String? {
        get { d.string(forKey: "push.live") }
        set { d.set(newValue, forKey: "push.live") }
    }

    /// The token that starts a Live Activity by push (`apnsstart:`, iOS 17.2
    /// and later). The phone's, not the session's: kept when signed out, and
    /// sent only while the Live Activity is on.
    static var startToken: String? {
        get { d.string(forKey: "push.start") }
        set { d.set(newValue, forKey: "push.start") }
    }

    /// Which session the tokens were sent with, without keeping the session token in plain defaults.
    static func tag(_ session: String) -> String {
        SHA256.hash(data: Data(session.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    /// Sends this phone's tokens when they're new, for a new session, or due
    /// again (`resend`), and when the trip settings are turned on or off: the
    /// server sends the trip's alerts only while the leave alerts are on, and
    /// starts a Live Activity only while that is. Called when the session, a
    /// token or the trip settings change, at start, and from each answer.
    static func sync(force: Bool = false) {
        Task { await send(force: force) }
    }

    /// `sync`, waited for: the Live Activity's Turn off is done once the server knows.
    static func send(force: Bool = false) async {
        guard let auth = TokenStore.read(), let apns = d.string(forKey: "push.apns") else { return }
        let live = TripPrefs.liveActivity
        let tokens = [apns] + [liveToken, live ? startToken : nil].compactMap { $0 }
        let alerts = TripPrefs.leaveAlerts
        let sent = (tokens + [alerts ? "alerts" : "quiet", live ? "live" : "still"]).joined(separator: "|")
        let fresh =
            d.string(forKey: "push.sent") == sent && d.string(forKey: "push.for") == tag(auth)
            && (d.object(forKey: "push.sentAt") as? Date).map { -$0.timeIntervalSinceNow < resend } == true
        if fresh && !force { return }
        do {
            // One token a request: the phone's (with both settings), then the Live Activity's.
            for t in tokens {
                try await Api(token: auth).registerPush(apple: t, alerts: t == apns ? alerts : nil, live: t == apns ? live : nil)
            }
            // Signed in again meanwhile: the new session hasn't got it.
            guard TokenStore.read() == auth else { return }
            d.set(sent, forKey: "push.sent")
            d.set(tag(auth), forKey: "push.for")
            d.set(Date(), forKey: "push.sentAt")
        } catch {}
    }

    /// Signed in: asks for a token, which comes to `registered`.
    static func signedIn() {
        d.removeObject(forKey: "push.sent")
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Signed out: the server stops sending to that session (it's ended anyway), and this phone forgets what it sent.
    static func signedOut() {
        if let auth = TokenStore.read(), d.string(forKey: "push.sent") != nil {
            Task { try? await Api(token: auth).unregisterPush() }
        }
        for k in ["push.sent", "push.for", "push.sentAt", "push.live", "live.tokenFor"] { d.removeObject(forKey: k) }
    }

    // MARK: permission

    /// Notifications refused in the phone's Settings: only Settings can change it.
    private(set) static var notificationsDenied = false
    /// Notifications allowed.
    private(set) static var notificationsAllowed = false

    static func checkPermission() async {
        let s = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        notificationsDenied = s == .denied
        notificationsAllowed = s == .authorized || s == .provisional || s == .ephemeral
    }

    /// Asks for permission to notify (once; after that only Settings can
    /// change it). True when allowed. Time Sensitive comes with the
    /// entitlement, so a heads-up gets through a Focus.
    static func askPermission() async -> Bool {
        let ok = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        await checkPermission()
        return ok
    }

    /// This app's page in Settings, for notifications refused.
    static func openSettings() {
        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
    }

    // MARK: the new semester's reminder

    /// Fetches the reminder's words and posts it; false with nothing to say.
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

/// What the app hears about its notifications: shown in the foreground too,
/// a tap opens Now, and "Not going" takes the class off today.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
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
            // Waited for: iOS keeps the app awake until this returns.
            await TripSync.skip(trip: trip)
        } else if action == UNNotificationDefaultActionIdentifier {
            await MainActor.run { Links.open(URL(string: "terminus://plan")!) }
        }
    }
}
