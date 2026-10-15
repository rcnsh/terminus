import SwiftUI
import UIKit

/// The app's state: who this phone is signed in as, and what Now shows. The
/// other tabs keep their own (BusesModel, MapModel, SettingsModel) and ask
/// here for the token.
///
/// Every answer comes from the server, worded; the app only counts down. The
/// plan is fetched every 30 s while Now is on screen ([pollS]), and kept in
/// the app group for the widgets and the Live Activity (TripSync).
@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    // MARK: the session

    /// Signed in on this phone (anonymously or with an email).
    private(set) var paired: Bool
    /// An account without an email: Settings offers to add one.
    var anonymous: Bool { didSet { Shared.defaults.set(anonymous, forKey: "anonymous") } }
    /// The account's email, once known.
    var email: String? { didSet { Shared.defaults.set(email, forKey: "email") } }
    /// The account hasn't finished its setup: onboarding shows.
    var needsSetup: Bool { didSet { Shared.defaults.set(needsSetup, forKey: "needsSetup") } }
    /// Why this phone was signed out, said once on the welcome screen.
    var signedOutReason: String?
    /// Changes with every sign-in and sign-out: a request from before one is dropped.
    private(set) var session = 0

    var token: String? { paired ? TokenStore.read() : nil }
    var api: Api { Api(token: token) }

    // MARK: Now

    var target: Target = .plan
    var showNearby = false
    /// The last answer per view, so switching views never blanks the screen.
    private(set) var answers: [Target: NextAnswer] = [:]
    var answer: NextAnswer? { answers[target] }
    var plan: NextAnswer? { answers[.plan] }
    private(set) var nearby: [NearbyStop]?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var fetchedAt: Date?
    private(set) var places: [Place] = []
    /// Places added from "Go somewhere else", a tab each until removed.
    private(set) var added: [Added] = Added.load()
    private(set) var destinations: [Destination] = []
    /// Today's timeline, under the planned answer.
    private(set) var day: DayPlan?
    private var dayFetched: Date?
    /// Just taken off Today: its row says so where it was, with Undo (or why it didn't go).
    private(set) var removed: Removed?
    /// A card button's signal on its way.
    private(set) var signalling = false
    /// The server no longer serves this version (426).
    private(set) var updateRequired = Outdated.required
    /// When each view's answer last came back, for a pull sooner than [Pull.freshS] to ask nothing.
    private var answeredAt: [String: Date] = [:]

    struct Added: Codable, Hashable, Identifiable {
        let code: String
        let label: String
        var id: String { code }
        static let max = 5
        static func load() -> [Added] {
            Shared.defaults.data(forKey: "added").flatMap { try? JSONDecoder().decode([Added].self, from: $0) } ?? []
        }
    }

    /// An entry just taken off Today, kept in its place as a row saying so.
    struct Removed {
        let item: DayPlan.Item
        let at: Int
        let before: String?
        var failed = false
    }

    /// A stop to show on the Buses tab, picked elsewhere (Now's Nearby, a
    /// widget): Buses shows it and sets this back to nil.
    var openStop: String?

    // MARK: "Is this wrong?"

    var reportSending = false
    var reportResult: String?
    var reportSent = false

    init() {
        let token = TokenStore.read()
        paired = token != nil
        anonymous = Shared.defaults.bool(forKey: "anonymous")
        email = Shared.defaults.string(forKey: "email")
        needsSetup = Shared.defaults.bool(forKey: "needsSetup")
        // The last plan this phone was shown, while it still holds: drawn at
        // once on opening the app, then refreshed.
        if paired, let data = Shared.lastAnswer, let a = try? NextAnswer.decode(data), !a.isOld(at: ServerClock.now) {
            answers[.plan] = a
            places = a.places
        }
        if paired, let data = Shared.lastDay, let d = try? JSONDecoder().decode(DayPlan.self, from: data) { day = d }
    }

    // MARK: signing in and out

    /// A token was just stored (a new account, a sign-in, a pairing): start showing answers.
    func signedIn(token: String, anonymous: Bool, email: String? = nil, needsSetup: Bool = false) {
        TokenStore.save(token)
        session += 1
        paired = true
        self.anonymous = anonymous
        self.email = email
        self.needsSetup = needsSetup
        signedOutReason = nil
        answers = [:]
        day = nil
        nearby = nil
        error = nil
        target = .plan
        showNearby = false
        TripSync.signedIn()
        Task { await load(restart: true) }
        Task { await refreshMe() }
    }

    /// Signed out here: local state goes first, so the screen reacts at once
    /// even offline; the server is told when it can be.
    func signOut() {
        let token = TokenStore.read()
        clearLocal()
        if let token { Task.detached { try? await Api(token: token).logout() } }
    }

    /// The server refused the token (401) while it was still this phone's.
    func rejected(_ token: String, reason: String) {
        guard TokenStore.read() == token else { return }
        clearLocal()
        signedOutReason = reason
    }

    /// Everything the account left on this phone.
    func clearLocal() {
        TripSync.signedOut()
        TokenStore.clear()
        session += 1
        paired = false
        anonymous = false
        email = nil
        needsSetup = false
        answers = [:]
        nearby = nil
        day = nil
        removed = nil
        places = []
        setAdded([])
        destinations = []
        error = nil
        fetchedAt = nil
        answeredAt = [:]
        Shared.lastAnswer = nil
        Shared.lastDay = nil
        Shared.lastNearby = nil
    }

    /// Who this phone is, from the server: the email, and whether setup is done.
    func refreshMe() async {
        guard let token else { return }
        let gen = session
        do {
            let me = try await Api(token: token).me()
            guard gen == session else { return }
            email = me.email
            anonymous = me.anonymous == true || me.email == nil
            needsSetup = me.onboarding != nil
        } catch let e as ApiError where e.status == 401 {
            rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
        } catch {}
    }

    // MARK: Now

    func select(_ picked: Target) {
        // Somewhere that's a favourite already is that favourite's tab.
        var t = picked
        if case .code(_, let label) = picked, let p = places.first(where: { $0.label.caseInsensitiveCompare(label) == .orderedSame }) {
            t = .place(key: p.key)
        }
        if case .code(let code, let label) = t, !added.contains(where: { $0.code == code }),
            !places.contains(where: { $0.label.caseInsensitiveCompare(label) == .orderedSame })
        {
            setAdded(Array(([Added(code: code, label: label)] + added).prefix(Added.max)))
        }
        target = t
        showNearby = false
        error = nil
        Task { await load(restart: true) }
    }

    func selectNearby() {
        showNearby = true
        error = nil
        Task { await load(restart: true) }
    }

    /// The X on an added place's tab: gone; showing it, back to Next.
    func removeAdded(_ a: Added) {
        setAdded(added.filter { $0.code != a.code })
        if case .code(let code, _) = target, code == a.code {
            if showNearby { target = .plan } else { select(.plan) }
        }
    }

    private func setAdded(_ list: [Added]) {
        guard list != added else { return }
        added = list
        Shared.defaults.set(try? JSONEncoder().encode(list), forKey: "added")
    }

    private var loadTask: Task<Void, Never>?
    private var loadID = 0

    /// Fetches whatever is on screen. Only one runs; `restart` drops one in
    /// flight, so a newly chosen view loads now rather than after the old one.
    func load(restart: Bool = false) async {
        guard let token else { return }
        if loadTask != nil {
            if !restart {
                await loadTask?.value
                return
            }
            loadTask?.cancel()
        }
        loadID += 1
        let id = loadID
        let task = Task { await fetch(token: token) }
        loadTask = task
        await task.value
        if loadID == id { loadTask = nil }
    }

    private func fetch(token: String) async {
        let gen = session
        loading = true
        defer { if gen == session { loading = false } }
        let loc = await Locator.shared.fix()
        let api = Api(token: token)
        let nearbyView = showNearby
        let t = target
        do {
            if nearbyView {
                let (stops, data) = try await api.nearby(lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
                guard gen == session, !Task.isCancelled else { return }
                Shared.lastNearby = data
                nearby = stops
                answeredAt["nearby"] = Date()
            } else {
                let a = try await api.next(t, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
                guard gen == session, !Task.isCancelled else { return }
                if t == .plan {
                    let before = answers[.plan]
                    Shared.lastAnswer = a.raw
                    TripSync.answered(a)
                    // The timeline moves when the answer's trip does, and when it's over two minutes old.
                    if day == nil || (dayFetched.map { -$0.timeIntervalSinceNow > 120 } ?? true) || before?.dest?.label != a.dest?.label
                        || before?.phase != a.phase
                    {
                        Task { await loadDay() }
                    }
                }
                answers[t] = a
                places = a.places
                answeredAt[key(t)] = Date()
            }
            fetchedAt = Date()
            error = nil
            updateRequired = false
        } catch is CancellationError {
        } catch let e as ApiError {
            guard gen == session else { return }
            if e.updateRequired {
                updateRequired = true
                error = nil
            } else if e.status == 401 {
                rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
            } else {
                error = e.message
            }
        } catch is DecodingError {
            if gen == session { error = L("Unexpected response from terminus") }
        } catch {
            if gen == session, (error as? URLError)?.code != .cancelled { self.error = L("Offline") }
        }
    }

    private func key(_ t: Target) -> String {
        switch t {
        case .plan: "plan"
        case .place(let k): "place:\(k)"
        case .code(let c, _): "stop:\(c)"
        }
    }

    /// Pulled down: what's on screen asked for again, unless it came back in
    /// the last few seconds (the server would send the same). True when it's fresh.
    func pull() async -> Bool {
        let k = showNearby ? "nearby" : key(target)
        if let at = answeredAt[k], -at.timeIntervalSinceNow < 10 { return true }
        let start = Date()
        await load()
        return (answeredAt[k] ?? .distantPast) >= start
    }

    /// Today's timeline; kept as it was when offline.
    func loadDay() async {
        guard let token else { return }
        let gen = session
        let loc = Locator.shared.last
        do {
            let (d, data) = try await Api(token: token).day(lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
            guard gen == session else { return }
            day = d
            dayFetched = Date()
            Shared.lastDay = data
        } catch {}
    }

    /// A card button: "Not going", "Not on campus today", "Back on campus" or
    /// "Undo". "Not going" is the × on Today by another name, so it goes the same way.
    func signal(_ action: CardAction) {
        guard let token else { return }
        if action.id == "skipped", let item = day?.items.first(where: { $0.key == action.trip }) {
            removeFromToday(item)
            return
        }
        guard !signalling else { return }
        signalling = true
        error = nil
        let gen = session
        Task {
            defer { if gen == session { signalling = false } }
            do {
                let a = try await Api(token: token).signal(action)
                guard gen == session else { return }
                applyPlan(a)
                await loadDay()
            } catch let e as ApiError {
                if e.status == 401 {
                    rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
                } else {
                    error = e.message
                }
            } catch {
                self.error = L("Offline")
            }
        }
    }

    /// "Leave earlier" or "No thanks" on a suggestion; the card then comes back without it.
    func choose(_ s: Suggestion, accept: Bool) {
        guard let token, !signalling else { return }
        signalling = true
        Task {
            do {
                try await Api(token: token).choice(id: s.id, accept: accept)
                signalling = false
                await load(restart: true)
            } catch {
                signalling = false
                self.error = failureMessage(error, otherwise: L("Couldn't save. Try again."))
            }
        }
    }

    /// The × on Today, or "Not going": taken off today at once, its row saying so with Undo.
    func removeFromToday(_ item: DayPlan.Item) {
        guard let token, var d = day else { return }
        let at = d.items.firstIndex { $0.key == item.key } ?? 0
        let before = at + 1 < d.items.count ? d.items[at + 1].key : nil
        d.items.removeAll { $0.key == item.key }
        day = d
        removed = Removed(item: item, at: at, before: before)
        let gen = session
        Task {
            do {
                let a = try await Api(token: token).signal(kind: "skipped", trip: item.key)
                if gen == session { applyPlan(a) }
            } catch {
                guard gen == session else { return }
                if var back = day, !back.items.contains(where: { $0.key == item.key }) {
                    back.items.insert(item, at: min(at, back.items.count))
                    day = back
                }
                removed = Removed(item: item, at: at, before: item.key, failed: true)
            }
            await loadDay()
        }
    }

    /// Undo on its row: back on today's list.
    func undoRemove() {
        guard let r = removed, !r.failed, let token else { return }
        removed = nil
        let gen = session
        Task {
            do {
                let a = try await Api(token: token).signal(kind: "reset", trip: r.item.key)
                if gen == session { applyPlan(a) }
            } catch {
                if gen == session { self.error = L("Couldn't put it back. Try again.") }
            }
            await loadDay()
        }
    }

    func dismissRemoved(_ key: String) {
        if removed?.item.key == key { removed = nil }
    }

    /// A new plan from /me/signal: shown, and kept for the widgets.
    private func applyPlan(_ a: NextAnswer) {
        answers[.plan] = a
        places = a.places
        Shared.lastAnswer = a.raw
        TripSync.answered(a)
        fetchedAt = Date()
        answeredAt["plan"] = Date()
    }

    /// "Go later today": a one-off trip to the place on screen, planned like a class.
    func goLater(atMin: Int) async -> String? {
        guard let token, target != .plan else { return nil }
        do {
            let a = try await Api(token: token).once(target, atMin: atMin)
            applyPlan(a)
            select(.plan)
            await loadDay()
            return nil
        } catch {
            return failureMessage(error, otherwise: L("Couldn't add it. Try again."))
        }
    }

    func loadDestinations() {
        guard destinations.isEmpty, let token else { return }
        Task {
            if let c = try? await Api(token: token).campus() { destinations = c.destinations }
        }
    }

    // MARK: "Is this wrong?"

    func report(reason: String?, note: String, answer: Data?) {
        guard let token else { return }
        reportSending = true
        reportResult = nil
        Task {
            do {
                try await Api(token: token).report(
                    reason: reason, note: note.trimmingCharacters(in: .whitespacesAndNewlines), answer: answer)
                reportSent = true
            } catch {
                reportResult = failureMessage(error, otherwise: L("Couldn't send. Try again."))
            }
            reportSending = false
        }
    }

    func reportOpened() {
        reportResult = nil
        reportSent = false
    }

    // MARK: the refresh loop

    /// The answer on Now is fetched again this often while it's on screen: the
    /// API caches 15 s, so sooner shows nothing new.
    static let pollS: TimeInterval = 30

    /// Runs while Now is on screen and the app is active.
    func poll() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(max(Self.pollS, Quiet.wait())))
        }
    }
}

/// The device's name, as Settings and the account page show it: "iPhone 17 Pro".
@MainActor func deviceName() -> String {
    var info = utsname()
    uname(&info)
    let id = withUnsafeBytes(of: &info.machine) { b in String(decoding: b.prefix(while: { $0 != 0 }), as: UTF8.self) }
    // The simulator says only "arm64": its model is in the environment.
    let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? id
    return iPhoneNames[model] ?? UIDevice.current.model
}

/// Marketing names for the identifiers iOS reports, newest first; anything
/// else is "iPhone" (UIDevice's model), which is still true.
private let iPhoneNames: [String: String] = [
    "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
    "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
    "iPhone17,5": "iPhone 16e",
    "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
    "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
    "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
    "iPhone14,6": "iPhone SE",
    "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
    "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE",
    "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
]
