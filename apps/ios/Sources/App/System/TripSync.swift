import Foundation
import WidgetKit

@MainActor enum TripSync {
    private static var shown: String?

    static func answered(_ answer: NextAnswer) {
        WidgetStore.answerAt = Date()
        WidgetStore.error = nil
        if let loc = Locator.shared.last {
            WidgetStore.saveLocation(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, acc: loc.acc, at: loc.timestamp)
        }
        let key = shownKey(answer)
        if key != shown {
            shown = key
            WidgetCenter.shared.reloadAllTimelines()
        }
        Reminders.update(answer, checked: ServerClock.now)
        Task { await LiveTrip.update(answer) }
        Background.schedule()
        Push.sync()
        countWidgets()
    }

    static func restyled() {
        shown = nil
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func signedIn() {
        Shared.lastAnswer = nil
        Shared.lastDay = nil
        WidgetStore.forget()
        shown = nil
        Push.signedIn()
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func signedOut() {
        Push.signedOut()
        Reminders.forget()
        WidgetStore.forget()
        shown = nil
        Task { await LiveTrip.endAll() }
        WidgetCenter.shared.reloadAllTimelines()
        Background.schedule()
    }

    static func prefsChanged() {
        Task { await applyPrefs() }
    }

    static func liveTurnedOff() async {
        TripPrefs.liveActivity = false
        await applyPrefs()
    }

    private static func applyPrefs() async {
        await Push.checkPermission()
        let plan = WidgetStore.plan()?.0
        if let plan {
            Reminders.update(plan, checked: WidgetStore.answerAt.map { $0.addingTimeInterval(ServerClock.skew) } ?? ServerClock.now)
        } else {
            Reminders.clear()
        }
        await LiveTrip.update(plan)
        await Push.send(force: true)
        Background.schedule()
    }

    static var followed: Bool {
        TripPrefs.leaveAlerts || TripPrefs.liveActivity || Shared.defaults.integer(forKey: "widgets.count") > 0
    }

    @discardableResult
    static func refresh(force: Bool) async -> Bool {
        guard followed || force else { return true }
        let before = WidgetStore.plan()?.0
        guard let a = await WidgetStore.refreshPlan(force: force) else {
            WidgetCenter.shared.reloadAllTimelines()
            return false
        }
        answered(a)
        if before?.dest?.label != a.dest?.label || dayDue() { await keepDay() }
        await WidgetStore.refreshChosen()
        if NearbyShared.wanted { await NearbyShared.refreshIfDue(needsPlace: true) }
        return true
    }

    static func nearbyFetched(_ data: Data, token: String) {
        guard NearbyShared.keep(data, sentWith: token) else { return }
        if NearbyShared.wanted { WidgetCenter.shared.reloadTimelines(ofKind: "nearby") }
        if NearbyShared.wanted || WidgetStore.slots.contains(where: { WidgetStore.slot($0).chosen == .nearby }) {
            WidgetCenter.shared.reloadTimelines(ofKind: "next")
            WidgetCenter.shared.reloadTimelines(ofKind: "places")
        }
    }

    static func skip(trip: String) async {
        guard let token = TokenStore.read() else { return }
        do {
            let a = try await Api(token: token, fast: true).signal(kind: "skipped", trip: trip)
            guard TokenStore.read() == token else { return }
            WidgetStore.keep(a)
            Reminders.clear()
            answered(a)
        } catch {
        }
    }

    static func shownKey(_ a: NextAnswer) -> String {
        let c = a.card
        let j = c?.journey
        return [
            a.label, a.mode, c?.phase, c?.title, c?.leaveBy, c?.line, c?.staleAt, c?.nextChangeAt, j?.leave, j?.bus?.svc, j?.bus?.board,
            j?.arrive, j?.live == true ? "live" : nil, c?.ride?.svc, c?.upcoming?.title, a.refreshAt, Lang.header,
        ]
        .map { $0 ?? "" }.joined(separator: "|")
    }

    private static func dayDue() -> Bool {
        let at = Shared.defaults.object(forKey: "widget.dayAt") as? Date
        guard let at, -at.timeIntervalSinceNow < 3600, let day = WidgetStore.day() else { return true }
        return day.date != OfflineDay.sgtDate(ServerClock.now)
    }

    private static func keepDay() async {
        guard let token = TokenStore.read() else { return }
        let loc = WidgetStore.location
        guard let (_, data, _) = try? await Api(token: token, fast: true).day(lat: loc?.lat, lon: loc?.lon, acc: loc?.acc),
            TokenStore.read() == token
        else { return }
        Shared.lastDay = data
        Shared.defaults.set(Date(), forKey: "widget.dayAt")
    }

    private static var countedAt: Date?

    private static func countWidgets() {
        if let countedAt, -countedAt.timeIntervalSinceNow < 600 { return }
        countedAt = Date()
        WidgetCenter.shared.getCurrentConfigurations { result in
            let all = (try? result.get()) ?? []
            Shared.defaults.set(all.count, forKey: "widgets.count")
            Shared.defaults.set(all.filter { $0.kind == "nearby" || $0.family == .systemLarge }.count, forKey: "widgets.nearby")
        }
    }
}
