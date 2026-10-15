import Foundation
import WidgetKit

/// Keeps everything outside the app in step with the plan: the widgets, the
/// Live Activity and the leave reminders, from every answer the app gets
/// (AppModel), a push brings, or the background refresh fetches.
@MainActor enum TripSync {
    /// The last plan the widgets were redrawn for, as they show it.
    private static var shown: String?

    static func answered(_ answer: NextAnswer) {
        // AppModel has kept the answer itself (Shared.lastAnswer); when it came is kept here.
        WidgetStore.answerAt = Date()
        WidgetStore.error = nil
        if let loc = Locator.shared.last {
            WidgetStore.saveLocation(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude, acc: loc.acc, at: loc.timestamp)
        }
        // Redrawn only when what they show has changed: a refresh every 30 s
        // mostly moves bus times the widgets don't show.
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

    /// A new language: the widgets redraw in it, whatever the next answer says.
    static func restyled() {
        shown = nil
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func signedIn() {
        shown = nil
        Push.signedIn()
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func signedOut() {
        // Called before the token goes: the server can still be told to stop pushing.
        Push.signedOut()
        Reminders.forget()
        WidgetStore.forget()
        shown = nil
        Task { await LiveTrip.endAll() }
        WidgetCenter.shared.reloadAllTimelines()
        Background.schedule()
    }

    /// The leave alerts or the Live Activity turned on or off in Settings.
    static func prefsChanged() {
        Task {
            await Push.checkPermission()
            let plan = WidgetStore.plan()?.0
            if let plan {
                Reminders.update(plan, checked: WidgetStore.answerAt.map { $0.addingTimeInterval(ServerClock.skew) } ?? ServerClock.now)
            } else {
                Reminders.clear()
            }
            await LiveTrip.update(plan)
            Push.sync(force: true)
            Background.schedule()
        }
    }

    /// Something outside the app shows the plan: a widget, the reminders or the Live Activity.
    static var followed: Bool {
        TripPrefs.leaveAlerts || TripPrefs.liveActivity || Shared.defaults.integer(forKey: "widgets.count") > 0
    }

    /// Fetches the plan with the app closed (a push, the background refresh)
    /// and lets everything outside the app follow it. True when it came.
    @discardableResult
    static func refresh(force: Bool) async -> Bool {
        guard followed || force else { return true }
        let before = WidgetStore.plan()?.0
        guard let a = await WidgetStore.refreshPlan(force: force) else {
            WidgetCenter.shared.reloadAllTimelines()
            return false
        }
        answered(a)
        // The day plan kept for offline, when it's another day's or over an hour old.
        if before?.dest?.label != a.dest?.label || dayDue() { await keepDay() }
        await WidgetStore.refreshChosen()
        return true
    }

    /// "Not going", from a reminder's button: the class taken off today, as
    /// the app's button does; then the reminders and the rest follow the new plan.
    static func skip(trip: String) async {
        guard let token = TokenStore.read() else { return }
        do {
            let a = try await Api(token: token, fast: true).signal(kind: "skipped", trip: trip)
            guard TokenStore.read() == token else { return }
            WidgetStore.keep(a)
            Reminders.clear()
            answered(a)
        } catch {
            // Left as it was: the app can be opened, or the button tried again.
        }
    }

    // MARK: helpers

    /// What the widgets show of an answer: they're redrawn when it changes.
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

    /// How many widgets are on the Home and Lock Screens, so the background
    /// refresh and push run only while something shows them. Asked at most every ten minutes.
    private static func countWidgets() {
        if let countedAt, -countedAt.timeIntervalSinceNow < 600 { return }
        countedAt = Date()
        WidgetCenter.shared.getCurrentConfigurations { result in
            let n = (try? result.get())?.count ?? 0
            Shared.defaults.set(n, forKey: "widgets.count")
        }
    }
}
