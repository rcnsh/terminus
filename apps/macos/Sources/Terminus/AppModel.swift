import AppKit
import CoreLocation
import Foundation
import IOKit
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
    /// Why this Mac is back on the sign-in screen when it didn't sign out
    /// itself, on every way in; gone once a new sign-in starts.
    var signedOutReason: String?
    /// Bumped whenever the token changes (signed in, signed out): a reply to
    /// a request made with the old one is dropped, not shown for this account.
    private var session = 0
    /// The server answered 426: this version is too old for it. Polling stops
    /// (Outdated) and the popover offers the update.
    var updateRequired = false

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

    /// Started without an email (`/auth/anon`): an account of its own for this
    /// Mac, as the phone's first launch. Adding an email keeps or merges it.
    var anonymous = UserDefaults.standard.bool(forKey: "anonymous") {
        didSet { UserDefaults.standard.set(anonymous, forKey: "anonymous") }
    }
    /// Adding an email to an account that, like this Mac, has a setup: which to keep.
    var chooseSetup: (token: String, email: String)?
    /// This Mac's email-less token while an email is being added, for the merge.
    private var anonToken: String?

    /// Places gone to from the search or the map, each with a tab and an ×, as
    /// on the phone and the web: up to 5, newest first, on this Mac only.
    struct AddedPlace: Codable, Hashable { let code: String; let label: String }
    static let maxAdded = 5
    var added: [AddedPlace] = (UserDefaults.standard.data(forKey: "addedPlaces")).flatMap { try? JSONDecoder().decode([AddedPlace].self, from: $0) } ?? [] {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(added), forKey: "addedPlaces") }
    }

    /// Always the planned trip: this is what the menu bar shows. Kept apart
    /// from the other tabs' answers, so one of those arriving doesn't redraw
    /// the menu bar.
    private(set) var plan: NextAnswer?
    private var otherAnswers: [Target: NextAnswer] = [:]
    var target: Target = .plan
    /// The last answer per view. Switching views shows the cached one at once
    /// and refreshes it in place, instead of blanking the popover (which made
    /// it collapse and then grow back when the data arrived).
    var answers: [Target: NextAnswer] {
        get { var a = otherAnswers; a[.plan] = plan; return a }
        set { plan = newValue[.plan]; otherAnswers = newValue.filter { $0.key != .plan } }
    }
    var shown: NextAnswer? { target == .plan ? plan : otherAnswers[target] }
    var showNearby = false
    var nearby: [NearbyStop]?
    var loading = false
    var places: [Place] = []
    var destinations: [Destination] = []

    var error: String?
    var updated: Date?

    /// Today, for the popover, and kept for when the Mac goes offline (OfflineDay).
    var day: DayPlan?
    private var dayFetched: Date?
    /// Just taken off Today, offered back with Undo for a few seconds, in its
    /// row so nothing below it moves: above the entry that followed it
    /// (`removedBefore`, nil at the end), or at `removedAt` should that one go too.
    var removed: DayPlan.Item?
    var removedAt = 0
    var removedBefore: String?
    private var removedTask: Task<Void, Never>?
    /// A removal the server refused: the entry is back in its place, the reason under it.
    var removeFailed: (key: String, message: String)?
    private var removeFailedTask: Task<Void, Never>?

    /// "Notify me when to leave for class" (phase 7), mirrored from LeaveNotifier.
    private(set) var leaveAlerts = LeaveNotifier.shared.enabled

    /// The pane Settings is asked to show, when it opens or now; it clears it
    /// once shown. A report from an account without an email asks for Account.
    var settingsPane: SettingsPane?

    /// "Is this wrong?": the form is open, what's typed, and how sending went.
    var reporting = false
    var reportNote = ""
    var reportSending = false
    var reportResult: String?
    /// The last report went: "✓ Reported, thanks" under the answer, where the form was.
    var reportSent = false
    /// The card's line when it went: once the card says something else, it's another answer.
    private var reportSentLine: String?
    private var reportClear: Task<Void, Never>?
    /// The tick shows for a few seconds, and only beside the answer it was sent from.
    var showReported: Bool { reportSent && shown?.card?.line == reportSentLine }
    /// The answer on screen when the form opened; the refresh loop may replace it meanwhile.
    private var reported: Data?
    var popoverOpen = false {
        didSet {
            guard popoverOpen != oldValue else { return }
            if popoverOpen {
                // Someone is clicking it: whatever said the Mac was asleep or
                // locked, it isn't now (a missed wake would stop refreshes).
                asleep = false; screensAsleep = false; locked = false
                refreshLoginItem()
                kick()
            } else {
                Updater.shared.popoverClosed()
            }
        }
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

    /// Ticks every 30 s for the menu bar's countdown, on the server's clock.
    var clock = ServerClock.now
    private var clockTask: Task<Void, Never>?

    private let locator = Locator()
    /// Each on its own: the Mac asleep, its screens asleep, the screen locked.
    /// Refreshes wait while any of them is so, and come back once none is.
    private var asleep = false
    private var screensAsleep = false
    private var locked = false
    private var paused: Bool { asleep || screensAsleep || locked }
    private var resumeTask: Task<Void, Never>?
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
                self.catchUpClock()
            }
        }
    }

    /// The clock moved on, set only when the title or the dimming would
    /// change: every assignment redraws the menu bar.
    private func catchUpClock() {
        let now = ServerClock.now
        if menuTitle(at: now) != menuTitle(at: clock) || isOld(plan, at: now) != isOld(plan, at: clock) {
            clock = now
        }
    }

    /// Outside the user's day the plan rests: no bus, a moon in the menu bar.
    var resting: Bool { plan?.mode == "rest" }

    /// Offline (the last refresh failed) with the plan gone stale, or none
    /// yet: the next thing on the day plan kept for it.
    func offlinePick(at now: Date) -> OfflineDay.Pick? {
        guard error != nil, plan == nil || isOld(plan, at: now) else { return nil }
        return OfflineDay.next(day, now: now)
    }

    /// The menu bar text at `now` (on the server's clock): the card's glance,
    /// worded on the server as the phone's widget shows it, or nil for the
    /// plain icon. An answer from an older server, without a card, counts
    /// down from its departure time here. Offline with the plan gone stale
    /// and no day plan to fall back on, the plain icon: the old glance would
    /// pass for current.
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
        return left < 45 ? "\(plan.service) \(L("now"))" : "\(plan.service) \(plan.quality == "scheduled" ? L("~%@", mins) : mins)"
    }

    /// Dimmed once the server's `card.staleAt` has passed (`now` on the
    /// server's clock), the rule every client follows. A card without one
    /// never dims (nothing on it goes out of date: setup, rest, free); only
    /// an answer with no card at all is old from the start.
    func isOld(_ a: NextAnswer?, at now: Date) -> Bool {
        guard let a else { return false }
        guard let card = a.card else { return true }
        return card.staleAt.flatMap(parseISODate).map { now >= $0 } ?? false
    }

    // MARK: pairing

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

    /// This Mac as the account's device list shows it: its model, never the
    /// name it was given ("Alex's MacBook Pro"), which would say who owns it.
    private var deviceName: String { macModelName(productName: Self.productName(), hwModel: Self.hwModel()) }

    /// "MacBook Pro (16-inch, M5 Pro)", from the device tree (Apple silicon only).
    private static func productName() -> String? {
        let entry = IORegistryEntryFromPath(kIOMainPortDefault, "IODeviceTree:/product")
        guard entry != 0 else { return nil }
        defer { IOObjectRelease(entry) }
        guard let data = IORegistryEntryCreateCFProperty(entry, "product-name" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? Data else { return nil }
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: CharacterSet(charactersIn: "\0").union(.whitespaces))
    }

    /// "MacBookPro16,1" on an Intel Mac.
    private static func hwModel() -> String? {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [UInt8](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &buf, &size, nil, 0) == 0 else { return nil }
        return String(decoding: buf.prefix { $0 != 0 }, as: UTF8.self)
    }

    // MARK: trip signals

    var signalling = false

    /// "Leave earlier" or "No thanks" on a suggestion; the card comes back without it.
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

    /// The × on a Today row, or "Not going" on the card: taken off today,
    /// whatever it is (a timetabled class, one you added, the trip home).
    /// Gone at once, with Undo in its row.
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
        let at = removedAt, date = day?.date
        Task {
            // Refused (or offline): back where it was, with why under it, as on the web.
            if let message = await send(CardAction(id: "skipped", label: "", trip: item.key), token: token, showingError: false) {
                if removed?.key == item.key { removed = nil; removedTask?.cancel() }
                // Only into the day it was taken off: past midnight, Today is another list.
                if day?.date == date, day?.items.contains(where: { $0.key == item.key }) == false { day?.items.insert(item, at: min(at, day?.items.count ?? 0)) }
                removeFailed = (item.key, message)
                removeFailedTask?.cancel()
                removeFailedTask = Task {
                    try? await Task.sleep(for: .seconds(6))
                    if !Task.isCancelled { removeFailed = nil }
                }
            }
        }
    }

    /// Undo on the bar: back on today's list.
    func undoRemove() {
        guard let item = removed, let token = TokenStore.read() else { return }
        removed = nil
        removedTask?.cancel()
        Task { await send(CardAction(id: "reset", label: "", trip: item.key), token: token) }
    }

    /// A signal, then the plan and Today again: "Not going", "Undo" and "Back
    /// on campus" change Today too, now rather than at the next refresh.
    /// Nil once it's done, else why it wasn't (also the popover's error,
    /// unless the caller shows it itself).
    @discardableResult
    private func send(_ action: CardAction, token: String, showingError: Bool = true) async -> String? {
        let gen = session
        do {
            let api = Api(token: token)
            let a = try await api.signal(action)
            // Signed out meanwhile: the reply is the old account's.
            guard gen == session else { return nil }
            plan = a
            updated = ServerClock.now
            planFetched = Date()
            error = nil
            LeaveNotifier.shared.update(a)
            dayFetched = Date()
            // A failed fetch keeps the plan there was (offline falls back to
            // it), and the next refresh asks again.
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

    /// A card button: "On the D2", "Missed it", "Not going". Recorded for every
    /// device; the answer that comes back replaces the planned one.
    func signal(_ action: CardAction) {
        // "Not going" is the × on Today by another name: the same way off the
        // list, with the same Undo in its row (as on Android).
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

    // MARK: starting without an email

    var startingAnon = false

    /// "Use terminus without an email": an account for this Mac alone, with no sign-in.
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

    /// An account without an email: everything goes, and this Mac starts over.
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

    // MARK: places added from the search

    func addPlace(code: String, label: String) {
        if added.contains(where: { $0.code == code }) || places.contains(where: { $0.label.caseInsensitiveCompare(label) == .orderedSame }) { return }
        added = Array(([AddedPlace(code: code, label: label)] + added).prefix(Self.maxAdded))
    }

    /// The × on an added place's tab: gone, and back to Next if it was showing.
    func removeAdded(_ p: AddedPlace) {
        added.removeAll { $0.code == p.code }
        if case .code(let c, _) = target, c == p.code { select(.plan) }
    }

    // MARK: going later (phase 8.3)

    /// "Go later today at…": a one-off trip to what's on screen, planned like a class.
    func goLater(atMin: Int) async -> String? {
        guard let token = TokenStore.read(), target != .plan else { return nil }
        let gen = session
        do {
            let a = try await Api(token: token).once(target, atMin: atMin)
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
            return failureMessage(error, otherwise: L("Couldn't add it. Check your connection."))
        }
    }

    // MARK: signing in by email

    /// Emails a link that approves this Mac from any device (the phone's mail
    /// app, say): the page asks for the number shown here. Universal links
    /// would need a paid Apple team; this needs nothing.
    func signIn(email: String) {
        signingIn = true
        signInError = nil
        signedOutReason = nil
        signInTask?.cancel()
        signInTask = Task {
            do {
                // Adding an email to this Mac's own account: it's sent, so the server keeps or merges its setup.
                anonToken = anonymous ? TokenStore.read() : nil
                let r = try await Api(token: anonToken).signInStart(email: email, name: deviceName)
                // Given up (cancelSignIn, signed out) or replaced by a newer
                // signIn, which owns signingIn and anonToken from here.
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

    /// The code from the email, typed in: signs in straight away when it's right.
    func enterCode(_ code: String) {
        guard let r = signInRequest, !signingIn else { return }
        signingIn = true
        signInError = nil
        Task {
            do {
                let p = try await Api(token: nil).signInCode(r, code: code)
                signingIn = false
                // Approved meanwhile by the email's link, or given up on.
                guard signInRequest == r else { return }
                if p.status == "approved" {
                    signInTask?.cancel()
                    signedIn(p)
                }
            } catch {
                signingIn = false
                guard signInRequest == r else { return }
                signInError = failureMessage(error)
                // Too many wrong codes, or out of time: this request is over,
                // so the wait ends with that, not "cancelled from the email".
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
        // Both this Mac and the account have a setup: ask which to keep first.
        if p.outcome == "choose", let token = p.token, anonToken != nil {
            signInWaiting = nil
            chooseSetup = (token, p.email ?? "")
            return
        }
        finishSignIn(p)
    }

    /// The choice after adding an email: the account's setup, or this Mac's.
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
                    // This Mac's account is already gone: an earlier try merged
                    // it and only the reply was lost. Nothing left to keep.
                } catch {
                    // Not merged: the choice stays up, with this Mac's account
                    // kept, so a second try can still keep its setup.
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
        // Approved, but the token was handed out already (an earlier poll whose reply was lost).
        guard let token = p.token else {
            signInError = L("That sign-in was already used. Send a new one.")
            return
        }
        guard TokenStore.write(token) else {
            signInError = L("Couldn't save the sign-in on this Mac. Check that there's enough disk space, then try again.")
            return
        }
        session += 1
        // A brand-new account has nothing to show yet.
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

    /// Every 3 seconds, for the request's 15 minutes.
    private func pollSignIn(_ r: SignInRequest) async {
        let until = Date().addingTimeInterval(15 * 60)
        while Date() < until {
            try? await Task.sleep(for: .seconds(3))
            if Task.isCancelled || signInRequest != r { return }
            let p = try? await Api(token: nil).signInPoll(r)
            // The code typed meanwhile may have signed in already (or the wait
            // was given up): this answer is for a request that's over.
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
                // Expired, or already used.
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

    /// Local state goes first, so the popover reacts at once even offline.
    func unpair() {
        let token = TokenStore.read()
        loop?.cancel()
        TokenStore.write(nil)
        clearLocal()
        Task { try? await Api(token: token).logout() }
    }

    /// Everything of the account's on this Mac goes, and any request still
    /// in flight for it is dropped when it answers (`session`).
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
    }

    func openLocationSettings() {
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")!)
    }

    /// At most once a day: is there a newer release than this one?
    private func checkForUpdate() {
        let d = UserDefaults.standard
        let current = Api.version ?? "0"
        let check = Self.updateCheck(cached: d.string(forKey: "latestVersion"), checkedAt: d.double(forKey: "updateCheckedAt"), current: current, now: Date().timeIntervalSince1970)
        update = check.update
        guard check.fetch else { return }
        Task {
            guard let v = try? await Api(token: nil).latestVersion() else { return }
            d.set(Date().timeIntervalSince1970, forKey: "updateCheckedAt")
            d.set(v, forKey: "latestVersion")
            update = isNewer(v, than: current) ? v : nil
        }
    }

    /// What the last check said (`cached`, a version newer than the running
    /// one, else none), and whether to ask again: a day after the last
    /// answer (`checkedAt`, seconds since 1970, as `now` is).
    nonisolated static func updateCheck(cached: String?, checkedAt: Double, current: String, now: Double) -> (update: String?, fetch: Bool) {
        (cached.flatMap { isNewer($0, than: current) ? $0 : nil }, now - checkedAt > 86_400)
    }

    func askLocation() { locator.ask() }

    /// This Mac's location for setup's "Pick the stop nearest me"; nil if it
    /// isn't allowed, or too rough to pick a stop by (over 200 m, as the server judges).
    func whereAmI() async -> CLLocation? {
        guard let fix = await locator.current(maxAge: 120),
              let acc = fixUncertaintyM(accuracy: fix.horizontalAccuracy, ageS: -fix.timestamp.timeIntervalSinceNow), acc <= 200 else { return nil }
        return fix
    }

    /// No home and no timetable yet (the server's "Set up" answer), or a new account.
    var wantsSetup: Bool { paired && (needsSetup || plan?.card?.kind == "setup") }

    // MARK: reports

    func startReport() {
        reported = showNearby ? nil : shown?.raw
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
        // The server takes no report without a note; Send is off until there is one.
        guard !note.isEmpty else { return }
        reportSending = true
        Task {
            defer { reportSending = false }
            do {
                try await Api(token: TokenStore.read()).report(note: note, answer: reported)
                reporting = false
                reportSent = true
                reportSentLine = shown?.card?.line
                // A moment's acknowledgement, then "Is this wrong?" is back for the next answer.
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

    // MARK: what the popover shows

    func select(_ t: Target) {
        // "Reported" was for the answer on the tab it was sent from.
        if t != target { reportSent = false }
        target = t
        showNearby = false
        kick()
    }

    /// A search result: a favourite's own tab if it's one, else a tab of its own.
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
        Task { destinations = (try? await Api(token: TokenStore.read()).destinations()) ?? [] }
    }

    // MARK: language (phase 10)

    /// The account's language once per launch: one chosen on another device
    /// shows from the next launch; one chosen here first goes to the account.
    private var langSynced = false
    private func syncLang(_ api: Api) async {
        let gen = session
        guard !langSynced, let data = try? await api.profile(), gen == session, var p = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
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

    // MARK: refresh loop

    /// How a refresh went: the loop retries sooner after a failure, and the
    /// leave reminders are confirmed only by a fetch that really happened.
    enum Fetch { case done, failed, skipped }

    /// 30 s while the popover is open, 5 min otherwise, 10 min while
    /// resting, twice as long in Low Power Mode; nothing while asleep,
    /// locked or offline. Also right after the bus leaves or the plan
    /// changes, and soon after a failure. The API caches each stop for 15 s,
    /// so faster shows nothing new.
    private func start() {
        loop?.cancel()
        loop = Task {
            while !Task.isCancelled {
                var result = Fetch.skipped
                if !paused && paired {
                    if online {
                        result = await refresh()
                    } else if error == nil {
                        // Nothing to ask without a network; the loop starts again when it's back.
                        error = L("Offline")
                    }
                    // The leave reminders say whether their times still stand.
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
    /// How long the server last asked to be left alone (Retry-After on a 429 or 503).
    private var serverWait: TimeInterval?

    private func nextDelay(failed: Bool) -> TimeInterval {
        failures = failed ? failures + 1 : 0
        return Self.nextDelay(
            failures: failures, popoverOpen: popoverOpen, resting: resting, plan: plan, now: ServerClock.now,
            updateRequired: updateRequired, serverWait: serverWait, lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled
        )
    }

    /// How long the refresh loop waits, after `failures` failed refreshes
    /// in a row (0: the last one answered). `now` is on the server's clock.
    /// `serverWait` is the last failure's Retry-After; `lowPower`, Low Power
    /// Mode, which doubles the usual waits.
    nonisolated static func nextDelay(
        failures: Int, popoverOpen: Bool, resting: Bool, plan: NextAnswer?, now: Date,
        updateRequired: Bool = false, serverWait: TimeInterval? = nil, lowPower: Bool = false
    ) -> TimeInterval {
        // Too old for the server: every ask would be refused until an update.
        if updateRequired { return Outdated.holdS }
        // Never sooner than the server asked, up to an hour.
        let floor = failures > 0 ? min(serverWait ?? 0, 3600) : 0
        // Wi-Fi is often not up yet right after a wake: retry soon, then back off.
        if failures > 0 && failures <= 3 { return max([5, 15, 45][failures - 1], floor) }
        var d: TimeInterval = (popoverOpen ? 30 : resting ? 600 : 300) * (lowPower ? 2 : 1)
        // nextChange: when the card's phase moves on by itself (the leave-by, a class start).
        for mark in [plan?.departure?.addingTimeInterval(31), plan?.planChanges, plan?.nextChange].compactMap({ $0 }) where mark > now {
            d = min(d, mark.timeIntervalSince(now))
        }
        // A leave-by that keeps sliding (a late bus) would otherwise bring the
        // refresh down to seconds; the server's own trip engine waits 30 s too.
        return max(d, lowPower ? 60 : 30, floor)
    }

    private func kick() { start() }

    /// The map was refused (401 or 426): refresh now, so the popover's own
    /// handling (signing out, the update banner) follows at once rather than
    /// at the next turn of the loop, up to 10 minutes later.
    func mapRefused() {
        guard paired, !updateRequired else { return }
        kick()
    }

    /// When the plan was last fetched (this Mac's clock), and how long one
    /// fetched for the menu bar alone, off its tab, is kept.
    var planFetched: Date?
    static let planReuseS: TimeInterval = 300

    /// Off the plan's tab, the plan is wanted only for the menu bar, the
    /// tabs and the leave reminder: a recent one does, until it's 5 minutes
    /// old or one of its own times (the bus leaving, refreshAt, the phase
    /// moving on, staleAt) has passed. `now` is on the server's clock.
    func planDue(at now: Date, local: Date = Date()) -> Bool {
        guard let plan, let fetched = planFetched, local.timeIntervalSince(fetched) < Self.planReuseS else { return true }
        let marks = [plan.departure?.addingTimeInterval(31), plan.planChanges, plan.nextChange, plan.staleAt].compactMap { $0 }
        return marks.contains { $0 <= now }
    }

    /// Whether a refresh asks where the Mac is: not while resting with the
    /// popover closed, unless one of the plan's own times has passed (the
    /// rest ending), when the next card's walk needs the place it starts from.
    func wantsFix(at now: Date) -> Bool {
        guard !popoverOpen, resting, let plan else { return true }
        let marks = [plan.planChanges, plan.nextChange, plan.staleAt].compactMap { $0 }
        return marks.contains { $0 <= now }
    }

    /// `.failed` when the fetch failed, so the loop can retry sooner;
    /// `.skipped` when nothing was fetched (one already running, signed out).
    @discardableResult
    func refresh() async -> Fetch {
        guard let token = TokenStore.read() else {
            // Only a missing file means unpaired; a read that failed for
            // another reason must not strand the Mac on the pairing screen.
            if !TokenStore.exists {
                log.notice("no token; showing pairing")
                paired = false
            }
            return .skipped
        }
        // One in flight already (say, one a tab switch just cancelled): run
        // again once it's done, or the new tab would wait out the whole delay.
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
        // Signed out or in again while a request is out: its answer is dropped.
        let gen = session
        let api = Api(token: token)
        if !langSynced { Task { await syncLang(api) } }
        // Resting with the popover closed, nothing is planned until the day
        // starts: no need to wake CoreLocation for it.
        let located = wantsFix(at: ServerClock.now)
        let fix = located ? await locator.current(maxAge: popoverOpen ? 120 : 600) : nil
        let acc = fix.flatMap { fixUncertaintyM(accuracy: $0.horizontalAccuracy, ageS: -$0.timestamp.timeIntervalSinceNow) }
        // An invalid fix is no location at all.
        let loc = acc == nil ? nil : fix
        let lat = loc?.coordinate.latitude, lon = loc?.coordinate.longitude
        loading = true
        defer { loading = false }
        do {
            // What's on screen first; the plan (for the menu bar) after.
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
                // A favourite removed elsewhere leaves no tab to show it under.
                if case .place(let key) = target, !places.contains(where: { $0.key == key }) { target = .plan }
                LeaveNotifier.shared.update(p)
                // The rest ended earlier than its marks said: this card's walk
                // starts from home, so ask again from where the Mac is.
                if !located && p.mode != "rest" { rerun = true }
            }
            if error != nil { error = nil }
            if updateRequired { updateRequired = false }
            serverWait = nil
            updated = ServerClock.now
            catchUpClock()
            // Today: while the popover is open, at most every 2 minutes; and,
            // for when the Mac goes offline (OfflineDay), whenever the one kept
            // is another day's or an hour old.
            let dayAge = dayFetched.map { Date().timeIntervalSince($0) } ?? .infinity
            if (popoverOpen && dayAge > 120) || dayAge > 3600 || day?.date != OfflineDay.sgtDate(ServerClock.now) {
                dayFetched = Date()
                // A failed fetch keeps the plan there was: it's what offline falls back to.
                let d = try? await api.day(lat: lat, lon: lon, acc: acc)
                guard gen == session else { return .skipped }
                if let d { day = d }
            }
            return .done
        } catch where gen != session {
            // Signed out, or in again, while this was in flight: not this account's.
            return .skipped
        } catch let e as ApiError where e.status == 401 && TokenStore.read() != token {
            // Signed in again while this was in flight: the new token stands.
            return .skipped
        } catch let e as ApiError where e.status == 401 {
            // Adding an email to this Mac's own account: the server may remove
            // that account a moment before it hands over the new token
            // (applogin.ts). Not signed out; ask again shortly. Only while the
            // request is open (15 minutes at most) or the choice is up: one
            // given up on or expired leaves a 401 that means signed out.
            if anonymous && (signInRequest != nil || chooseSetup != nil) { return .failed }
            // Worded before clearLocal forgets which kind of account it was:
            // one without an email goes after 60 days unused.
            let reason = anonymous
                ? L("This Mac's setup was removed after a long time unused. Start again or sign in.")
                : L("This Mac was signed out of your account. Sign in again to carry on.")
            TokenStore.write(nil)
            clearLocal()
            signedOutReason = reason
            return .skipped
        } catch let e as ApiError where e.updateRequired {
            log.notice("426: this version is too old for the server")
            updateRequired = true
            error = e.message
            return .failed
        } catch let e as ApiError {
            log.error("api error \(e.status): \(e.message, privacy: .public)")
            serverWait = e.retryAfter
            error = e.message
            return .failed
        } catch is DecodingError {
            // Not the network: the API sent something this version can't read.
            error = update != nil ? L("Update terminus to continue") : L("terminus sent something this version can't read.")
            return .failed
        } catch {
            // kick() restarts the loop and cancels a refresh in flight; that
            // is not an outage.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return .skipped }
            log.error("refresh failed: \(error.localizedDescription, privacy: .public)")
            self.error = L("Offline")
            return .failed
        }
    }

    private var refreshing = false
    /// A refresh was asked for while one was running.
    private var rerun = false

    /// Paused while the Mac sleeps, its screens sleep or it's locked, each
    /// kept apart: back with one refresh and the clock caught up once none
    /// of them is so (the lock screen after a wake still counts as locked).
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
        // Waking, the screen may still be locked: ask rather than assume,
        // as the lock notice may have come before the sleep, or not at all.
        if !on && flag != .lock { locked = Self.screenLocked() }
        if paused {
            resumeTask?.cancel()
            // Nothing refreshes them until it's back.
            LeaveNotifier.shared.unconfirmed(since: updated)
        } else if was {
            // A wake brings several of these at once (the Mac, its screens,
            // the unlock): one refresh, after the last of them.
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
    /// Whether this Mac has a network path, for the map's "need a connection".
    private(set) var online = true

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

/**
 * The device name an anonymous Mac reports: the model, as the device list
 * shows it, and never the computer's own name. The device tree's product
 * name when there is one; else the family from hw.model ("MacBookAir7,2"
 * is a MacBook Air); else "Mac". At most 40 characters, as the server keeps.
 */
func macModelName(productName: String?, hwModel: String?) -> String {
    if let p = productName?.trimmingCharacters(in: .whitespaces), !p.isEmpty { return String(p.prefix(40)) }
    let families: [(String, String)] = [("MacBookPro", "MacBook Pro"), ("MacBookAir", "MacBook Air"), ("MacBook", "MacBook"), ("Macmini", "Mac mini"), ("MacPro", "Mac Pro"), ("iMacPro", "iMac Pro"), ("iMac", "iMac")]
    let model = hwModel ?? ""
    // iMacPro before iMac: the longest prefix wins.
    return families.sorted { $0.0.count > $1.0.count }.first { model.hasPrefix($0.0) }?.1 ?? "Mac"
}
