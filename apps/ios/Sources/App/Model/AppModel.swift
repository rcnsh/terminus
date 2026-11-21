import SwiftUI
import UIKit

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    private(set) var paired: Bool
    var anonymous: Bool { didSet { Shared.defaults.set(anonymous, forKey: "anonymous") } }
    var email: String? { didSet { Shared.defaults.set(email, forKey: "email") } }
    var needsSetup: Bool { didSet { Shared.defaults.set(needsSetup, forKey: "needsSetup") } }
    private var setupUnknown: Bool { didSet { Shared.defaults.set(setupUnknown, forKey: "setupUnknown") } }
    private var askingMe = false
    var signedOutReason: String?
    private(set) var session = 0

    var token: String? { paired ? TokenStore.read() : nil }
    var api: Api { Api(token: token) }

    var target: Target = .plan
    private(set) var answers: [Target: NextAnswer] = [:]
    var answer: NextAnswer? { answers[target] }
    var plan: NextAnswer? { answers[.plan] }
    private(set) var loading = false
    private(set) var error: String?
    private(set) var fetchedAt: Date? {
        didSet { if setupUnknown, fetchedAt != nil { Task { await refreshMe() } } }
    }
    private(set) var places: [Place] = []
    private(set) var added: [Added] = Added.load()
    private(set) var destinations: [Destination] = []
    private(set) var day: DayPlan?
    private var dayFetched: Date?
    private var dayLang: String?
    private(set) var removed: Removed?
    private(set) var signalling = false
    private(set) var updateRequired = Outdated.required
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

    struct Removed {
        let item: DayPlan.Item
        let at: Int
        let before: String?
        var failed = false
    }

    var openBuses: [BusRoute]?
    var tab: MainTabs.Tab = .now

    var reportSending = false
    var reportResult: String?
    var reportSent = false

    init() {
        let token = TokenStore.read()
        paired = token != nil
        anonymous = Shared.defaults.bool(forKey: "anonymous")
        email = Shared.defaults.string(forKey: "email")
        needsSetup = Shared.defaults.bool(forKey: "needsSetup")
        setupUnknown = Shared.defaults.bool(forKey: "setupUnknown")
        if paired, let data = Shared.lastAnswer, let a = try? NextAnswer.decode(data), !a.isOld(at: ServerClock.now) {
            answers[.plan] = a
            places = a.places
        }
        if paired, let data = Shared.lastDay, let d = try? JSONDecoder().decode(DayPlan.self, from: data) { day = d }
        if !paired {
            NotificationCenter.default.addObserver(
                forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.keychainOpened() }
            }
        }
    }

    private func keychainOpened() {
        guard !paired, TokenStore.read() != nil else { return }
        session += 1
        paired = true
        anonymous = Shared.defaults.bool(forKey: "anonymous")
        email = Shared.defaults.string(forKey: "email")
        needsSetup = Shared.defaults.bool(forKey: "needsSetup")
        setupUnknown = Shared.defaults.bool(forKey: "setupUnknown")
    }

    func signedIn(token: String, anonymous: Bool, email: String? = nil, needsSetup: Bool? = false) {
        let addedEmail = paired && self.anonymous && !anonymous
        TokenStore.save(token)
        session += 1
        MapModel.shared.reset()
        Task { await MapModel.shared.loadProfile() }
        SettingsModel.shared.reset()
        paired = true
        self.anonymous = anonymous
        self.email = email
        self.needsSetup = needsSetup ?? false
        setupUnknown = needsSetup == nil
        signedOutReason = nil
        answers = [:]
        day = nil
        NearbyTabModel.shared.reset()
        error = nil
        target = .plan
        TripSync.signedIn()
        if addedEmail { WatchLink.shared.accountChanged(token: token) }
        Task { await load(restart: true) }
        Task { await refreshMe() }
    }

    func signOut() {
        let token = TokenStore.read()
        clearLocal()
        if let token { Task.detached { try? await Api(token: token).logout() } }
    }

    func rejected(_ token: String, reason: String) {
        guard TokenStore.read() == token else { return }
        let wasAnonymous = anonymous
        clearLocal()
        signedOutReason =
            wasAnonymous
            ? (onIPad
                ? L("This iPad's setup was removed after a long time unused. Start again or sign in.")
                : L("This phone's setup was removed after a long time unused. Start again or sign in.")) : reason
    }

    func clearLocal() {
        TripSync.signedOut()
        TokenStore.clear()
        session += 1
        paired = false
        anonymous = false
        email = nil
        needsSetup = false
        setupUnknown = false
        answers = [:]
        NearbyTabModel.shared.reset()
        day = nil
        removed = nil
        tab = .now
        places = []
        setAdded([])
        destinations = []
        error = nil
        fetchedAt = nil
        answeredAt = [:]
        Shared.lastAnswer = nil
        Shared.lastDay = nil
        NearbyShared.forget()
        SettingsModel.shared.reset()
        MapModel.shared.reset()
    }

    func refreshMe() async {
        guard let token, !askingMe else { return }
        askingMe = true
        defer { askingMe = false }
        let gen = session
        do {
            let me = try await Api(token: token).me()
            guard gen == session else { return }
            email = me.email
            anonymous = me.anonymous == true || me.email == nil
            needsSetup = me.onboarding != nil
            setupUnknown = false
        } catch let e as ApiError where e.status == 401 {
            rejected(token, reason: signedOutHere)
        } catch {}
    }

    func select(_ picked: Target) {
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
        error = nil
        Task { await load(restart: true) }
    }

    func showInBuses(_ pages: [BusRoute]) {
        openBuses = pages
        NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.buses)
    }

    func removeAdded(_ a: Added) {
        setAdded(added.filter { $0.code != a.code })
        if case .code(let code, _) = target, code == a.code {
            select(.plan)
        }
    }

    private func setAdded(_ list: [Added]) {
        guard list != added else { return }
        added = list
        Shared.defaults.set(try? JSONEncoder().encode(list), forKey: "added")
    }

    private var loadTask: Task<Void, Never>?
    private var loadID = 0

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
        let (loc, later) = await Locator.shared.quickFix()
        let sentAt = Date()
        let mine = loadID
        if let later {
            Task {
                let new = await later.value
                guard gen == session, mine == loadID, Locator.refreshAgain(sent: loc, new: new, sentAt: sentAt) else { return }
                await load(restart: true)
            }
        }
        let api = Api(token: token)
        let t = target
        do {
            let a = try await api.next(t, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
            guard gen == session, !Task.isCancelled else { return }
            if t == .plan {
                let before = answers[.plan]
                Shared.lastAnswer = a.raw
                TripSync.answered(a)
                if day == nil || (dayFetched.map { -$0.timeIntervalSinceNow > 120 } ?? true) || dayLang != Lang.header
                    || before?.dest?.label != a.dest?.label || before?.phase != a.phase
                {
                    Task { await loadDay() }
                }
            }
            answers[t] = a
            places = a.places
            answeredAt[key(t)] = Date()
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
                rejected(token, reason: signedOutHere)
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

    func pull() async -> PullOutcome {
        let k = key(target)
        let start = Date()
        if !Pull.shouldFetch(lastOK: answeredAt[k], now: start) { return .upToDate(nextInS: nil) }
        await load()
        return (answeredAt[k] ?? .distantPast) >= start ? .updated : .failed
    }

    func loadDay() async {
        guard let token else { return }
        let gen = session
        let loc = Locator.shared.last
        do {
            let (d, data, lang) = try await Api(token: token).day(
                lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
            guard gen == session else { return }
            day = d
            dayFetched = Date()
            dayLang = lang
            Shared.lastDay = data
        } catch {}
    }

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
                    rejected(token, reason: signedOutHere)
                } else {
                    error = e.message
                }
            } catch {
                self.error = L("Offline")
            }
        }
    }

    func step(_ s: Step, to: StepTarget?, dir: String?) {
        guard let token, !signalling else { return }
        signalling = true
        error = nil
        let gen = session
        let t = s.trip.hasPrefix("place:") || s.trip.hasPrefix("to:") ? target : .plan
        let loc = Locator.shared.last
        Task {
            defer { if gen == session { signalling = false } }
            do {
                let a = try await Api(token: token).step(
                    trip: s.trip, to: to, dir: dir, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude)
                guard gen == session else { return }
                if t == .plan {
                    applyPlan(a)
                } else {
                    answers[t] = a
                    places = a.places
                    fetchedAt = Date()
                    answeredAt[key(t)] = Date()
                }
                await loadDay()
            } catch let e as ApiError {
                if e.status == 401 {
                    rejected(token, reason: signedOutHere)
                } else {
                    error = e.message
                }
            } catch {
                self.error = L("Offline")
            }
        }
    }

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

    private func applyPlan(_ a: NextAnswer) {
        answers[.plan] = a
        places = a.places
        Shared.lastAnswer = a.raw
        TripSync.answered(a)
        fetchedAt = Date()
        answeredAt["plan"] = Date()
    }

    func goLater(atMin: Int) async -> String? {
        guard let token, target != .plan else { return nil }
        let gen = session
        let loc = await Locator.shared.quickFix().fix
        do {
            let a = try await Api(token: token).once(
                target, atMin: atMin, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
            guard gen == session else { return nil }
            applyPlan(a)
            select(.plan)
            await loadDay()
            return nil
        } catch {
            return failureMessage(error, otherwise: L("Couldn't add it. Try again."))
        }
    }

    func languageChanged() {
        TripSync.restyled()
        BusesModel.shared.languageChanged()
        NearbyTabModel.shared.languageChanged()
        guard paired else { return }
        Task {
            await load(restart: true)
            await loadDay()
        }
    }

    func loadDestinations() {
        guard destinations.isEmpty, let token else { return }
        Task {
            let copy = try? await CampusStore.shared.load(self, token: token) { [weak self] in
                if let c = $0.campus { self?.destinations = c.destinations }
            }
            if let c = copy?.campus { destinations = c.destinations }
        }
    }

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

    static let pollS: TimeInterval = 30

    func poll() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(max(Self.pollS, Quiet.wait())))
        }
    }
}

@MainActor func deviceName() -> String {
    var info = utsname()
    uname(&info)
    let id = withUnsafeBytes(of: &info.machine) { b in String(decoding: b.prefix(while: { $0 != 0 }), as: UTF8.self) }
    let model = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? id
    return iPhoneNames[model] ?? UIDevice.current.model
}

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
