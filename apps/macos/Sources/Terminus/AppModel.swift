import AppKit
import CoreLocation
import Foundation
import IOKit
import Network
import Observation
import ServiceManagement
import os

private let log = Logger(subsystem: "sh.rcn.terminus", category: "refresh")

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var paired = false
    var pairing = false
    var pairError: String?
    var signedOutReason: String?
    private(set) var session = 0
    var updateRequired = false

    var signInWaiting: (email: String, match: Int)?
    var signingIn = false
    var signInError: String?
    var needsSetup = UserDefaults.standard.bool(forKey: "needsSetup") {
        didSet { UserDefaults.standard.set(needsSetup, forKey: "needsSetup") }
    }
    private var signInTask: Task<Void, Never>?
    private var signInRequest: SignInRequest?

    var anonymous = UserDefaults.standard.bool(forKey: "anonymous") {
        didSet { UserDefaults.standard.set(anonymous, forKey: "anonymous") }
    }
    var chooseSetup: (token: String, email: String)?
    private var anonToken: String?

    struct AddedPlace: Codable, Hashable {
        let code: String
        let label: String
    }
    static let maxAdded = 5
    var added: [AddedPlace] =
        (UserDefaults.standard.data(forKey: "addedPlaces")).flatMap { try? JSONDecoder().decode([AddedPlace].self, from: $0) } ?? []
    {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(added), forKey: "addedPlaces") }
    }

    private(set) var plan: NextAnswer?
    private var otherAnswers: [Target: NextAnswer] = [:]
    var target: Target = .plan
    var answers: [Target: NextAnswer] {
        get {
            var a = otherAnswers
            a[.plan] = plan
            return a
        }
        set {
            plan = newValue[.plan]
            otherAnswers = newValue.filter { $0.key != .plan }
        }
    }
    var shown: NextAnswer? { target == .plan ? plan : otherAnswers[target] }
    var showNearby = false
    var nearby: [NearbyStop]?
    var loading = false
    var places: [Place] = []
    var destinations: [Destination] = []

    var error: String?
    var answerError: String?
    var updated: Date?

    var day: DayPlan?
    private var dayFetched: Date?
    var removed: DayPlan.Item?
    var removedAt = 0
    var removedBefore: String?
    private var removedTask: Task<Void, Never>?
    var removeFailed: (key: String, message: String)?
    private var removeFailedTask: Task<Void, Never>?

    private(set) var leaveAlerts = LeaveNotifier.shared.enabled

    var settingsPane: SettingsPane?

    var reporting = false
    var reportReason: String?
    var reportFromNus = false
    var reportReasons: [String]?
    var reportNote = ""
    var reportSending = false
    var reportResult: String?
    var reportSent = false
    private var reportSentLine: String?
    private var reportClear: Task<Void, Never>?
    var showReported: Bool { reportSent && shown?.card?.line == reportSentLine }
    private var reported: Data?
    var popoverOpen = false {
        didSet {
            guard popoverOpen != oldValue else { return }
            if popoverOpen {
                asleep = false
                screensAsleep = false
                locked = false
                refreshLoginItem()
                kick()
            } else {
                Updater.shared.popoverClosed()
            }
        }
    }
    var needsLocation: Bool { !isSnapshot && locator.undecided }
    let isSnapshot: Bool
    var locationDenied: Bool { locator.denied }
    var update: String?

    var misplaced: Bool {
        let path = Bundle.main.bundlePath
        return path.contains("/AppTranslocation/")
            || !(path.hasPrefix("/Applications/") || path.hasPrefix(NSHomeDirectory() + "/Applications/"))
    }

    private(set) var loginItem: SMAppService.Status = SMAppService.mainApp.status
    var openAtLogin: Bool { loginItem == .enabled }

    func setOpenAtLogin(_ on: Bool) {
        if on && misplaced {
            error = L("Move terminus to Applications first, then turn this on")
            return
        }
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            self.error = L("Couldn't change the login item: %@", error.localizedDescription)
        }
        refreshLoginItem()
        if on && loginItem == .requiresApproval {
            self.error = L("Allow terminus in System Settings → General → Login Items")
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    func refreshLoginItem() { loginItem = SMAppService.mainApp.status }

    func setLeaveAlerts(_ on: Bool) {
        guard on else {
            LeaveNotifier.shared.turnOff()
            leaveAlerts = false
            return
        }
        Task {
            if await LeaveNotifier.shared.requestPermission() {
                LeaveNotifier.shared.enabled = true
                leaveAlerts = true
                LeaveNotifier.shared.update(plan)
            } else {
                error = L("Allow terminus in System Settings → Notifications")
                LeaveNotifier.shared.openSettings()
            }
        }
    }

    var clock = ServerClock.now
    private var clockTask: Task<Void, Never>?

    private let locator = Locator()
    private var asleep = false
    private var screensAsleep = false
    private var locked = false
    private var paused: Bool { asleep || screensAsleep || locked }
    private var resumeTask: Task<Void, Never>?
    private var loop: Task<Void, Never>?

    init(snapshot: Bool = false) {
        isSnapshot = snapshot
        if snapshot { return }
        paired = TokenStore.read() != nil
        log.notice("start: paired=\(self.paired) base=\(Api.base, privacy: .public)")
        observeSleep()
        observeNetwork()
        LeaveNotifier.shared.start()
        start()
        Updater.shared.start(misplaced: misplaced)
        checkForUpdate()
        clockTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30), tolerance: .seconds(5))
                guard let self, !self.paused else { continue }
                self.catchUpClock()
            }
        }
    }

    private func catchUpClock() {
        let now = ServerClock.now
        if menuTitle(at: now) != menuTitle(at: clock) || isOld(plan, at: now) != isOld(plan, at: clock) {
            clock = now
        }
    }

    var resting: Bool { plan?.mode == "rest" }

    func offlinePick(at now: Date) -> OfflineDay.Pick? {
        guard error != nil, plan == nil || isOld(plan, at: now) else { return nil }
        return OfflineDay.next(day, now: now)
    }

    func menuTitle(at now: Date) -> String? {
        if let p = offlinePick(at: now) { return OfflineDay.menuTitle(p) }
        guard let plan, error == nil || !isOld(plan, at: now) else { return nil }
        if let card = plan.card { return card.glance.flatMap { $0.isEmpty ? nil : $0 } }
        guard plan.quality != "ended", !plan.isFree else { return nil }
        guard plan.hasLiveTime, let at = plan.departure else {
            let short = plan.label.replacingOccurrences(of: " · ", with: " ").replacingOccurrences(of: " min", with: "m")
            return short.count > 16 ? String(short.prefix(15)) + "…" : short
        }
        let left = at.timeIntervalSince(now)
        if left < -30 { return nil }
        let mins = L("%@ min", "\(Int((left / 60).rounded()))")
        let guess = plan.quality == "scheduled" || plan.quality == "stale"
        if left < 45 { return "\(plan.service) \(guess ? L("~%@", L("%@ min", "1")) : L("now"))" }
        return "\(plan.service) \(guess ? L("~%@", mins) : mins)"
    }

    func isOld(_ a: NextAnswer?, at now: Date) -> Bool {
        guard let a else { return false }
        guard let card = a.card else { return true }
        return card.staleAt.flatMap(parseISODate).map { now >= $0 } ?? false
    }

    func pair(_ code: String) {
        guard !pairing else { return }
        pairing = true
        pairError = nil
        signedOutReason = nil
        Task {
            do {
                let token = try await Api(token: nil).pair(code: code, name: deviceName)
                guard TokenStore.write(token) else {
                    pairing = false
                    pairError = L("Couldn't save the pairing on this Mac. Check that there's enough disk space, then pair again.")
                    return
                }
                session += 1
                paired = true
                pairing = false
                if locator.undecided { locator.ask() }
                kick()
            } catch {
                pairing = false
                pairError = failureMessage(error)
            }
        }
    }

    private var deviceName: String { macModelName(productName: Self.productName(), hwModel: Self.hwModel()) }

    private static func productName() -> String? {
        let entry = IORegistryEntryFromPath(kIOMainPortDefault, "IODeviceTree:/product")
        guard entry != 0 else { return nil }
        defer { IOObjectRelease(entry) }
        guard
            let data = IORegistryEntryCreateCFProperty(entry, "product-name" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
                as? Data
        else { return nil }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: CharacterSet(charactersIn: "\0").union(.whitespaces))
    }

    private static func hwModel() -> String? {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buf, &size, nil, 0) == 0 else { return nil }
        return String(decoding: buf.prefix { $0 != 0 }, as: UTF8.self)
    }

    var signalling = false

    func choose(_ s: Suggestion, accept: Bool) {
        guard !signalling, let token = TokenStore.read() else { return }
        signalling = true
        Task {
            defer { signalling = false }
            do {
                try await Api(token: token).choice(id: s.id, accept: accept)
                _ = await refresh()
            } catch {
                self.error = failureMessage(error, otherwise: L("Couldn't save that"))
            }
        }
    }

    func removeFromToday(_ item: DayPlan.Item) {
        guard let token = TokenStore.read() else { return }
        removeFailed = nil
        removedAt = day?.items.firstIndex { $0.key == item.key } ?? 0
        removedBefore = day.flatMap { $0.items.indices.contains(removedAt + 1) ? $0.items[removedAt + 1].key : nil }
        day?.items.removeAll { $0.key == item.key }
        removed = item
        removedTask?.cancel()
        removedTask = Task {
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { removed = nil }
        }
        let at = removedAt
        let date = day?.date
        Task {
            if let message = await send(CardAction(id: "skipped", label: "", trip: item.key), token: token, showingError: false) {
                if removed?.key == item.key {
                    removed = nil
                    removedTask?.cancel()
                }
                if day?.date == date, day?.items.contains(where: { $0.key == item.key }) == false {
                    day?.items.insert(item, at: min(at, day?.items.count ?? 0))
                }
                removeFailed = (item.key, message)
                removeFailedTask?.cancel()
                removeFailedTask = Task {
                    try? await Task.sleep(for: .seconds(6))
                    if !Task.isCancelled { removeFailed = nil }
                }
            }
        }
    }

    func undoRemove() {
        guard let item = removed, let token = TokenStore.read() else { return }
        removed = nil
        removedTask?.cancel()
        Task { await send(CardAction(id: "reset", label: "", trip: item.key), token: token) }
    }

    func step(_ step: NextAnswer.Step, to: StepTarget?, dir: StepDirection?) {
        guard !signalling, let token = TokenStore.read() else { return }
        signalling = true
        let t = target
        Task {
            defer { signalling = false }
            if t == .plan {
                await send(token: token) { try await $0.step(trip: step.trip, to: to, dir: dir) }
            } else {
                let gen = session
                do {
                    _ = try await Api(token: token).step(trip: step.trip, to: to, dir: dir)
                    guard gen == session else { return }
                    _ = await refresh()
                } catch {
                    guard gen == session else { return }
                    self.error = failureMessage(error, otherwise: L("Offline"))
                }
            }
        }
    }

    @discardableResult
    private func send(_ action: CardAction, token: String, showingError: Bool = true) async -> String? {
        await send(token: token, showingError: showingError) { try await $0.signal(action) }
    }

    @discardableResult
    private func send(token: String, showingError: Bool = true, _ request: (Api) async throws -> NextAnswer) async -> String? {
        let gen = session
        do {
            let api = Api(token: token)
            let a = try await request(api)
            guard gen == session else { return nil }
            plan = a
            updated = ServerClock.now
            planFetched = Date()
            error = nil
            LeaveNotifier.shared.update(a)
            dayFetched = Date()
            let d = try? await api.day()
            guard gen == session else { return nil }
            if let d { day = d } else { dayFetched = nil }
            return nil
        } catch {
            guard gen == session else { return nil }
            let message = failureMessage(error, otherwise: L("Offline"))
            if showingError { self.error = message }
            return message
        }
    }

    func signal(_ action: CardAction) {
        if action.id == "skipped", let item = day?.items.first(where: { $0.key == action.trip && $0.removable == true }) {
            removeFromToday(item)
            return
        }
        guard !signalling, let token = TokenStore.read() else { return }
        signalling = true
        Task {
            defer { signalling = false }
            await send(action, token: token)
        }
    }

    var startingAnon = false

    func startWithoutEmail() {
        guard !startingAnon else { return }
        startingAnon = true
        signInError = nil
        signedOutReason = nil
        Task {
            defer { startingAnon = false }
            do {
                let token = try await Api(token: nil).anon(name: deviceName)
                guard TokenStore.write(token) else {
                    signInError = L("Couldn't save the sign-in on this Mac. Check that there's enough disk space, then try again.")
                    return
                }
                session += 1
                anonymous = true
                needsSetup = true
                paired = true
                if locator.undecided { locator.ask() }
                kick()
            } catch {
                signInError = failureMessage(error)
            }
        }
    }

    func deleteAnonymousAccount() {
        guard let token = TokenStore.read() else { return }
        Task {
            do {
                try await Api(token: token).deleteAccount()
                TokenStore.write(nil)
                clearLocal()
            } catch {
                self.error = failureMessage(error)
            }
        }
    }

    func addPlace(code: String, label: String) {
        if added.contains(where: { $0.code == code }) || places.contains(where: { $0.label.caseInsensitiveCompare(label) == .orderedSame })
        {
            return
        }
        added = Array(([AddedPlace(code: code, label: label)] + added).prefix(Self.maxAdded))
    }

    func removeAdded(_ p: AddedPlace) {
        added.removeAll { $0.code == p.code }
        if case .code(let c, _) = target, c == p.code { select(.plan) }
    }

    func goLater(atMin: Int) async -> String? {
        guard let token = TokenStore.read(), target != .plan else { return nil }
        let gen = session
        let fix = await locator.current(maxAge: 120)
        let acc = fix.flatMap { fixUncertaintyM(accuracy: $0.horizontalAccuracy, ageS: -$0.timestamp.timeIntervalSinceNow) }
        let loc = acc == nil ? nil : fix
        do {
            let a = try await Api(token: token).once(
                target, atMin: atMin, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: acc)
            guard gen == session else { return nil }
            plan = a
            updated = ServerClock.now
            planFetched = Date()
            LeaveNotifier.shared.update(a)
            select(.plan)
            dayFetched = Date()
            let d = try? await Api(token: token).day()
            guard gen == session else { return nil }
            if let d { day = d } else { dayFetched = nil }
            return nil
        } catch {
            guard gen == session else { return nil }
            return failureMessage(error, otherwise: L("Couldn't add it. Check your connection."))
        }
    }

    func signIn(email: String) {
        signingIn = true
        signInError = nil
        signedOutReason = nil
        signInTask?.cancel()
        signInTask = Task {
            do {
                anonToken = anonymous ? TokenStore.read() : nil
                let r = try await Api(token: anonToken).signInStart(email: email, name: deviceName)
                if Task.isCancelled { return }
                signingIn = false
                signInRequest = r
                signInWaiting = (email, r.match)
                await pollSignIn(r)
            } catch {
                if Task.isCancelled { return }
                signingIn = false
                anonToken = nil
                signInError = failureMessage(error)
            }
        }
    }

    func enterCode(_ code: String) {
        guard let r = signInRequest, !signingIn else { return }
        signingIn = true
        signInError = nil
        Task {
            do {
                let p = try await Api(token: nil).signInCode(r, code: code)
                signingIn = false
                guard signInRequest == r else { return }
                if p.status == "approved" {
                    signInTask?.cancel()
                    signedIn(p)
                }
            } catch {
                signingIn = false
                guard signInRequest == r else { return }
                signInError = failureMessage(error)
                if let e = error as? ApiError, e.state == "denied" || e.state == "expired" {
                    signInTask?.cancel()
                    signInRequest = nil
                    signInWaiting = nil
                    anonToken = nil
                }
            }
        }
    }

    private func signedIn(_ p: SignInPoll) {
        signInRequest = nil
        if p.outcome == "choose", let token = p.token, anonToken != nil {
            signInWaiting = nil
            chooseSetup = (token, p.email ?? "")
            return
        }
        finishSignIn(p)
    }

    func keepSetup(mac: Bool) {
        guard let c = chooseSetup, !signingIn else { return }
        let anon = anonToken
        signInError = nil
        signingIn = true
        Task {
            defer { signingIn = false }
            if let anon {
                do {
                    try await Api(token: c.token).merge(anon: anon, keepDevice: mac)
                } catch let e as ApiError where e.status == 400 {
                } catch {
                    signInError = failureMessage(error)
                    return
                }
            }
            chooseSetup = nil
            finishSignIn(SignInPoll(status: "approved", token: c.token, email: c.email, outcome: "signed-in"))
        }
    }

    private func finishSignIn(_ p: SignInPoll) {
        anonToken = nil
        signInWaiting = nil
        guard let token = p.token else {
            signInError = L("That sign-in was already used. Send a new one.")
            return
        }
        guard TokenStore.write(token) else {
            signInError = L("Couldn't save the sign-in on this Mac. Check that there's enough disk space, then try again.")
            return
        }
        session += 1
        needsSetup = p.outcome == "created"
        anonymous = false
        paired = true
        if locator.undecided { locator.ask() }
        kick()
    }

    func cancelSignIn() {
        signInRequest = nil
        signInTask?.cancel()
        signInWaiting = nil
        signingIn = false
        anonToken = nil
    }

    private func pollSignIn(_ r: SignInRequest) async {
        let until = Date().addingTimeInterval(15 * 60)
        while Date() < until {
            try? await Task.sleep(for: .seconds(3))
            if Task.isCancelled || signInRequest != r { return }
            let p = try? await Api(token: nil).signInPoll(r)
            if Task.isCancelled || signInRequest != r { return }
            guard let p else { continue }
            switch p.status {
            case "pending":
                continue
            case "approved":
                signedIn(p)
                return
            case "denied":
                signInRequest = nil
                signInWaiting = nil
                anonToken = nil
                signInError = L("The sign-in was cancelled from the email. If that was you, send a new one.")
                return
            default:
                signInRequest = nil
                signInWaiting = nil
                anonToken = nil
                signInError = L("That request expired. Send a new one.")
                return
            }
        }
        guard signInRequest == r else { return }
        signInRequest = nil
        signInWaiting = nil
        anonToken = nil
        signInError = L("That request expired. Send a new one.")
    }

    func unpair() {
        let token = TokenStore.read()
        loop?.cancel()
        TokenStore.write(nil)
        clearLocal()
        Task { try? await Api(token: token).logout() }
    }

    private func clearLocal() {
        session += 1
        signedOutReason = nil
        updateRequired = false
        signInTask?.cancel()
        signInRequest = nil
        signInWaiting = nil
        signingIn = false
        chooseSetup = nil
        anonToken = nil
        langSynced = false
        Clock.pref = "auto"
        paired = false
        needsSetup = false
        anonymous = false
        added = []
        answers = [:]
        planFetched = nil
        day = nil
        dayFetched = nil
        LeaveNotifier.shared.clearLeave()
        nearby = nil
        places = []
        target = .plan
        showNearby = false
        error = nil
        answerError = nil
    }

    func openLocationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")!)
    }

    private func checkForUpdate() {
        let d = UserDefaults.standard
        let current = Api.version ?? "0"
        let check = Self.updateCheck(
            cached: d.string(forKey: "latestVersion"), checkedAt: d.double(forKey: "updateCheckedAt"), current: current,
            now: Date().timeIntervalSince1970)
        update = check.update
        guard check.fetch else { return }
        Task {
            guard let v = try? await Api(token: nil).latestVersion() else { return }
            d.set(Date().timeIntervalSince1970, forKey: "updateCheckedAt")
            d.set(v, forKey: "latestVersion")
            update = isNewer(v, than: current) ? v : nil
        }
    }

    nonisolated static func updateCheck(cached: String?, checkedAt: Double, current: String, now: Double) -> (update: String?, fetch: Bool)
    {
        (cached.flatMap { isNewer($0, than: current) ? $0 : nil }, now - checkedAt > 86_400)
    }

    func askLocation() { locator.ask() }

    func whereAmI() async -> CLLocation? {
        guard let fix = await locator.current(maxAge: 120),
            let acc = fixUncertaintyM(accuracy: fix.horizontalAccuracy, ageS: -fix.timestamp.timeIntervalSinceNow), acc <= 200
        else { return nil }
        return fix
    }

    var wantsSetup: Bool { paired && (needsSetup || plan?.card?.kind == "setup") }

    func startReport() {
        reported = showNearby ? nil : shown?.raw
        reportFromNus = !showNearby && shown?.card?.fromNus == true
        reportReasons = showNearby ? nil : shown?.card?.reasons
        reportSentLine = shown?.card?.line
        reportReason = nil
        reportNote = ""
        reportResult = nil
        reportSent = false
        reporting = true
    }

    func cancelReport() {
        reporting = false
        reportResult = nil
    }

    func sendReport() {
        let note = reportNote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard reportReason != nil || !note.isEmpty else { return }
        let reason = reportReason
        reportSending = true
        Task {
            defer { reportSending = false }
            do {
                try await Api(token: TokenStore.read()).report(reason: reason, note: note, answer: reported)
                reporting = false
                reportSent = true
                reportClear?.cancel()
                reportClear = Task {
                    try? await Task.sleep(for: .seconds(6))
                    if !Task.isCancelled { reportSent = false }
                }
            } catch {
                reportResult = failureMessage(error, otherwise: L("Couldn't reach terminus. Try again in a moment."))
            }
        }
    }

    func select(_ t: Target) {
        if t != target { reportSent = false }
        target = t
        showNearby = false
        kick()
    }

    func goSomewhere(code: String, label: String) {
        if let fav = places.first(where: { $0.label.caseInsensitiveCompare(label) == .orderedSame }) {
            select(.place(key: fav.key))
            return
        }
        addPlace(code: code, label: label)
        select(.code(code, label: label))
    }

    func selectNearby() {
        showNearby = true
        kick()
    }

    func loadDestinations() {
        guard destinations.isEmpty else { return }
        Task {
            let copy = try? await CampusStore.shared.load(self, token: TokenStore.read()) { [weak self] in
                if let d = $0.destinations { self?.destinations = d }
            }
            destinations = copy?.destinations ?? []
        }
    }

    private var langSynced = false
    private func syncLang(_ api: Api) async {
        let gen = session
        guard !langSynced, let data = try? await api.profile(), gen == session,
            let p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        langSynced = true
        guard let mine = Lang.followAccount(p["lang"] as? String ?? "auto") else { return }
        _ = try? await api.changeProfile { $0["lang"] = mine }
    }

    func setLang(_ pref: String) {
        Lang.set(pref)
        Lang.noteAccount(pref)
        Task {
            if let token = TokenStore.read() { _ = try? await Api(token: token).changeProfile { $0["lang"] = pref } }
            Lang.relaunch()
        }
    }

    enum Fetch { case done, failed, skipped }

    private func start() {
        loop?.cancel()
        loop = Task {
            while !Task.isCancelled {
                var result = Fetch.skipped
                if !paused && paired {
                    if online {
                        result = await refresh()
                    } else if error == nil {
                        error = L("Offline")
                    }
                    switch result {
                    case .done: LeaveNotifier.shared.confirmed(plan)
                    case .failed: LeaveNotifier.shared.unconfirmed(since: updated)
                    case .skipped: if !online { LeaveNotifier.shared.unconfirmed(since: updated) }
                    }
                }
                try? await Task.sleep(for: .seconds(nextDelay(failed: result == .failed)))
            }
        }
    }

    private var failures = 0
    private var serverWait: TimeInterval?

    private func nextDelay(failed: Bool) -> TimeInterval {
        failures = failed ? failures + 1 : 0
        return Self.nextDelay(
            failures: failures, popoverOpen: popoverOpen, resting: resting, plan: plan, now: ServerClock.now,
            updateRequired: updateRequired, serverWait: serverWait, lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
    }

    nonisolated static func nextDelay(
        failures: Int, popoverOpen: Bool, resting: Bool, plan: NextAnswer?, now: Date,
        updateRequired: Bool = false, serverWait: TimeInterval? = nil, lowPower: Bool = false
    ) -> TimeInterval {
        if updateRequired { return Outdated.holdS }
        let floor = failures > 0 ? serverWait.map(Quiet.cap) ?? 0 : 0
        if failures > 0 && failures <= 3 { return max([5, 15, 45][failures - 1], floor) }
        var d: TimeInterval = (popoverOpen ? 30 : resting ? 600 : 300) * (lowPower ? 2 : 1)
        for mark in [plan?.departure?.addingTimeInterval(31), plan?.planChanges, plan?.nextChange].compactMap({ $0 }) where mark > now {
            d = min(d, mark.timeIntervalSince(now))
        }
        return max(d, lowPower ? 60 : 30, floor)
    }

    private func kick() { start() }

    func mapRefused() {
        guard paired, !updateRequired else { return }
        kick()
    }

    var planFetched: Date?
    static let planReuseS: TimeInterval = 300

    func planDue(at now: Date, local: Date = Date()) -> Bool {
        guard let plan, let fetched = planFetched, local.timeIntervalSince(fetched) < Self.planReuseS else { return true }
        let marks = [plan.departure?.addingTimeInterval(31), plan.planChanges, plan.nextChange, plan.staleAt].compactMap { $0 }
        return marks.contains { $0 <= now }
    }

    func wantsFix(at now: Date) -> Bool {
        guard !popoverOpen, resting, let plan else { return true }
        let marks = [plan.planChanges, plan.nextChange, plan.staleAt].compactMap { $0 }
        return marks.contains { $0 <= now }
    }

    @discardableResult
    func refresh() async -> Fetch {
        guard let token = TokenStore.read() else {
            if !TokenStore.exists {
                log.notice("no token; showing pairing")
                paired = false
            }
            return .skipped
        }
        guard !refreshing else {
            rerun = true
            return .skipped
        }
        refreshing = true
        defer {
            refreshing = false
            if rerun {
                rerun = false
                Task { await self.refresh() }
            }
        }
        log.debug("refreshing against \(Api.base, privacy: .public)")
        let gen = session
        let api = Api(token: token)
        if !langSynced { Task { await syncLang(api) } }
        let located = wantsFix(at: ServerClock.now)
        let fix = located ? await locator.current(maxAge: popoverOpen ? 120 : 600) : nil
        let acc = fix.flatMap { fixUncertaintyM(accuracy: $0.horizontalAccuracy, ageS: -$0.timestamp.timeIntervalSinceNow) }
        let loc = acc == nil ? nil : fix
        let lat = loc?.coordinate.latitude
        let lon = loc?.coordinate.longitude
        loading = true
        defer { loading = false }
        do {
            let onPlan = !showNearby && target == .plan
            if showNearby {
                let n = try await api.nearby(lat: lat, lon: lon, acc: acc)
                guard gen == session else { return .skipped }
                nearby = n
            } else if target != .plan {
                let t = target
                let a = try await api.next(t, lat: lat, lon: lon, acc: acc)
                guard gen == session else { return .skipped }
                otherAnswers[t] = a
            }
            if onPlan || planDue(at: ServerClock.now) {
                let p = try await api.next(.plan, lat: lat, lon: lon, acc: acc)
                guard gen == session else { return .skipped }
                plan = p
                planFetched = Date()
                let newPlaces = p.places ?? []
                if newPlaces != places { places = newPlaces }
                if case .place(let key) = target, !places.contains(where: { $0.key == key }) { target = .plan }
                LeaveNotifier.shared.update(p)
                if !located && p.mode != "rest" { rerun = true }
            }
            if error != nil { error = nil }
            if answerError != nil { answerError = nil }
            if updateRequired { updateRequired = false }
            serverWait = nil
            updated = ServerClock.now
            catchUpClock()
            let dayAge = dayFetched.map { Date().timeIntervalSince($0) } ?? .infinity
            if (popoverOpen && dayAge > 120) || dayAge > 3600 || day?.date != OfflineDay.sgtDate(ServerClock.now) {
                dayFetched = Date()
                let d = try? await api.day(lat: lat, lon: lon, acc: acc)
                guard gen == session else { return .skipped }
                if let d { day = d }
            }
            return .done
        } catch  where gen != session {
            return .skipped
        } catch let e as ApiError where e.status == 401 && TokenStore.read() != token {
            return .skipped
        } catch let e as ApiError where e.status == 401 {
            if anonymous && (signInRequest != nil || chooseSetup != nil) { return .failed }
            let reason =
                anonymous
                ? L("This Mac's setup was removed after a long time unused. Start again or sign in.")
                : L("This Mac was signed out of your account. Sign in again to carry on.")
            TokenStore.write(nil)
            clearLocal()
            signedOutReason = reason
            return .skipped
        } catch let e as ApiError where e.updateRequired {
            log.notice("426: this version is too old for the server")
            updateRequired = true
            error = nil
            answerError = L("Update terminus to continue")
            return .failed
        } catch let e as ApiError {
            log.error("api error \(e.status): \(e.message, privacy: .public)")
            serverWait = e.retryAfter
            error = e.message
            answerError = e.message
            return .failed
        } catch is DecodingError {
            error = update != nil ? L("Update terminus to continue") : L("terminus sent something this version can't read.")
            answerError = error
            return .failed
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return .skipped }
            log.error("refresh failed: \(error.localizedDescription, privacy: .public)")
            self.error = L("Offline")
            answerError = self.error
            return .failed
        }
    }

    private var refreshing = false
    private var rerun = false

    private func observeSleep() {
        let ws = NSWorkspace.shared.notificationCenter
        let dist = DistributedNotificationCenter.default()
        let events: [(NotificationCenter, Notification.Name, Pause, Bool)] = [
            (ws, NSWorkspace.willSleepNotification, .sleep, true),
            (ws, NSWorkspace.didWakeNotification, .sleep, false),
            (ws, NSWorkspace.screensDidSleepNotification, .screens, true),
            (ws, NSWorkspace.screensDidWakeNotification, .screens, false),
            (dist, .init("com.apple.screenIsLocked"), .lock, true),
            (dist, .init("com.apple.screenIsUnlocked"), .lock, false),
        ]
        for (center, name, flag, on) in events {
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.set(flag, on) }
            }
        }
    }

    private enum Pause { case sleep, screens, lock }

    private func set(_ flag: Pause, _ on: Bool) {
        let was = paused
        switch flag {
        case .sleep: asleep = on
        case .screens: screensAsleep = on
        case .lock: locked = on
        }
        if !on && flag != .lock { locked = Self.screenLocked() }
        if paused {
            resumeTask?.cancel()
            LeaveNotifier.shared.unconfirmed(since: updated)
        } else if was {
            resumeTask?.cancel()
            resumeTask = Task {
                try? await Task.sleep(for: .seconds(2))
                guard !Task.isCancelled, !paused else { return }
                catchUpClock()
                kick()
            }
        }
    }

    private static func screenLocked() -> Bool {
        (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool ?? false
    }

    private let pathMonitor = NWPathMonitor()
    private(set) var online = true

    private func observeNetwork() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            let up = path.status == .satisfied
            Task { @MainActor in
                guard let self else { return }
                if up && !self.online { self.kick() }
                self.online = up
            }
        }
        pathMonitor.start(queue: .global(qos: .utility))
    }
}

func macModelName(productName: String?, hwModel: String?) -> String {
    if let p = productName?.trimmingCharacters(in: .whitespaces), !p.isEmpty { return String(p.prefix(40)) }
    let families: [(String, String)] = [
        ("MacBookPro", "MacBook Pro"), ("MacBookAir", "MacBook Air"), ("MacBook", "MacBook"), ("Macmini", "Mac mini"),
        ("MacPro", "Mac Pro"), ("iMacPro", "iMac Pro"), ("iMac", "iMac"),
    ]
    let model = hwModel ?? ""
    return families.sorted { $0.0.count > $1.0.count }.first { model.hasPrefix($0.0) }?.1 ?? "Mac"
}
