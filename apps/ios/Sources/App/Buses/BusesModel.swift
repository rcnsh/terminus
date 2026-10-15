import Foundation
import Observation

/// Where the nearest stop's page is.
enum BusNearest { case loading, ready, none, failed }

/// The Buses tab's data, as Android's BusesViewModel. The screens drive the
/// refreshing, only while the tab is on screen and the app in front: the
/// page in view every 15 s, the API's own cache, so asking sooner would
/// show nothing new. A failed refresh keeps the last answer, shown aged.
@MainActor @Observable
final class BusesModel {
    static let shared = BusesModel()

    /// The stops and services, for the search and names before a board loads.
    private(set) var campus: BusCampus?
    private(set) var nearest: Board?
    private(set) var nearestState = BusNearest.loading
    /// The nearest stop is from a location; false: from the home stop.
    private(set) var located = false
    /// Boards by stop code: pinned stops, opened ones, the twins across the road.
    private(set) var boards: [String: Board] = [:]
    /// Stops whose board couldn't be fetched (offline), until one is.
    private(set) var failed: Set<String> = []
    /// Pages switched to the stop across the road, by the page's own stop.
    private(set) var across: Set<String> = []
    /// Lines by `lineKey`.
    private(set) var lines: [String: Line] = [:]
    private(set) var lineFailed: Set<String> = []

    /// The account's pinned stops, its limit, and whether boards have the public buses too.
    private(set) var pins: [String] = []
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
    static let nearestKey = "nearest"

    static func lineKey(_ svc: String, _ from: String?) -> String { "\(svc)|\(from ?? "")" }

    private var token: String? { AppModel.shared.token }

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
        nearest = nil
        nearestState = .loading
        located = false
        boards = [:]
        failed = []
        across = []
        lines = [:]
        lineFailed = []
        pins = []
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
        guard let p = try? await Api(token: token).profile() else { return }
        apply(p)
    }

    private func apply(_ p: [String: Any]) {
        pins = (p["pinnedStops"] as? [String]) ?? []
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
        pins = BusPins.toggle(pins, code, max: pinLimit)
        Task {
            do {
                // The profile as it is now, so nothing else changed elsewhere is lost.
                let fallback = pinLimit
                apply(
                    try await Api(token: token).changeProfile { p in
                        let saved = (p["pinnedStops"] as? [String]) ?? []
                        let limit = ((p["limits"] as? [String: Any])?["pinnedStops"] as? Int) ?? fallback
                        p["pinnedStops"] = BusPins.toggle(saved, code, max: limit)
                    })
            } catch {
                if refused(error, token) { return }
                pins = before
                say(L("Couldn't save. Try again."))
            }
        }
    }

    // MARK: boards

    /// The nearest stop, by location, else the home stop; its twin across the road comes with it.
    func refreshNearest(force: Bool = false) async {
        if !force && fresh(Self.nearestKey) { return }
        guard let token else { return }
        asked[Self.nearestKey] = Date()
        await fetching(Self.nearestKey) {
            let loc = await Locator.shared.fix(maxAge: 60)
            do {
                let stops = try await Api(token: token).nearbyBoards(
                    lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc)
                answeredAt[Self.nearestKey] = Date()
                nearest = stops.first
                nearestState = stops.isEmpty ? .none : .ready
                located = loc != nil
                for b in stops {
                    boards[b.code] = b
                    failed.remove(b.code)
                }
            } catch {
                if refused(error, token) { return }
                if let e = error as? ApiError, e.status == 400 {
                    // No location and no home stop: nothing to call nearest.
                    nearest = nil
                    nearestState = .none
                } else if nearest == nil {
                    nearestState = .failed
                }
            }
        }
    }

    func refreshBoard(_ code: String, force: Bool = false) async {
        if !force && fresh(code) { return }
        guard let token else { return }
        asked[code] = Date()
        await fetching(code) {
            do {
                let b = try await Api(token: token).board(stop: code, publicBuses: publicBuses)
                answeredAt[code] = Date()
                boards[code] = b
                failed.remove(code)
            } catch {
                if refused(error, token) { return }
                failed.insert(code)
            }
        }
    }

    /// The board the page for `code` shows: its own, or its twin's across the road; nil for the nearest stop's page.
    func pageBoard(_ code: String?) -> String? {
        guard let code else { return nil }
        if across.contains(code), let o = boards[code]?.opposite { return o }
        return code
    }

    /// The page for `code` (nil: the nearest stop). The nearest stop's twin
    /// comes with /me/nearby, so that page asks only for that.
    func refreshPage(_ code: String?, force: Bool = false) async {
        if let b = pageBoard(code) { await refreshBoard(b, force: force) } else { await refreshNearest(force: force) }
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
        await fetching("line:" + key) {
            let api = Api(token: token)
            do {
                lines[key] = try await api.line(svc: svc, stop: from)
                answeredAt["line:" + key] = Date()
                lineFailed.remove(key)
            } catch {
                if refused(error, token) { return }
                // The stop isn't on this service: the line without it.
                if from != nil, let e = error as? ApiError, e.status == 400, let l = try? await api.line(svc: svc) {
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

    /// The pull's bus for the page of `code` (nil: the nearest stop): the
    /// first service on the board it shows, in its colour; nil before there's one.
    func livery(_ code: String?) -> UInt32? {
        guard let own = code ?? nearest?.code, let row = boards[pageBoard(own) ?? own].map({ BusWords.runningFirst($0.rows) })?.first else {
            return nil
        }
        return (row.color ?? color(row.svc)).flatMap(hexRGB)
    }

    /// Pulled down on the page for `code` (nil: the nearest stop): asked again, and how it went.
    func pullPage(_ code: String?) async -> PullOutcome {
        await pulled(pageBoard(code) ?? Self.nearestKey) { await refreshPage(code, force: true) }
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
