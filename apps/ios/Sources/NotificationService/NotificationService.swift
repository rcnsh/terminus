import UserNotifications
import WidgetKit

/// Words a push's alert on the phone, so no words pass through Apple: the
/// server sends only what kind it is (`kind: card` and the phase, or `term`)
/// with a plain fallback, and this fetches the answer and says it as the
/// leave reminder and Android's notification do. A card's answer is kept for
/// the widgets too. Whatever can't be fetched in time keeps the fallback.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    /// The content handler, until it's called, and the work wording the
    /// alert: behind a lock, as the work and the expiry race for it from two
    /// threads and the handler must be called exactly once.
    private let state = Mutex<(handler: ((UNNotificationContent) -> Void)?, task: Task<Void, Never>?)>((nil, nil))
    private var fallback: UNNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void)
    {
        let kind = request.content.userInfo["kind"] as? String
        fallback = Self.respectingAlerts(request.content, kind: kind)
        state.withLock { $0.handler = contentHandler }
        let task = Task { [self] in
            guard let original = fallback else { return }
            let content = await Self.word(kind: kind, original: original)
            finish(content.map { Self.respectingAlerts($0, kind: kind) } ?? original)
        }
        state.withLock { $0.task = task }
    }

    /// Out of time: the server's fallback words.
    override func serviceExtensionTimeWillExpire() {
        state.withLock { $0.task }?.cancel()
        if let fallback { finish(fallback) }
    }

    private func finish(_ content: UNNotificationContent) {
        let h = state.withLock { s in
            defer { s.handler = nil }
            return s.handler
        }
        h?(content)
    }

    /// A trip's alert with the leave alerts off on this phone (the server
    /// sends one only to a build that didn't say so, or before it heard):
    /// it can't be taken back here, so it comes quietly, with no sound and
    /// only in Notification Centre, rather than as a heads-up.
    static func respectingAlerts(_ content: UNNotificationContent, kind: String?) -> UNNotificationContent {
        guard kind == "card", !TripPrefs.leaveAlerts else { return content }
        let c = content.mutableCopy() as! UNMutableNotificationContent
        c.sound = nil
        c.interruptionLevel = .passive
        return c
    }

    static func word(kind: String?, original: UNNotificationContent) async -> UNNotificationContent? {
        guard let token = TokenStore.read() else { return nil }
        let api = Api(token: token, fast: true)
        switch kind {
        case "term":
            guard let n = try? await api.notice() else { return nil }
            let c = original.mutableCopy() as! UNMutableNotificationContent
            c.title = n.title
            c.body = n.body
            return c
        case "card":
            guard let a = await WidgetStore.refreshPlan(force: true) else { return nil }
            WidgetCenter.shared.reloadAllTimelines()
            return content(for: a, original: original)
        default:
            return nil
        }
    }

    /// The alert for a card, as the reminder and Android's notification word
    /// it: after the bus has gone (on it, missed, gone with nothing known) the
    /// card's line and what to do; before, when to leave and the bus to catch.
    static func content(for a: NextAnswer, original: UNNotificationContent) -> UNNotificationContent? {
        let card = a.card
        let now = ServerClock.now
        let after = card?.phase == "riding" || card?.phase == "missed" || card?.gone == true
        let c = original.mutableCopy() as! UNMutableNotificationContent
        if after {
            c.title = card?.line ?? a.label
            c.body = a.detail
        } else {
            guard let head = a.leaveHeadline(now: now) else { return nil }
            c.title = head
            c.body = card?.catchLine ?? a.dest?.label ?? ""
        }
        c.subtitle = card?.journey?.title ?? card?.heading ?? a.dest?.label ?? ""
        c.threadIdentifier = "trip"
        if let skip = card?.actions.first(where: { $0.id == "skipped" }), !after {
            c.categoryIdentifier = TripReminders.category
            var info = c.userInfo
            info["trip"] = skip.trip
            c.userInfo = info
        }
        // This push says it now: the local heads-up goes, shown or still to
        // come, so there's one; and it's marked as gone for this trip, so the
        // app's next answer doesn't schedule it again (Reminders' soonTrip, soonAt).
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [TripReminders.soonID])
        center.removePendingNotificationRequests(
            withIdentifiers: after ? [TripReminders.soonID, TripReminders.nowID] : [TripReminders.soonID])
        if !after, let trip = TripReminders.soonKey(a, now: now) {
            Shared.defaults.set(trip, forKey: "soonTrip")
            Shared.defaults.set(now, forKey: "soonAt")
        }
        return c
    }
}
