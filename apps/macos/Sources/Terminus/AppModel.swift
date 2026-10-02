import AppKit
import CoreLocation
import Foundation
import Network
import Observation
import os
import ServiceManagement

private let log = Logger(subsystem: "sh.rcn.terminus", category: "refresh")

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    /// Set from the token file at launch; snapshots and tests set it themselves
    /// and never touch the real token.
    var paired = false
    var pairing = false
    var pairError: String?

    /// An email sign-in waiting for its approval: the number to show.
    var signInWaiting: (email: String, match: Int)?
    var signingIn = false
    var signInError: String?
    /// Signed in to an account that has no setup yet: the popover offers it
    /// until it's done or skipped, across launches.
    var needsSetup = UserDefaults.standard.bool(forKey: "needsSetup") {
        didSet { UserDefaults.standard.set(needsSetup, forKey: "needsSetup") }
    }
    private var signInTask: Task<Void, Never>?
    private var signInRequest: SignInRequest?

    /// Always the planned trip: this is what the menu bar shows.
    var plan: NextAnswer? { answers[.plan] }
    var target: Target = .plan
    /// The last answer per view. Switching views shows the cached one at once
    /// and refreshes it in place, instead of blanking the popover (which made
    /// it collapse and then grow back when the data arrived).
    var answers: [Target: NextAnswer] = [:]
    var shown: NextAnswer? { answers[target] }
    var showNearby = false
    var nearby: [NearbyStop]?
    var loading = false
    var places: [Place] = []
    var destinations: [Destination] = []

    var error: String?
    var updated: Date?

    /// Today, for the popover: fetched while it's open, at most every 2 minutes.
    var day: DayPlan?
    private var dayFetched: Date?
    /// Just taken off Today, offered back with Undo for a few seconds.
    var removed: DayPlan.Item?
    private var removedTask: Task<Void, Never>?

    /// "Notify me when to leave for class" (phase 7), mirrored from LeaveNotifier.
    private(set) var leaveAlerts = LeaveNotifier.shared.enabled

    /// "Is this wrong?": the form is open, what's typed, and how sending went.
    var reporting = false
    var reportNote = ""
    var reportSending = false
    var reportResult: String?
    /// The answer on screen when the form opened; the refresh loop may replace it meanwhile.
    private var reported: Data?
    var popoverOpen = false {
        didSet { if popoverOpen { refreshLoginItem(); kick() } else { Updater.shared.popoverClosed() } }
    }
    var needsLocation: Bool { !isSnapshot && locator.undecided }
    /// A render for screenshots: native controls (text fields, menus), which
    /// ImageRenderer can't draw, are swapped for look-alikes.
    let isSnapshot: Bool
    var locationDenied: Bool { locator.denied }
    /// A newer released version, when there is one.
    var update: String?

    /// Login items and updates only work from Applications: a copy run from
    /// Downloads is translocated to a random read-only path.
    var misplaced: Bool {
        let path = Bundle.main.bundlePath
        return path.contains("/AppTranslocation/") || !(path.hasPrefix("/Applications/") || path.hasPrefix(NSHomeDirectory() + "/Applications/"))
    }

    /// Mirrors the system's login-item status. A stored property, so the
    /// Settings toggle re-renders when it changes; refreshed on every open.
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
        // An app outside the App Store may need the user's OK first.
        if on && loginItem == .requiresApproval {
            self.error = L("Allow terminus in System Settings → General → Login Items")
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    func refreshLoginItem() { loginItem = SMAppService.mainApp.status }

    // MARK: leave notifications (phase 7)

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

    /// Ticks every 30 s for the menu bar's countdown.
    var clock = Date()
    private var clockTask: Task<Void, Never>?

    private let locator = Locator()
    private var paused = false
    private var loop: Task<Void, Never>?

    /// `snapshot` builds an inert model for rendering previews: no refresh
    /// loop, no sleep observers.
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
                // Only when the title would change: every assignment redraws the menu bar.
                let now = Date()
                if self.menuTitle(at: now) != self.menuTitle(at: self.clock) || self.isOld(self.plan, at: now) != self.isOld(self.plan, at: self.clock) {
                    self.clock = now
                }
            }
        }
    }

    /// Outside the user's day the plan rests: no bus, a moon in the menu bar.
    var resting: Bool { plan?.mode == "rest" }

    /// The menu bar text at `now`: "D2 4m" counted from the departure time,
    /// or nil for the plain icon once the bus has gone or there's no bus.
    func menuTitle(at now: Date) -> String? {
        // A trip under way: its phase, as the phone and the widget say it.
        if let plan, plan.tripUnderWay, let g = plan.card?.glance { return g }
        guard let plan, plan.quality != "ended", plan.card?.kind != "setup", !plan.isFree else { return nil }
        // A class: when to leave is what matters from the menu bar.
        if plan.isClassPlan, let at = plan.leaveAt {
            return now >= at ? L("Leave now") : L("Leave %@", campusTime(at))
        }
        guard plan.hasLiveTime, let at = plan.departure else {
            let short = plan.label.replacingOccurrences(of: " · ", with: " ").replacingOccurrences(of: " min", with: "m")
            return short.count > 16 ? String(short.prefix(15)) + "…" : short
        }
        let left = at.timeIntervalSince(now)
        if left < -30 { return nil }
        return left < 45 ? "\(plan.service) \(L("now"))" : "\(plan.service) \(L("%@m", "\(Int((left / 60).rounded()))"))"
    }

    /// Same rule as the Android widget: the bus has left, the plan has moved
    /// on (a class started, the day ended), or the answer is 15 minutes old.
    /// A rest answer only goes old when the day starts.
    func isOld(_ a: NextAnswer?, at now: Date) -> Bool {
        // The server says when (card.staleAt); the rest is for an answer that predates it.
        if let at = a?.staleAt { return now >= at }
        if let at = a?.planChanges, now >= at { return true }
        if a?.mode == "rest" { return false }
        if let at = a?.departure, now.timeIntervalSince(at) > 30 { return true }
        if let updated, now.timeIntervalSince(updated) > 15 * 60 { return true }
        return false
    }

    // MARK: pairing

    func pair(_ code: String) {
        pairing = true
        pairError = nil
        Task {
            do {
                let name = Host.current().localizedName ?? "Mac"
                let token = try await Api(token: nil).pair(code: code, name: String(name.prefix(40)))
                guard TokenStore.write(token) else {
                    pairing = false
                    pairError = L("Couldn't save the pairing on this Mac. Check there's disk space, then pair again.")
                    return
                }
                paired = true
                pairing = false
                if locator.undecided { locator.ask() }
                kick()
            } catch let e as ApiError {
                pairing = false
                pairError = e.message
            } catch {
                pairing = false
                pairError = L("Couldn't reach terminus. Check your connection and try again.")
            }
        }
    }

    // MARK: trip signals

    var signalling = false

    /// A card button: "On the D2", "Missed it", "Not going". Recorded for every
    /// device; the answer that comes back replaces the planned one.
    /// "Leave earlier" or "No thanks" on a suggestion; the card comes back without it.
    func choose(_ s: Suggestion, accept: Bool) {
        guard !signalling, let token = TokenStore.read() else { return }
        signalling = true
        Task {
            defer { signalling = false }
            do {
                try await Api(token: token).choice(id: s.id, accept: accept)
                _ = await refresh()
            } catch let e as ApiError {
                error = e.message
            } catch {
                self.error = L("Couldn't save that")
            }
        }
    }

    /// The × on a Today row: taken off today, whatever it is (a timetabled
    /// class, one you added, the trip home). Gone at once, with Undo.
    func removeFromToday(_ item: DayPlan.Item) {
        guard let token = TokenStore.read() else { return }
        day?.items.removeAll { $0.key == item.key }
        removed = item
        removedTask?.cancel()
        removedTask = Task {
            try? await Task.sleep(for: .seconds(6))
            if !Task.isCancelled { removed = nil }
        }
        Task { await sendDay("skipped", item.key, token: token) }
    }

    /// Undo on the bar: back on today's list.
    func undoRemove() {
        guard let item = removed, let token = TokenStore.read() else { return }
        removed = nil
        removedTask?.cancel()
        Task { await sendDay("reset", item.key, token: token) }
    }

    /// A signal about one of today's entries, then the plan and Today again.
    private func sendDay(_ kind: String, _ key: String, token: String) async {
        do {
            let api = Api(token: token)
            let a = try await api.signal(CardAction(id: kind, label: "", trip: key))
            answers[.plan] = a
            updated = Date()
            error = nil
            LeaveNotifier.shared.update(a)
            dayFetched = Date()
            day = try? await api.day()
        } catch let e as ApiError {
            error = e.message
        } catch {
            self.error = L("Offline")
        }
    }

    func signal(_ action: CardAction) {
        guard !signalling, let token = TokenStore.read() else { return }
        signalling = true
        Task {
            defer { signalling = false }
            do {
                let api = Api(token: token)
                let a = try await api.signal(action)
                answers[.plan] = a
                updated = Date()
                error = nil
                LeaveNotifier.shared.update(a)
                // "Not going", "Undo", "Back on campus" change Today too: now, not at the next refresh.
                dayFetched = Date()
                day = try? await api.day()
            } catch let e as ApiError {
                error = e.message
            } catch {
                self.error = L("Offline")
            }
        }
    }

    // MARK: signing in by email

    /// Emails a link that approves this Mac from any device (the phone's mail
    /// app, say): the page asks for the number shown here. Universal links
    /// would need a paid Apple team; this needs nothing.
    func signIn(email: String) {
        signingIn = true
        signInError = nil
        signInTask?.cancel()
        signInTask = Task {
            do {
                let name = String((Host.current().localizedName ?? "Mac").prefix(40))
                let r = try await Api(token: nil).signInStart(email: email, name: name)
                signingIn = false
                signInRequest = r
                signInWaiting = (email, r.match)
                await pollSignIn(r)
            } catch let e as ApiError {
                signingIn = false
                signInError = e.message
            } catch {
                signingIn = false
                signInError = L("Couldn't reach terminus. Check your connection and try again.")
            }
        }
    }

    /// The code from the email, typed in: signs in straight away when it's right.
    func enterCode(_ code: String) {
        guard let r = signInRequest else { return }
        signingIn = true
        signInError = nil
        Task {
            do {
                let p = try await Api(token: nil).signInCode(r, code: code)
                signingIn = false
                if p.status == "approved" {
                    signInTask?.cancel()
                    signedIn(p)
                }
            } catch let e as ApiError {
                signingIn = false
                signInError = e.message
            } catch {
                signingIn = false
                signInError = L("Couldn't reach terminus. Check your connection and try again.")
            }
        }
    }

    private func signedIn(_ p: SignInPoll) {
        signInRequest = nil
        guard let token = p.token, TokenStore.write(token) else {
            signInWaiting = nil
            signInError = L("Couldn't save the sign-in on this Mac. Check there's disk space, then try again.")
            return
        }
        signInWaiting = nil
        // A brand-new account has nothing to show yet.
        needsSetup = p.outcome == "created"
        paired = true
        if locator.undecided { locator.ask() }
        kick()
    }

    func cancelSignIn() {
        signInRequest = nil
        signInTask?.cancel()
        signInWaiting = nil
        signingIn = false
    }

    /// Every 3 seconds, for the request's 15 minutes.
    private func pollSignIn(_ r: SignInRequest) async {
        let until = Date().addingTimeInterval(15 * 60)
        while Date() < until {
            try? await Task.sleep(for: .seconds(3))
            if Task.isCancelled { return }
            guard let p = try? await Api(token: nil).signInPoll(r) else { continue }
            switch p.status {
            case "pending":
                continue
            case "approved":
                signedIn(p)
                return
            case "denied":
                signInWaiting = nil
                signInError = L("The sign-in was cancelled from the email. If that was you, send a new one.")
                return
            default:
                // Expired, or already used.
                signInWaiting = nil
                signInError = L("That request expired. Send a new one.")
                return
            }
        }
        signInWaiting = nil
        signInError = L("That request expired. Send a new one.")
    }

    /// Local state goes first, so the popover reacts at once even offline.
    func unpair() {
        let token = TokenStore.read()
        loop?.cancel()
        TokenStore.write(nil)
        clearLocal()
        Task { try? await Api(token: token).logout() }
    }

    private func clearLocal() {
        paired = false
        needsSetup = false
        answers = [:]
        day = nil
        dayFetched = nil
        LeaveNotifier.shared.clearLeave()
        nearby = nil
        places = []
        target = .plan
        showNearby = false
        error = nil
    }

    func openLocationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")!)
    }

    /// At most once a day: is there a newer release than this one?
    private func checkForUpdate() {
        let d = UserDefaults.standard
        let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        if let v = d.string(forKey: "latestVersion"), isNewer(v, than: current) { update = v }
        guard Date().timeIntervalSince1970 - d.double(forKey: "updateCheckedAt") > 86_400 else { return }
        Task {
            guard let v = try? await Api(token: nil).latestVersion() else { return }
            d.set(Date().timeIntervalSince1970, forKey: "updateCheckedAt")
            d.set(v, forKey: "latestVersion")
            update = isNewer(v, than: current) ? v : nil
        }
    }

    func askLocation() { locator.ask() }

    /// This Mac's location for setup's "Pick the stop nearest me"; nil if it isn't allowed.
    func whereAmI() async -> CLLocation? { await locator.current(maxAge: 120) }

    /// No home and no timetable yet (the server's "Set up" answer), or a new account.
    var wantsSetup: Bool { paired && (needsSetup || plan?.card?.kind == "setup") }

    // MARK: reports

    func startReport() {
        reported = showNearby ? nil : shown?.raw
        reportNote = ""
        reportResult = nil
        reporting = true
    }

    func cancelReport() {
        reporting = false
        reportResult = nil
    }

    func sendReport() {
        let note = reportNote.trimmingCharacters(in: .whitespacesAndNewlines)
        guard reported != nil || !note.isEmpty else {
            reportResult = L("Say what was wrong: there's no answer on screen to send.")
            return
        }
        reportSending = true
        Task {
            defer { reportSending = false }
            do {
                try await Api(token: TokenStore.read()).report(note: note, answer: reported)
                reporting = false
                reportResult = L("Thanks, sent. It helps make the answers better.")
            } catch let e as ApiError {
                reportResult = e.message
            } catch {
                reportResult = L("Couldn't reach terminus. Try again in a moment.")
            }
        }
    }

    // MARK: what the popover shows

    func select(_ t: Target) {
        target = t
        showNearby = false
        kick()
    }

    func selectNearby() {
        showNearby = true
        kick()
    }

    func loadDestinations() {
        guard destinations.isEmpty else { return }
        Task { destinations = (try? await Api(token: TokenStore.read()).destinations()) ?? [] }
    }

    // MARK: refresh loop

    /// 30 s while the popover is open, 2 min otherwise, 10 min while
    /// resting; nothing while asleep or locked. Also right after the bus
    /// leaves or the plan changes, and soon after a failure. The API caches
    /// each stop for 15 s, so faster shows nothing new.
    // MARK: language (phase 10)

    /// The account's language once per launch: one chosen on another device
    /// shows from the next launch; one chosen here first goes to the account.
    private var langSynced = false
    private func syncLang(_ api: Api) async {
        guard !langSynced, let data = try? await api.profile(), var p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        langSynced = true
        guard let mine = Lang.followAccount(p["lang"] as? String ?? "auto"), let body = try? JSONSerialization.data(withJSONObject: { p["lang"] = mine; return p }()) else { return }
        _ = try? await api.saveProfile(body)
    }

    /// Settings → Language: this Mac and the account, then terminus starts again in it.
    func setLang(_ pref: String) {
        Lang.set(pref)
        Lang.noteAccount(pref)
        Task {
            if let token = TokenStore.read(), let data = try? await Api(token: token).profile(), var p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                p["lang"] = pref
                if let body = try? JSONSerialization.data(withJSONObject: p) { _ = try? await Api(token: token).saveProfile(body) }
            }
            Lang.relaunch()
        }
    }

    private func start() {
        loop?.cancel()
        loop = Task {
            while !Task.isCancelled {
                var ok = true
                if !paused && paired { ok = await refresh() }
                try? await Task.sleep(for: .seconds(nextDelay(failed: !ok)))
            }
        }
    }

    private var failures = 0

    private func nextDelay(failed: Bool) -> TimeInterval {
        failures = failed ? failures + 1 : 0
        // Wi-Fi is often not up yet right after a wake: retry soon, then back off.
        if failed && failures <= 3 { return [5, 15, 45][failures - 1] }
        var d: TimeInterval = popoverOpen ? 30 : resting ? 600 : 120
        let now = Date()
        // nextChange: when the card's phase moves on by itself (the leave-by, a class start).
        for mark in [plan?.departure?.addingTimeInterval(31), plan?.planChanges, plan?.nextChange].compactMap({ $0 }) where mark > now {
            d = min(d, mark.timeIntervalSince(now))
        }
        return max(d, 5)
    }

    private func kick() { start() }

    /// Returns false when the fetch failed, so the loop can retry sooner.
    @discardableResult
    func refresh() async -> Bool {
        guard let token = TokenStore.read() else {
            // Only a missing file means unpaired; a read that failed for
            // another reason must not strand the Mac on the pairing screen.
            if !TokenStore.exists {
                log.notice("no token; showing pairing")
                paired = false
            }
            return true
        }
        guard !refreshing else { return true }
        refreshing = true
        defer { refreshing = false }
        log.debug("refreshing against \(Api.base, privacy: .public)")
        let api = Api(token: token)
        if !langSynced { Task { await syncLang(api) } }
        let loc = await locator.current(maxAge: popoverOpen ? 120 : 600)
        let lat = loc?.coordinate.latitude, lon = loc?.coordinate.longitude
        loading = true
        defer { loading = false }
        do {
            // What's on screen first; the plan (for the menu bar) after.
            if showNearby {
                nearby = try await api.nearby(lat: lat, lon: lon)
            } else if target != .plan {
                answers[target] = try await api.next(target, lat: lat, lon: lon)
            }
            let p = try await api.next(.plan, lat: lat, lon: lon)
            answers[.plan] = p
            places = p.places ?? []
            error = nil
            updated = Date()
            clock = Date()
            LeaveNotifier.shared.update(p)
            if popoverOpen, dayFetched.map({ Date().timeIntervalSince($0) > 120 }) ?? true {
                dayFetched = Date()
                day = try? await api.day()
            }
            return true
        } catch let e as ApiError where e.status == 401 && TokenStore.read() != token {
            // Signed in again while this was in flight: the new token stands.
            return false
        } catch let e as ApiError where e.status == 401 {
            TokenStore.write(nil)
            clearLocal()
            pairError = L("This Mac was signed out of your account. Sign in at %@/account and pair it again.", Api.siteHost)
            return true
        } catch let e as ApiError {
            log.error("api error \(e.status): \(e.message, privacy: .public)")
            error = e.message
            return false
        } catch is DecodingError {
            // Not the network: the API sent something this version can't read.
            error = update != nil ? L("Update terminus to keep going") : L("Unexpected answer from terminus")
            return false
        } catch {
            // kick() restarts the loop and cancels a refresh in flight; that
            // is not an outage.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return true }
            log.error("refresh failed: \(error.localizedDescription, privacy: .public)")
            self.error = L("Offline")
            return false
        }
    }

    private var refreshing = false

    private func observeSleep() {
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = true }
        }
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = false; self?.clock = Date(); self?.kick() }
        }
        ws.addObserver(forName: NSWorkspace.screensDidSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = true }
        }
        ws.addObserver(forName: NSWorkspace.screensDidWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = false; self?.clock = Date(); self?.kick() }
        }
        let dist = DistributedNotificationCenter.default()
        dist.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = true }
        }
        dist.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = false; self?.clock = Date(); self?.kick() }
        }
    }

    private let pathMonitor = NWPathMonitor()
    private var online = true

    /// Refresh the moment the network comes back, instead of waiting out the
    /// loop with "Offline" on screen.
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
