import CoreLocation
import Foundation
import Observation
import UIKit
import UserNotifications

/// The setup of a new account, as the account page and the other apps ask
/// it: home, timetable, pace, then alerts and location. Edits the profile the
/// server keeps (`/api/me/profile`), kept as JSON so fields this version
/// doesn't know survive a save, shown at once and saved a moment later.
@MainActor @Observable
final class OnboardingModel {
    static let steps = 4

    /// Which step is showing, and which way the last move went (for the slide).
    var step = 0
    private(set) var forward = true

    private(set) var profile: [String: Any]?
    private(set) var campus: Campus?
    /// What went wrong, said under the step.
    var message: String?
    private(set) var importing = false
    private(set) var imported: ImportResult?
    /// Imported classes whose room couldn't be placed, until each gets a stop or is skipped.
    private(set) var unplaced: [Unplaced] = []
    /// The share link as typed, until it's imported.
    var link = ""
    /// "Pick the stop nearest me": what came of it.
    private(set) var locating: String?
    /// Leave alerts on: notifications allowed and asked for.
    private(set) var alertsOn = Shared.defaults.bool(forKey: OnboardingModel.alertsKey)
    private(set) var notificationsRefused = false

    /// The app-group setting the leave alerts follow (Push, Settings).
    nonisolated static let alertsKey = "leaveAlerts"

    private var api: Api { AppModel.shared.api }

    // MARK: loading

    func load() async {
        message = nil
        guard let token = AppModel.shared.token else { return }
        let session = AppModel.shared.session
        do {
            let loaded = try await Api(token: token).profile()
            guard AppModel.shared.session == session else { return }
            if !saving { profile = loaded }
            if link.isEmpty { link = share ?? "" }
            syncLang()
        } catch let e as ApiError where e.status == 401 {
            AppModel.shared.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
            return
        } catch {
            message = failureMessage(error)
            return
        }
        await loadCampus()
        await refreshAlerts()
    }

    func loadCampus() async {
        guard campus == nil else { return }
        do {
            campus = try await api.campus()
        } catch {
            // The home step offers to try again.
            message = failureMessage(error)
        }
    }

    /// A language picked on the welcome screen, before the account had one, goes to the account.
    private func syncLang() {
        let pref = Lang.pref
        guard (profile?["lang"] as? String ?? "auto") == "auto", pref != "auto" else { return }
        edit { $0["lang"] = pref }
    }

    // MARK: moving through

    func next() {
        guard step + 1 < Self.steps else { return }
        forward = true
        step += 1
    }

    func back() {
        guard step > 0 else { return }
        forward = false
        step -= 1
    }

    /// Setup finished or skipped: never shown again, on any device. What's
    /// waiting to be saved goes first, then Now asks for the plan.
    func finish() {
        if !(profile?["seen"] as? [String] ?? []).contains("onboarding") {
            edit {
                var seen = $0["seen"] as? [String] ?? []
                if !seen.contains("onboarding") { seen.append("onboarding") }
                $0["seen"] = seen
            }
        }
        AppModel.shared.needsSetup = false
        Task {
            await flush()
            await AppModel.shared.load(restart: true)
        }
    }

    // MARK: the profile's fields (as profile.ts names them)

    var homeStops: [String] { (profile?["home"] as? [String: Any])?["stops"] as? [String] ?? [] }
    var homeWalkMin: Int { profile?["homeWalkMin"] as? Int ?? 5 }
    var walkPace: String { profile?["walkPace"] as? String ?? "normal" }
    var fullBusMargin: Bool { profile?["fullBusMargin"] as? Bool ?? true }
    /// auto (each device's own), 12 or 24.
    var clock: String { profile?["clock"] as? String ?? "auto" }
    var share: String? { profile?["share"] as? String }

    /// The residence whose stops are the home stops, if they're exactly one's.
    /// The common ones come first, so stops several share (UTown) find the likelier.
    var residence: Campus.Residence? { campus?.residences.first { $0.stops == homeStops } }

    /// The account's limits, as the server sends them with the profile; today's until it does.
    var walkRange: ClosedRange<Int> {
        if let w = (profile?["limits"] as? [String: Any])?["homeWalkMin"] as? [String: Any], let lo = w["min"] as? Int,
            let hi = w["max"] as? Int, lo <= hi
        {
            return lo...hi
        }
        return 0...30
    }

    func setResidence(_ r: Campus.Residence) {
        let walk = min(walkRange.upperBound, max(walkRange.lowerBound, r.minutes))
        let stops = r.stops
        edit {
            $0["home"] = ["stops": stops]
            $0["homeWalkMin"] = walk
        }
    }

    /// Up to three, each once, in order; none clears the home.
    func setHomeStops(_ stops: [String]) {
        var unique: [String] = []
        for s in stops where !unique.contains(s) { unique.append(s) }
        let home = Array(unique.prefix(3))
        edit { $0["home"] = home.isEmpty ? NSNull() : ["stops": home] }
    }

    /// The home stop picker: `code` first, the other stops after it.
    func setFirstHomeStop(_ code: String) {
        setHomeStops([code] + homeStops.dropFirst().filter { $0 != code })
    }

    func setHomeWalk(_ min: Int) {
        let walk = Swift.min(walkRange.upperBound, Swift.max(walkRange.lowerBound, min))
        edit { $0["homeWalkMin"] = walk }
    }

    func setPace(_ pace: String) { edit { $0["walkPace"] = pace } }
    func setFullBusMargin(_ on: Bool) { edit { $0["fullBusMargin"] = on } }

    /// 12- or 24-hour times on every device; this phone's at once.
    func setClock(_ pref: String) {
        Prefs.shared.clock = pref
        edit { $0["clock"] = pref }
    }

    /// "Pick the stop nearest me": the stop nearest the phone made the first
    /// of the home stops (the rest kept after it).
    func pickNearest() async {
        guard let campus else { return }
        locating = L("Finding the nearest stop…")
        guard let loc = await Locator.shared.fix(maxAge: 120), let near = Self.nearest(campus.stops, to: loc.coordinate) else {
            locating = L("Couldn't get your location. Choose your stop instead.")
            return
        }
        setHomeStops([near.code] + homeStops.filter { $0 != near.code })
        locating = L("Picked %@. Change it if you use a different stop.", near.name)
    }

    nonisolated static func nearest(_ stops: [Campus.Stop], to c: CLLocationCoordinate2D) -> Campus.Stop? {
        stops.filter { $0.lat != nil && $0.lon != nil }.min { a, b in
            func d(_ s: Campus.Stop) -> Double {
                let dLat = s.lat! - c.latitude
                let dLon = (s.lon! - c.longitude) * cos(c.latitude * .pi / 180)
                return dLat * dLat + dLon * dLon
            }
            return d(a) < d(b)
        }
    }

    // MARK: saving

    /// The 0.4 s wait before a save, so a run of taps goes as one.
    private var saveTask: Task<Void, Never>?
    /// The save on its way. Never cancelled: whether it saved is only known from its answer.
    private var sending: Task<Void, Never>?
    /// The changes made since the last save was sent, shown already, to send next.
    private var pending: [@Sendable (inout [String: Any]) -> Void] = []
    /// The profile as the server last had it, to go back to if a save fails.
    private var confirmed: [String: Any]?
    /// Whether a change is waiting or on its way: the profile shown is ahead of the server's.
    private var saving: Bool { saveTask != nil || sending != nil || !pending.isEmpty }

    /// Shown at once, saved a moment later (a run of taps is one save, as on
    /// the web), put back with the reason if the server refuses.
    func edit(_ change: @escaping @Sendable (inout [String: Any]) -> Void) {
        // While an import runs, its answer replaces the profile: an edit now
        // would save the old timetable over it.
        guard let current = profile, !importing, AppModel.shared.token != nil else { return }
        if !saving { confirmed = current }
        var next = current
        change(&next)
        profile = next
        pending.append(change)
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            saveTask = nil
            send()
        }
    }

    /// Sends the changes waiting, made again on the profile as the server has
    /// it now (If-Match), so what another device saved since setup loaded
    /// stays. One save at a time: changes made meanwhile go next.
    private func send() {
        guard sending == nil, !pending.isEmpty, let token = AppModel.shared.token else { return }
        let changes = pending
        pending = []
        let session = AppModel.shared.session
        sending = Task {
            do {
                let saved = try await Api(token: token).changeProfile { p in
                    for change in changes { change(&p) }
                }
                guard AppModel.shared.session == session else { return }
                sending = nil
                confirmed = saved
                // Changes made since this was sent stay on screen, on top of what it saved.
                var shown = saved
                for change in pending { change(&shown) }
                profile = shown
                message = nil
                if saveTask == nil { send() }
            } catch {
                guard AppModel.shared.session == session else { return }
                sending = nil
                saveTask?.cancel()
                saveTask = nil
                pending = []
                if let e = error as? ApiError, e.status == 401 {
                    AppModel.shared.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
                    return
                }
                if let confirmed { profile = confirmed }
                message = L("Not saved: %@", failureMessage(error))
            }
        }
    }

    /// Sends what's waiting now, and returns once every save has its answer.
    private func flush() async {
        if saveTask != nil {
            saveTask?.cancel()
            saveTask = nil
            send()
        }
        while let s = sending { await s.value }
    }

    // MARK: the timetable

    /// A class as the profile keeps it, imported (`trips`) or added by hand (`manual`).
    struct Class: Identifiable, Hashable {
        let id: String
        let day: Int
        let arriveByMin: Int
        let to: String
        let label: String
        let venue: String
    }

    var classes: [Class] {
        ["trips", "manual"].flatMap { list in
            (profile?[list] as? [[String: Any]] ?? []).enumerated().compactMap { i, c -> Class? in
                guard let day = c["day"] as? Int, let at = c["arriveByMin"] as? Int, let to = c["to"] as? String else { return nil }
                return Class(
                    id: "\(list)-\(i)", day: day, arriveByMin: at, to: to, label: c["label"] as? String ?? "",
                    venue: c["venue"] as? String ?? "")
            }
        }
    }

    var importedClasses: Int { (profile?["trips"] as? [Any])?.count ?? 0 }

    /// A link typed or pasted but not yet imported: Continue imports it first.
    var linkPending: Bool {
        let l = link.trimmingCharacters(in: .whitespacesAndNewlines)
        return !l.isEmpty && l != share
    }

    /// Imports the link; true when it worked.
    @discardableResult
    func importTimetable() async -> Bool {
        let share = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !share.isEmpty, !importing else { return false }
        importing = true
        imported = nil
        message = nil
        defer { importing = false }
        // A setting's save still waiting would land after the import and put
        // the old timetable back: it goes first.
        await flush()
        let session = AppModel.shared.session
        do {
            let r = try await api.importTimetable(share)
            guard AppModel.shared.session == session else { return false }
            imported = r
            profile = r.profile
            unplaced = r.unplaced
            return true
        } catch {
            message = failureMessage(error)
            return false
        }
    }

    /// An unplaced class given a stop: added by hand there, as the account page does.
    func place(_ u: Unplaced, to: String) {
        let room = u.venue.split(separator: "-").first.map(String.init) ?? u.venue
        edit {
            var list = $0["manual"] as? [[String: Any]] ?? []
            var c: [String: Any] = [
                "day": u.day, "arriveByMin": u.arriveByMin, "to": to, "label": "\(u.module) @ \(room)", "venue": u.venue,
            ]
            if let end = u.endMin { c["endMin"] = end }
            list.append(c)
            $0["manual"] = list
        }
        skip(u)
    }

    func skip(_ u: Unplaced) { unplaced.removeAll { $0 == u } }

    // MARK: alerts and location

    /// Whether this phone already lets terminus notify, and whether it was refused.
    func refreshAlerts() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        notificationsRefused = status == .denied
        if status != .authorized && status != .provisional && status != .ephemeral { alertsOn = false }
    }

    /// "Turn on leave alerts": asks once; refused before, only Settings can change it.
    func turnOnAlerts() async {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings().authorizationStatus
        if status == .denied {
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { await UIApplication.shared.open(url) }
            return
        }
        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
        notificationsRefused = !granted
        guard granted else { return }
        alertsOn = true
        Shared.defaults.set(true, forKey: Self.alertsKey)
        // The server sends the leave-by as a push: this phone's address goes to it (Push).
        UIApplication.shared.registerForRemoteNotifications()
    }
}

/// "9:38 AM" or "09:38" for `min` minutes past midnight, in the account's
/// 12- or 24-hour style, as the server writes times (Android's minuteClock).
func setupClock(_ min: Int, hour12: Bool = Clock.hour12) -> String {
    let h = min / 60
    let m = min % 60
    guard hour12 else { return String(format: "%02d:%02d", h, m) }
    let h12 = h % 12 == 0 ? 12 : h % 12
    let time = m == 0 ? "\(h12)" : String(format: "%d:%02d", h12, m)
    return h < 12 ? L("%@ AM", time) : L("%@ PM", time)
}

/// "Mon", "周一": day 0 is Sunday, as the profile keeps it.
func setupDay(_ day: Int) -> String {
    [L("Sun"), L("Mon"), L("Tue"), L("Wed"), L("Thu"), L("Fri"), L("Sat")][((day % 7) + 7) % 7]
}
