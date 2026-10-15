import SwiftUI
import WidgetKit

/// Settings' pages, in the order the list shows them.
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

/// Everything Settings shows about the account rather than the answer: the
/// profile, devices, trip choices, the campus for the pickers. One for the
/// app, so a page stays open and filled in when the language changes and
/// the app redraws. Every edit is shown at once and saved a moment later, so
/// a run of taps is one save, as on Android (AccountViewModel); a refusal
/// puts back what the server has, with its reason.
@MainActor @Observable
final class SettingsModel {
    static let shared = SettingsModel()

    /// The pages open, on top of the list.
    var path: [SettingsPage] = []

    private(set) var profile: ProfileDoc?
    private(set) var me: Me?
    private(set) var campus: Campus?
    private(set) var devices: [Device]?
    private(set) var choices: [TripChoice] = []
    private(set) var history = 0
    /// Something to say once, at the foot: a save that failed, data exported.
    private(set) var message: String?
    /// With `message`, Undo beside it.
    private(set) var undo: (() -> Void)?
    private(set) var busy = false

    // MARK: the timetable

    private(set) var importing = false
    private(set) var imported: ImportResult?
    /// Imported classes whose room couldn't be placed, until each gets a stop or is skipped.
    private(set) var unplaced: [Unplaced] = []
    /// A NUSMods link shared into the app, waiting in Timetable's field.
    var sharedLink: String?

    /// The pairing code on screen, for another device.
    var pairCode: String?

    private var app: AppModel { AppModel.shared }

    // MARK: loading

    /// Who this phone is, the profile and the rest: on opening Settings, and on coming back to it.
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
            // A change still being saved stays on screen.
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
            campus = try await Api(token: app.token).campus()
        } catch is DecodingError {
            say(L("terminus sent something this version can't read."))
        } catch {
            // Offline: the pickers try again when they open.
        }
    }

    func loadChoices() async {
        guard let token = app.token else { return }
        do {
            let c = try await Api(token: token).choices()
            choices = c.choices
            history = c.history ?? 0
        } catch {
            _ = rejected(error, token)
        }
    }

    func loadDevices() async {
        guard let token = app.token else { return }
        do {
            devices = try await Api(token: token).devices()
        } catch {
            if !rejected(error, token) { say(failureMessage(error)) }
        }
    }

    /// Signed out: nothing of the account stays.
    func reset() {
        saveTask?.cancel()
        saveTask = nil
        // Its answer is dropped; the request itself goes on, as it may have saved.
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

    // MARK: editing the profile

    /// The 0.4 s wait before a save, so a run of taps goes as one.
    private var saveTask: Task<Void, Never>?
    /// The save on its way to the server. Never cancelled: whether it saved
    /// is only known from its answer, and a change sent must not be made twice.
    private var sending: Task<Void, Never>?
    /// The profile as the server last had it, to go back to if a save fails.
    private var confirmed: ProfileDoc?
    /// Its version (the ETag): a save is refused (412) if the profile was saved
    /// elsewhere since, a pin on Buses, a favourite from the map, another device.
    private var version: String?
    /// The changes made since the last save was sent, shown already, to send next.
    private var pending: [(inout ProfileDoc) -> Void] = []
    /// Moves on with each import and sign-out: a save's answer from before one is dropped.
    private var epoch = 0
    /// Whether a change is waiting or on its way: the profile shown is ahead of the server's.
    private var saving: Bool { saveTask != nil || sending != nil || !pending.isEmpty }

    /// Changes the profile: shown now, saved 0.4 s later with any taps since.
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

    /// Sends the changes waiting, made on the profile as the server last had
    /// it. One save at a time: changes made meanwhile wait for its answer and
    /// go next, on what it saved.
    private func send() {
        guard sending == nil, !pending.isEmpty, let token = app.token, let base = confirmed else { return }
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
                    // Saved elsewhere meanwhile, and so not by this request:
                    // its changes, made again on that.
                    let (fresh, freshTag) = try await api.profileData()
                    guard mine == epoch else { return }
                    guard var latest = ProfileDoc(data: fresh) else { throw URLError(.cannotParseResponse) }
                    for change in changes { change(&latest) }
                    // A class changed elsewhere isn't changed here instead of its neighbour.
                    if latest.missed { say(L("A class was changed on another device. Check it and try again.")) }
                    (data, tag) = try await api.saveProfileData(latest.data, ifMatch: freshTag)
                }
                guard mine == epoch else { return }
                sending = nil
                guard let saved = ProfileDoc(data: data) else { return }
                version = tag
                // The server writes the card and the day in the account's language,
                // not the one asked in: what came between the switch and now is in the old one.
                let langSaved = saved.lang != confirmed?.lang
                confirmed = saved
                // Changes made since this was sent stay on screen, on top of what it saved.
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

    // MARK: language and time

    /// Settings › Language: this phone, and the account, so the Mac, the web and emails follow.
    func setLang(_ pref: String) {
        guard pref != Prefs.shared.lang else { return }
        Shared.defaults.set(pref, forKey: Self.langNoted)
        edit { $0.lang = pref }
        Prefs.shared.lang = pref
    }

    /// 12- or 24-hour times on every device; the card and widgets redraw in it.
    func setClock(_ pref: String) {
        Prefs.shared.clock = pref
        edit { $0.clock = pref }
        WidgetCenter.shared.reloadAllTimelines()
        Task { await app.load(restart: true) }
    }

    /// The account's language as this phone last saw it, to tell a change made elsewhere.
    private static let langNoted = "settings.langAccount"

    /// The account's language and clock on this phone: a language picked here
    /// before the account had one goes to the account; one chosen on another
    /// device since is applied here.
    private func followAccount(_ p: ProfileDoc) {
        if Prefs.shared.clock != p.clock { Prefs.shared.clock = p.clock }
        let noted = Shared.defaults.string(forKey: Self.langNoted)
        let local = Prefs.shared.lang
        #if DEBUG
            // A test's TERMINUS_LANG is what it's testing: it goes to the account, not the other way.
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

    // MARK: the timetable

    func importTimetable(_ link: String) {
        let share = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !share.isEmpty, !importing, let token = app.token else { return }
        importing = true
        imported = nil
        Task {
            defer { importing = false }
            do {
                let r = try await Api(token: token).importTimetable(share)
                saveTask?.cancel()
                saveTask = nil
                sending = nil
                epoch += 1
                imported = r
                unplaced = r.unplaced
                profile = ProfileDoc(r.profile)
                pending = []
                // The import saved a new version; the next edit fetches it on a clash.
                sharedLink = nil
                if let m = me {
                    me = Me(email: m.email, anonymous: m.anonymous, onboarding: m.onboarding, needsReimport: false, term: r.term)
                }
                announce(r.summary)
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    /// An unplaced class given a stop: added by hand there, as the account page does.
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

    // MARK: favourites

    /// Off the list, with Undo at the foot.
    func removePlace(_ key: String) {
        var removed: RemovedPlace?
        edit { removed = $0.removePlace(key: key) }
        guard let r = removed else { return }
        say(L("%@ removed from favourites", r.label)) { [weak self] in
            self?.edit { $0.restorePlace(r) }
        }
    }

    // MARK: trips

    func undoChoice(_ c: TripChoice) {
        guard let token = app.token else { return }
        Task {
            do {
                try await Api(token: token).undoChoice(trip: c.trip, pref: c.pref)
                choices.removeAll { $0 == c }
                await loadChoices()
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    func clearHistory() {
        guard let token = app.token else { return }
        Task {
            do {
                try await Api(token: token).clearHistory()
                history = 0
                say(L("Trip history cleared"))
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    // MARK: devices

    func newPairCode() {
        guard let token = app.token, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                pairCode = try await Api(token: token).pairCode()
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
        Task {
            do {
                try await Api(token: token).removeDevice(d.id)
                if d.current == true {
                    // This phone's session went with it: signed out here too.
                    signedOut()
                } else {
                    await loadDevices()
                }
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    // MARK: the account

    func signOut() {
        reset()
        app.signOut()
    }

    /// For an account with no email: everything goes, then the app starts over.
    func deleteAccount() {
        guard let token = app.token, !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await Api(token: token).deleteAccount()
                signedOut()
            } catch {
                if !rejected(error, token) { say(failureMessage(error)) }
            }
        }
    }

    /// "Download my data": the export, pretty-printed as Android saves it, so it reads in any text editor.
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

    // MARK: feedback

    /// Sends a note; nil once it's gone, else what went wrong.
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

    // MARK: saying things

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

    /// A 401 for this phone's own token signs it out, and the welcome screen says why. True when it did.
    private func rejected(_ error: Error, _ token: String) -> Bool {
        guard let e = error as? ApiError, e.status == 401 else { return false }
        reset()
        app.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
        return true
    }
}
