import UserNotifications
import WidgetKit

final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
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
