import SwiftUI
import WidgetKit

enum SettingsPage: Hashable {
    case trips, timetable, favourites, notifications, language, appearance, devices, account, feedback, about, licences

    var title: String {
        switch self {
        case .trips: L("Your trips")
        case .timetable: L("Timetable")
        case .favourites: L("Favourites")
        case .notifications: L("Notifications")
        case .language: L("Language and time")
        case .appearance: L("Appearance")
        case .devices: L("Devices")
        case .account: L("Account")
        case .feedback: L("Send feedback")
        case .about: L("About")
        case .licences: L("Licences")
        }
    }
}

@MainActor @Observable
final class SettingsModel {
    static let shared = SettingsModel()

    var path: [SettingsPage] = []
    var split = false

    static let firstPage = SettingsPage.trips

    var shown: SettingsPage { path.first ?? Self.firstPage }

    var chosen: SettingsPage? { split ? shown : nil }

    var pagesOver: Binding<[SettingsPage]> {
        Binding(get: { Array(self.path.dropFirst()) }, set: { self.path = [self.shown] + $0 })
    }

    func open(_ page: SettingsPage) {
        if split { path = [page] } else { path.append(page) }
    }

    private(set) var profile: ProfileDoc?
    private(set) var me: Me?
    private(set) var campus: Campus?
    private(set) var devices: [Device]?
    private(set) var choices: [TripChoice] = []
    private(set) var history = 0
    private(set) var message: String?
    private(set) var undo: (() -> Void)?
    private(set) var busy = false

    private(set) var importing = false
    private(set) var imported: ImportResult?
    private(set) var unplaced: [Unplaced] = []
    var sharedLink: String?

    var pairCode: String?

    private var app: AppModel { AppModel.shared }

    func refresh() async {
        guard let token = app.token else { return }
        let api = Api(token: token)
        do {
            let m = try await api.me()
            guard token == app.token else { return }
            me = m
            app.email = m.email
            app.anonymous = m.anonymous == true || m.email == nil
        } catch {
            if rejected(error, token) { return }
        }
        do {
            let (data, tag) = try await api.profileData()
            guard token == app.token, let p = ProfileDoc(data: data) else { return }
            if !saving {
                profile = p
                version = tag
                followAccount(p)
            }
        } catch {
            if rejected(error, token) { return }
            if profile == nil { say(failureMessage(error)) }
        }
        await loadCampus()
        await loadChoices()
        if app.email != nil { await loadDevices() }
    }

    func loadCampus() async {
        guard campus == nil else { return }
        do {
            let copy = try await CampusStore.shared.load(self, token: app.token) { [weak self] in
                if let c = $0.campus { self?.campus = c }
            }
            guard let c = copy.campus else { throw CampusCopy.unreadable }
            campus = c
        } catch is DecodingError {
            say(L("terminus sent something this version can't read."))
        } catch {
        }
    }

    func loadChoices() async {
        guard let token = app.token else { return }
        let session = app.session
        do {
            let c = try await Api(token: token).choices()
            guard app.session == session else { return }
            choices = c.choices
            history = c.history ?? 0
        } catch {
            _ = rejected(error, token)
        }
    }

    func loadDevices() async {
        guard let token = app.token else { return }
        let session = app.session
        do {
            let d = try await Api(token: token).devices()
            guard app.session == session else { return }
            devices = d
        } catch {
            if !rejected(error, token) { say(failureMessage(error)) }
        }
    }

    func reset() {
        saveTask?.cancel()
        saveTask = nil
        sending = nil
        epoch += 1
        path = []
        profile = nil
        version = nil
        pending = []
        me = nil
        devices = nil
        choices = []
        history = 0
        imported = nil
        unplaced = []
        pairCode = nil
        message = nil
        undo = nil
        busy = false
    }

    private var saveTask: Task<Void, Never>?
    private var sending: Task<Void, Never>?
    private var confirmed: ProfileDoc?
    private var version: String?
    private var pending: [(inout ProfileDoc) -> Void] = []
    private var epoch = 0
    private var saving: Bool { saveTask != nil || sending != nil || !pending.isEmpty }

    func edit(_ change: @escaping (inout ProfileDoc) -> Void) {
        guard var next = profile, app.token != nil else { return }
        if !saving { confirmed = profile }
        change(&next)
        pending.append(change)
        profile = next
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            saveTask = nil
            send()
        }
    }

    private func send() {
        guard sending == nil, !importing, !pending.isEmpty, let token = app.token, let base = confirmed else { return }
        let changes = pending
        pending = []
        var doc = base
        for change in changes { change(&doc) }
        let body = doc.data
        let from = version
        let mine = epoch
        sending = Task {
            do {
                let api = Api(token: token)
                var (data, tag): (Data, String?)
                do {
                    (data, tag) = try await api.saveProfileData(body, ifMatch: from)
                } catch let e as ApiError where e.status == 412 {
                    let (fresh, freshTag) = try await api.profileData()
                    guard mine == epoch else { return }
                    guard var latest = ProfileDoc(data: fresh) else { throw URLError(.cannotParseResponse) }
                    for change in changes { change(&latest) }
                    if latest.missed { say(L("A class was changed on another device. Check it and try again.")) }
                    (data, tag) = try await api.saveProfileData(latest.data, ifMatch: freshTag)
                }
                guard mine == epoch else { return }
                sending = nil
                guard let saved = ProfileDoc(data: data) else { return }
                version = tag
                let langSaved = saved.lang != confirmed?.lang
                confirmed = saved
                var shown = saved
                for change in pending { change(&shown) }
                profile = shown
                if langSaved {
                    Task {
                        await app.load(restart: true)
                        await app.loadDay()
                    }
                }
                if saveTask == nil { send() }
            } catch {
                guard mine == epoch else { return }
                sending = nil
                saveTask?.cancel()
                saveTask = nil
                pending = []
                if rejected(error, token) { return }
                if let confirmed { profile = confirmed }
                say(L("Not saved: %@", failureMessage(error)))
            }
        }
    }

    func setLang(_ pref: String) {
        guard pref != Prefs.shared.lang else { return }
        Shared.defaults.set(pref, forKey: Self.langNoted)
        edit { $0.lang = pref }
        Prefs.shared.lang = pref
    }

    func setClock(_ pref: String) {
        Prefs.shared.clock = pref
        edit { $0.clock = pref }
        WidgetCenter.shared.reloadAllTimelines()
        Task { await app.load(restart: true) }
    }

    private static let langNoted = "settings.langAccount"

    private func followAccount(_ p: ProfileDoc) {
        if Prefs.shared.clock != p.clock { Prefs.shared.clock = p.clock }
        let noted = Shared.defaults.string(forKey: Self.langNoted)
        let local = Prefs.shared.lang
        #if DEBUG
            if DevLaunch.langPinned, p.lang != local {
                Shared.defaults.set(local, forKey: Self.langNoted)
                edit { $0.lang = local }
                return
            }
        #endif
        if p.lang == "auto", local != "auto", noted == nil {
            Shared.defaults.set(local, forKey: Self.langNoted)
            edit { $0.lang = local }
        } else if p.lang != noted {
            Shared.defaults.set(p.lang, forKey: Self.langNoted)
            if p.lang != local { Prefs.shared.lang = p.lang }
        }
    }

    func importTimetable(_ link: String) {
        let share = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !share.isEmpty, !importing, let token = app.token else { return }
        if saveTask != nil {
            saveTask?.cancel()
            saveTask = nil
            send()
        }
        importing = true
        imported = nil
        let session = app.session
        Task {
            while let s = sending { await s.value }
            do {
                let r = try await Api(token: token).importTimetable(share)
                importing = false
                guard app.session == session else { return }
                imported = r
                unplaced = r.unplaced
                let saved = ProfileDoc(r.profile)
                confirmed = saved
                var shown = saved
                for change in pending { change(&shown) }
                profile = shown
                if saveTask == nil { send() }
                sharedLink = nil
                if let m = me {
                    me = Me(email: m.email, anonymous: m.anonymous, onboarding: m.onboarding, needsReimport: false, term: r.term)
                }
                announce(r.summary)
            } catch {
                importing = false
                guard app.session == session else { return }
                if rejected(error, token) { return }
                if saveTask == nil { send() }
                say(failureMessage(error))
            }
        }
    }

    func place(_ u: Unplaced, to: String) {
        let room = u.venue.split(separator: "-", maxSplits: 1).first.map(String.init) ?? u.venue
        edit {
            $0.addManual(
                ProfileTrip(
                    day: u.day, arriveByMin: u.arriveByMin, endMin: u.endMin, to: to, label: "\(u.module) @ \(room)", venue: u.venue))
        }
        skip(u)
    }

    func skip(_ u: Unplaced) { unplaced.removeAll { $0 == u } }

    func removePlace(_ key: String) {
        var removed: RemovedPlace?
        edit { removed = $0.removePlace(key: key) }
        guard let r = removed else { return }
        say(L("%@ removed from favourites", r.label)) { [weak self] in
            self?.edit { $0.restorePlace(r) }
        }
    }

    func undoChoice(_ c: TripChoice) {
        guard let token = app.token else { return }
        let session = app.session
        Task {
            do {
                try await Api(token: token).undoChoice(trip: c.trip, pref: c.pref)
                guard app.session == session else { return }
                choices.removeAll { $0 == c }
                await loadChoices()
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func clearHistory() {
        guard let token = app.token else { return }
        let session = app.session
        Task {
            do {
                try await Api(token: token).clearHistory()
                guard app.session == session else { return }
                history = 0
                say(L("Trip history cleared"))
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func newPairCode() {
        guard let token = app.token, !busy else { return }
        busy = true
        let session = app.session
        Task {
            defer { busy = false }
            do {
                let code = try await Api(token: token).pairCode()
                guard app.session == session else { return }
                pairCode = code
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func closePairCode() {
        pairCode = nil
        Task { await loadDevices() }
    }

    func removeDevice(_ d: Device) {
        guard let token = app.token else { return }
        let session = app.session
        Task {
            do {
                try await Api(token: token).removeDevice(d.id)
                guard app.session == session else { return }
                if d.current == true {
                    signedOut()
                } else {
                    await loadDevices()
                }
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func signOut() {
        reset()
        app.signOut()
    }

    func deleteAccount() {
        guard let token = app.token, !busy else { return }
        busy = true
        let session = app.session
        Task {
            defer { busy = false }
            do {
                try await Api(token: token).deleteAccount()
                guard app.session == session else { return }
                signedOut()
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func export() async -> Data? {
        guard let token = app.token else { return nil }
        do {
            let data = try await Api(token: token).export()
            let o = try JSONSerialization.jsonObject(with: data)
            return try JSONSerialization.data(withJSONObject: o, options: [.prettyPrinted, .sortedKeys])
        } catch {
            if !rejected(error, token) { say(failureMessage(error)) }
            return nil
        }
    }

    func sendFeedback(_ note: String) async -> String? {
        guard let token = app.token else { return nil }
        do {
            try await Api(token: token).feedback(note: note.trimmingCharacters(in: .whitespacesAndNewlines))
            return nil
        } catch {
            if rejected(error, token) { return nil }
            return failureMessage(error, otherwise: L("Couldn't send. Try again."))
        }
    }

    func say(_ text: String, undo: (() -> Void)? = nil) {
        message = text
        self.undo = undo
        announce(text)
    }

    func dismissMessage() {
        message = nil
        undo = nil
    }

    func undoLast() {
        let u = undo
        dismissMessage()
        u?()
    }

    private func signedOut() {
        reset()
        app.clearLocal()
    }

    private func rejected(_ error: Error, _ token: String) -> Bool {
        guard let e = error as? ApiError, e.status == 401 else { return false }
        guard token == app.token else { return true }
        reset()
        app.rejected(token, reason: signedOutHere)
        return true
    }
}
