import CoreLocation
import Foundation
import Observation
import UIKit
import UserNotifications

@MainActor @Observable
final class OnboardingModel {
    static let steps = 4

    var step = 0
    private(set) var forward = true

    var profile: [String: Any]? { saver.doc?.json }
    private(set) var campus: Campus?
    var message: String?
    private(set) var importing = false
    private(set) var imported: ImportResult?
    private(set) var unplaced: [Unplaced] = []
    var link = ""
    private(set) var locating: String?
    private(set) var alertsOn = Shared.defaults.bool(forKey: OnboardingModel.alertsKey)
    private(set) var notificationsRefused = false

    nonisolated static let alertsKey = "leaveAlerts"

    private var api: Api { AppModel.shared.api }

    @ObservationIgnored private lazy var saver: ProfileSaver = {
        let s = ProfileSaver()
        s.say = { [weak self] in self?.message = $0 }
        s.onSaved = { [weak self] _, _ in self?.message = nil }
        s.onRejected = { AppModel.shared.rejected($0, reason: signedOutHere) }
        return s
    }()

    func load() async {
        message = nil
        guard let token = AppModel.shared.token else { return }
        let session = AppModel.shared.session
        do {
            let (data, tag) = try await Api(token: token).profileData()
            guard AppModel.shared.session == session else { return }
            guard let loaded = ProfileDoc(data: data) else { throw URLError(.cannotParseResponse) }
            saver.loaded(loaded, tag: tag)
            if link.isEmpty { link = share ?? "" }
            syncLang()
        } catch let e as ApiError where e.status == 401 {
            AppModel.shared.rejected(token, reason: signedOutHere)
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
            let copy = try await CampusStore.shared.load(self, token: AppModel.shared.token) { [weak self] in
                if let c = $0.campus { self?.campus = c }
            }
            guard let c = copy.campus else { throw CampusCopy.unreadable }
            campus = c
        } catch {
            message = failureMessage(error)
        }
    }

    private func syncLang() {
        let pref = Lang.pref
        guard (profile?["lang"] as? String ?? "auto") == "auto", pref != "auto" else { return }
        edit { $0["lang"] = pref }
    }

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

    var homeStops: [String] { (profile?["home"] as? [String: Any])?["stops"] as? [String] ?? [] }
    var homeWalkMin: Int { profile?["homeWalkMin"] as? Int ?? 5 }
    var walkPace: String { profile?["walkPace"] as? String ?? "normal" }
    var fullBusMargin: Bool { profile?["fullBusMargin"] as? Bool ?? true }
    var clock: String { profile?["clock"] as? String ?? "auto" }
    var share: String? { profile?["share"] as? String }

    var residence: Campus.Residence? { campus?.residences.first { $0.stops == homeStops } }

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

    func setHomeStops(_ stops: [String]) {
        var unique: [String] = []
        for s in stops where !unique.contains(s) { unique.append(s) }
        let home = Array(unique.prefix(3))
        edit { $0["home"] = home.isEmpty ? NSNull() : ["stops": home] }
    }

    func setFirstHomeStop(_ code: String) {
        setHomeStops([code] + homeStops.dropFirst().filter { $0 != code })
    }

    func setHomeWalk(_ min: Int) {
        let walk = Swift.min(walkRange.upperBound, Swift.max(walkRange.lowerBound, min))
        edit { $0["homeWalkMin"] = walk }
    }

    func setPace(_ pace: String) { edit { $0["walkPace"] = pace } }
    func setFullBusMargin(_ on: Bool) { edit { $0["fullBusMargin"] = on } }

    func setClock(_ pref: String) {
        Prefs.shared.clock = pref
        edit { $0["clock"] = pref }
    }

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

    func edit(_ change: @escaping (inout [String: Any]) -> Void) {
        guard !importing else { return }
        saver.edit { change(&$0.json) }
    }

    private func flush() async { await saver.flush() }

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

    var linkPending: Bool {
        let l = link.trimmingCharacters(in: .whitespacesAndNewlines)
        return !l.isEmpty && l != share
    }

    @discardableResult
    func importTimetable() async -> Bool {
        let share = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !share.isEmpty, !importing else { return false }
        importing = true
        imported = nil
        message = nil
        defer { importing = false }
        await flush()
        let session = AppModel.shared.session
        do {
            let r = try await api.importTimetable(share)
            guard AppModel.shared.session == session else { return false }
            imported = r
            saver.adopt(ProfileDoc(r.profile))
            unplaced = r.unplaced
            return true
        } catch {
            message = failureMessage(error)
            return false
        }
    }

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

    func refreshAlerts() async {
        let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        notificationsRefused = status == .denied
        if status != .authorized && status != .provisional && status != .ephemeral { alertsOn = false }
    }

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
        UIApplication.shared.registerForRemoteNotifications()
    }
}

func setupClock(_ min: Int, hour12: Bool = Clock.hour12) -> String {
    let h = min / 60
    let m = min % 60
    guard hour12 else { return String(format: "%02d:%02d", h, m) }
    let h12 = h % 12 == 0 ? 12 : h % 12
    let time = m == 0 ? "\(h12)" : String(format: "%d:%02d", h12, m)
    return h < 12 ? L("%@ AM", time) : L("%@ PM", time)
}

func setupDay(_ day: Int) -> String {
    [L("Sun"), L("Mon"), L("Tue"), L("Wed"), L("Thu"), L("Fri"), L("Sat")][((day % 7) + 7) % 7]
}
