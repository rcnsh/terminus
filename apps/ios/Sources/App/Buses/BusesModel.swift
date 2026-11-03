import Foundation
import Observation

/// Whether the account's pins are known yet: the home shows them only once they are.
enum BusPinsState { case loading, ready, failed }

/// The Stops tab's data, as Android's BusesViewModel. The screens drive the
/// refreshing, only while the tab is on screen and the app in front: what's
/// in view every 15 s (the pinned stop showing on the home and the one either
/// side, or the page over it), the API's own cache, so asking sooner would
/// show nothing new; the lines' buses out once a minute. A failed refresh
/// keeps the last answer.
@MainActor @Observable
final class BusesModel {
    static let shared = BusesModel()

    /// The stops and services, for the search and names before a board loads.
    private(set) var campus: BusCampus?
    /// Boards by stop code: pinned stops, opened ones, the twins across the road.
    private(set) var boards: [String: Board] = [:]
    /// Stops whose board couldn't be fetched (offline), until one is.
    private(set) var failed: Set<String> = []
    /// Pages switched to the stop across the road, by the page's own stop.
    private(set) var across: Set<String> = []
    /// Lines by `lineKey`.
    private(set) var lines: [String: Line] = [:]
    private(set) var lineFailed: Set<String> = []

    /// The pinned stops as Nearby shows them (/me/stops), by code.
    private(set) var pinned: [String: NearbyStop] = [:]
    private(set) var pinnedFailed: Set<String> = []
    /// The page showing on the home: a pinned stop, or BusPinned.addPage; nil, the first.
    /// Kept while the app runs, so coming back to the tab finds the same stop.
    var pinSelected: String?
    /// Each service's buses out (/api/lines); a service left out says nothing.
    private(set) var lineCounts: [String: LineCount] = [:]
    /// When they were last asked for: at most once every BusLines.pollS.
    private(set) var linesAskedAt: Date?

    /// The account's pinned stops, its limit, and whether boards have the public buses too.
    private(set) var pins: [String] = []
    private(set) var pinsState = BusPinsState.loading
    private(set) var pinLimit = BusPins.defaultMax
    private(set) var publicBuses = false

    /// The pages opened over the home, the top one last.
    var path: [BusRoute] = []
    /// A short note at the foot of the screen: how a pull went, the pins full.
    private(set) var note: String?
    private var noteTask: Task<Void, Never>?

    /// When the timed refresh next runs, for a pull that asked nothing.
    var nextTimedAt: Date?

    /// When each board or line was last asked for, so going back and forth doesn't ask again at once.
    private var asked: [String: Date] = [:]
    /// When each last came back, for a pull sooner than Pull.freshS to ask nothing.
    private var answeredAt: [String: Date] = [:]
    /// The ones on their way, so a pull waits for one rather than asking twice.
    private var asking: Set<String> = []
    private var session = -1

    /// Shorter than the refresh, so the 15 s tick always asks; longer than a swipe back.
    static let minGapS: TimeInterval = 10

    static func lineKey(_ svc: String, _ from: String?) -> String { "\(svc)|\(from ?? "")" }

    private var token: String? { AppModel.shared.token }

    /// Still the account a request was made for: one from before a sign-in or sign-out is dropped.
    private func current(_ s: Int) -> Bool { s == AppModel.shared.session }

    /// A new account (or none) starts the tab afresh.
    /// A new language: each board is asked for again as it next shows, in it.
    /// What's there stays until then, rather than the page going blank.
    func languageChanged() {
        answeredAt = [:]
    }

    func sync() {
        let s = AppModel.shared.session
        guard s != session else { return }
        session = s
        campus = nil
        boards = [:]
        failed = []
        across = []
        lines = [:]
        lineFailed = []
        pinned = [:]
        pinnedFailed = []
        pinSelected = nil
        lineCounts = [:]
        linesAskedAt = nil
        pins = []
        pinsState = .loading
        publicBuses = false
        path = []
        asked = [:]
        answeredAt = [:]
    }

    /// A 401: this phone's token was refused, so it's signed out and the screen follows.
    private func refused(_ e: Error, _ token: String) -> Bool {
        guard let e = e as? ApiError, e.status == 401 else { return false }
        AppModel.shared.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
        return true
    }

    private func fresh(_ key: String) -> Bool {
        guard let at = asked[key] else { return false }
        return Date().timeIntervalSince(at) < Self.minGapS
    }

    private func fetching(_ key: String, _ body: () async -> Void) async {
        asking.insert(key)
        defer { asking.remove(key) }
        await body()
    }

    // MARK: the campus and the profile

    func loadCampus() async {
        guard campus == nil, let token else { return }
        do {
            campus = try await Api(token: token).busCampus()
        } catch {
            // Without it, names come with the boards.
            _ = refused(error, token)
        }
    }

    /// The pins and "public buses" from the profile; asked each time the tab
    /// shows, so a change in Settings is here when you come back.
    func loadProfile() async {
        guard let token else { return }
        let s = AppModel.shared.session
        do {
            let p = try await Api(token: token).profile()
            guard current(s) else { return }
            apply(p)
        } catch {
            guard current(s) else { return }
            // Known once already: the pins stay as they were.
            if pinsState != .ready { pinsState = .failed }
        }
    }

    private func apply(_ p: [String: Any]) {
        setPins((p["pinnedStops"] as? [String]) ?? [])
        pinsState = .ready
        if let limits = p["limits"] as? [String: Any], let n = limits["pinnedStops"] as? Int { pinLimit = n }
        let pub = (p["publicBuses"] as? Bool) ?? false
        // A change asks again at the next refresh rather than waiting out the gap.
        if pub != publicBuses { asked = [:] }
        publicBuses = pub
    }

    /// Pins stop `code`, or unpins it. Saved to the account at once; put back if that fails.
    func togglePin(_ code: String) {
        guard let token else { return }
        if !pins.contains(code), pins.count >= pinLimit {
            say(L("You can pin up to %@ stops", "\(pinLimit)"))
            return
        }
        let before = pins
        setPins(BusPins.toggle(pins, code, max: pinLimit))
        let s = AppModel.shared.session
        Task {
            do {
                // The profile as it is now, so nothing else changed elsewhere is lost.
                let fallback = pinLimit
                let saved = try await Api(token: token).changeProfile { p in
                    let saved = (p["pinnedStops"] as? [String]) ?? []
                    let limit = ((p["limits"] as? [String: Any])?["pinnedStops"] as? Int) ?? fallback
                    p["pinnedStops"] = BusPins.toggle(saved, code, max: limit)
                }
                guard current(s) else { return }
                apply(saved)
            } catch {
                guard current(s) else { return }
                if refused(error, token) { return }
                setPins(before)
                say(L("Couldn't save. Try again."))
            }
        }
    }

    /// New pins, and the home's page kept sensible: one unpinned gives way to the next.
    private func setPins(_ new: [String]) {
        let old = shownPins
        pins = new
        pinSelected = BusPinned.selection(old: old, new: shownPins, selected: pinSelected)
    }

    // MARK: boards

    func refreshBoard(_ code: String, force: Bool = false) async {
        if !force && fresh(code) { return }
        guard let token else { return }
        asked[code] = Date()
        let s = AppModel.shared.session
        await fetching(code) {
            do {
                let b = try await Api(token: token).board(stop: code, publicBuses: publicBuses)
                // Asked for by the account before a sign-in or sign-out, with its public buses setting.
                guard current(s) else { return }
                answeredAt[code] = Date()
                boards[code] = b
                failed.remove(code)
            } catch {
                guard current(s) else { return }
                if refused(error, token) { return }
                failed.insert(code)
            }
        }
    }

    /// The board the page for `code` shows: its own, or its opposite stop's.
    func pageBoard(_ code: String) -> String {
        if across.contains(code), let o = boards[code]?.opposite { return o }
        return code
    }

    func refreshPage(_ code: String, force: Bool = false) async {
        await refreshBoard(pageBoard(code), force: force)
    }

    /// The pinned stops the home shows, at most the profile's limit.
    var shownPins: [String] { BusPins.shown(pins, max: pinLimit) }

    /// The pinned stop the home is showing, or the last for the page after them.
    var pinFocus: String? { BusPinned.focus(shownPins, selected: pinSelected) }

    /// The pinned stop showing on the home and the one either side, in one
    /// request; those asked for within minGapS aren't asked again unless forced.
    /// Walked from where you are only when the phone already may say.
    func refreshPinned(force: Bool = false) async {
        guard let token else { return }
        let window = BusPinned.window(shownPins, selected: pinSelected)
        let codes = BusPinned.toFetch(window, now: Date(), gap: Self.minGapS, force: force) { asked["pin:" + $0] }
        guard !codes.isEmpty else { return }
        let now = Date()
        for c in codes {
            asked["pin:" + c] = now
            asking.insert("pin:" + c)
        }
        defer { for c in codes { asking.remove("pin:" + c) } }
        let s = AppModel.shared.session
        let (loc, _) = await Locator.shared.quickFix()
        do {
            let stops = try await Api(token: token).pinnedStops(
                codes, lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
            guard current(s) else { return }
            let at = Date()
            for stop in stops {
                pinned[stop.stop.code] = stop
                answeredAt["pin:" + stop.stop.code] = at
            }
            pinnedFailed.subtract(codes)
        } catch {
            guard current(s) else { return }
            if refused(error, token) { return }
            pinnedFailed.formUnion(codes)
        }
    }

    /// A pinned stop's short name, as on its plate, for the names over the card.
    func pinName(_ code: String) -> String {
        pinned[code]?.stop.name ?? campus?.stop(code)?.name ?? code
    }

    // MARK: the lines' buses out

    /// How many buses each line has out. A failure says nothing rather than an old count.
    func refreshLines() async {
        guard let token else { return }
        linesAskedAt = Date()
        let s = AppModel.shared.session
        do {
            let counts = try await Api(token: token).lineCounts()
            guard current(s) else { return }
            lineCounts = counts
        } catch {
            guard current(s) else { return }
            if refused(error, token) { return }
            lineCounts = [:]
        }
    }

    /// This side or across the road, for the page of stop `code`.
    func setAcross(_ code: String, _ on: Bool) {
        if on { across.insert(code) } else { across.remove(code) }
        guard let o = boards[code]?.opposite else { return }
        Task { await refreshBoard(on ? o : code) }
    }

    // MARK: lines

    func refreshLine(_ svc: String, from: String?, force: Bool = false) async {
        let key = Self.lineKey(svc, from)
        if !force && fresh("line:" + key) { return }
        guard let token else { return }
        asked["line:" + key] = Date()
        let s = AppModel.shared.session
        await fetching("line:" + key) {
            let api = Api(token: token)
            do {
                let l = try await api.line(svc: svc, stop: from)
                guard current(s) else { return }
                lines[key] = l
                answeredAt["line:" + key] = Date()
                lineFailed.remove(key)
            } catch {
                guard current(s) else { return }
                if refused(error, token) { return }
                // The stop isn't on this service: the line without it.
                if from != nil, let e = error as? ApiError, e.status == 400, let l = try? await api.line(svc: svc) {
                    guard current(s) else { return }
                    lines[key] = l
                    answeredAt["line:" + key] = Date()
                    lineFailed.remove(key)
                    return
                }
                lineFailed.insert(key)
            }
        }
    }

    // MARK: pulled down

    /// When the timed refresh brings new times for `key`: at its next run, or
    /// the one after when that's too soon after `key` was last asked.
    private func nextUpdate(_ key: String) -> Date? {
        guard let at = nextTimedAt, at > Date() else { return nil }
        let last = asked[key] ?? .distantPast
        return at.timeIntervalSince(last) < Self.minGapS ? at.addingTimeInterval(BusTimes.refreshS) : at
    }

    /// `key` asked for again by `fetch`, or the one on its way waited for;
    /// nothing within Pull.freshS of its last answer, as the server would send the same.
    private func pulled(_ key: String, _ fetch: () async -> Void) async -> PullOutcome {
        let start = Date()
        if asking.contains(key) {
            while asking.contains(key), !Task.isCancelled { try? await Task.sleep(for: .milliseconds(100)) }
        } else if Pull.shouldFetch(lastOK: answeredAt[key], now: start) {
            await fetch()
        } else {
            return .upToDate(nextInS: Pull.inS(nextUpdate(key), now: Date()))
        }
        return (answeredAt[key] ?? .distantPast) >= start ? .updated : .failed
    }

    /// The pull's bus for the page of `code` (nil: the home, its pinned stop
    /// showing): the first service on the board it shows, in its colour; nil before there's one.
    func livery(_ code: String?) -> UInt32? {
        // The home shows each pinned stop's own board, whichever side its page is on.
        let rows = code.map { boards[pageBoard($0)]?.rows } ?? pinFocus.flatMap { pinned[$0]?.board }
        guard let row = rows.flatMap({ BusWords.runningFirst($0).first }) else { return nil }
        return (row.color ?? color(row.svc)).flatMap(hexRGB)
    }

    /// Pulled down on the page for `code`: asked again, and how it went.
    func pullPage(_ code: String) async -> PullOutcome {
        await pulled(pageBoard(code)) { await refreshPage(code, force: true) }
    }

    /// Pulled down on the home: the pins asked for again (a change in
    /// Settings shows at once), then the pinned stop showing and its neighbours;
    /// how it went is the one showing's.
    func pullPins() async -> PullOutcome {
        await loadCampus()
        await loadProfile()
        if pinsState == .failed { return .failed }
        guard let code = pinFocus else { return .upToDate(nextInS: nil) }
        return await pulled("pin:" + code) { await refreshPinned(force: true) }
    }

    /// Pulled down on a line's page.
    func pullLine(_ svc: String, from: String?) async -> PullOutcome {
        await pulled("line:" + Self.lineKey(svc, from)) { await refreshLine(svc, from: from, force: true) }
    }

    // MARK: the note

    func say(_ text: String) {
        note = text
        noteTask?.cancel()
        noteTask = Task {
            try? await Task.sleep(for: .seconds(2.2))
            if !Task.isCancelled { note = nil }
        }
    }

    /// A stop's name before its board is here: from the campus data, else its code.
    func stopName(_ code: String) -> String {
        boards[code]?.name ?? campus?.stop(code)?.fullName ?? code
    }

    func color(_ svc: String) -> String? { campus?.color(svc) }
}
