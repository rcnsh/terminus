import UserNotifications
import WidgetKit

/// Words a push's alert on the phone, so no words pass through Apple: the
/// server sends only what kind it is (`kind: card` and the phase, or `term`)
/// with a plain fallback, and this fetches the answer and says it as the
/// leave reminder and Android's notification do. A card's answer is kept for
/// the widgets too. Whatever can't be fetched in time keeps the fallback.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var handler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private var task: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void)
    {
        handler = contentHandler
        fallback = request.content
        let kind = request.content.userInfo["kind"] as? String
        task = Task { [self] in
            guard let original = fallback else { return }
            let content = await Self.word(kind: kind, original: original)
            finish(content ?? original)
        }
    }

    /// Out of time: the server's fallback words.
    override func serviceExtensionTimeWillExpire() {
        task?.cancel()
        if let fallback { finish(fallback) }
    }

    private func finish(_ content: UNNotificationContent) {
        guard let h = handler else { return }
        handler = nil
        h(content)
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
        // This push says it now: the local reminder for the same moment goes, so there's one.
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [TripReminders.soonID])
        if after { center.removePendingNotificationRequests(withIdentifiers: [TripReminders.soonID, TripReminders.nowID]) }
        return c
    }
}
