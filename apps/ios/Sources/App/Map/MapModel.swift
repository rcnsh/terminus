import CoreLocation
import SwiftUI

/// The Map tab's state: the campus, the style, the chosen service and its
/// live buses, and the sheet for a tapped stop or bus. The same as Android's
/// MapViewModel and the Mac's MapModel. The tab drives the polling, only while
/// it's on screen and the app is active: buses every 5 s while a pill is on,
/// a stop's times every 15 s while its sheet is open, your dot every 20 s.
@MainActor @Observable
final class MapModel {
    /// One for the app, so another tab can open a stop or a service on it
    /// (`showStop`, `show`) before the map has ever been looked at.
    static let shared = MapModel()

    /// The sheet over the bottom of the map: a stop, or a bus. A stop opened
    /// from a bus's sheet remembers that bus (`from`), which back returns to.
    enum Sheet: Equatable {
        /// A bus's sheet as it was: its stops ahead open (`stops`), and every one of them (`all`).
        struct Bus: Equatable {
            let id: String
            var stops = false
            var all = false
        }
        case stop(String, from: Bus? = nil)
        case bus(Bus)
    }

    /// What the line under the pills says about the live buses.
    enum BusStatus: Equatable {
        case finding
        case running(Int)
        case noneRunning, unavailable
    }

    struct Spot: Equatable {
        let lat: Double
        let lon: Double
    }

    var campus: CampusMap?
    var style: URL?
    /// Nothing to draw the map with: no stops and routes, or no style, and the last try failed.
    var failed = false
    /// The service whose pill is on.
    var selected: String?
    var buses: [LiveBus] = []
    /// Bumped by every answer from `/api/buses`, the same or not: each one
    /// plans the slides again, so a bus that hasn't moved still counts as heard from.
    var busAnswers = 0
    /// The feed is down, or the last answer is old, and these are where the
    /// buses were last seen: drawn faded, and said so.
    var busesStale = false
    var busStatus: BusStatus?
    var sheet: Sheet?
    /// The open stop's board, the services not running now too; nil while it loads.
    var board: Board?
    /// The board couldn't be fetched at all (offline).
    var boardFailed = false
    /// The server answered, but not with the board (down, or busy).
    var boardError = false
    /// Where the phone is, only with location allowed.
    var me: Spot?
    /// The street map file is downloading (the first look): the map is plain until it's here.
    var downloading = false
    /// The download failed: routes and stops only, until the next try.
    var downloadFailed = false
    /// Bumped by "Back to campus" (and the tab tapped again); the map watches it.
    var recentre = 0
    /// A place for the map to move to, in the middle of what the pills and
    /// the sheet leave uncovered; bumped each time, so the same place again moves there again.
    var focus: Spot?
    var focusCount = 0
    /// "Show where you are": the map moves onto your dot; bumped each time.
    var locateCount = 0
    /// A word under the pills for a moment: your location couldn't be found, a favourite not saved.
    var notice: String?

    /// The account's profile, for "Add to favourites" (its places and their
    /// limit) and whether a stop's sheet lists public buses too.
    private(set) var profile: [String: Any]?
    private(set) var saving = false

    /// When `/api/buses` last answered, to tell when the buses shown are old.
    private var heardAt: Date?
    /// What the map opened with, for the style again once the map file is here or has failed.
    private var look: (dark: Bool, zh: Bool)?
    /// The look the tab last asked for.
    private var wanted: (dark: Bool, zh: Bool)?
    private var opening = false
    /// A stop asked for before the campus was here: moved to once it is.
    private var pendingFocus: String?

    var openStop: String? { if case .stop(let c, _) = sheet { c } else { nil } }
    var openBus: LiveBus? { if case .bus(let b) = sheet { buses.first { $0.id == b.id } } else { nil } }
    /// How the open bus's sheet was left, for it to open the same way.
    var openBusSheet: Sheet.Bus? { if case .bus(let b) = sheet { b } else { nil } }

    private var app: AppModel { AppModel.shared }

    // MARK: opening

    /// The campus and the style for this theme and language, then the street
    /// map file in the background (the style again once it's here). Again
    /// when the look changes; whatever failed last time is asked for again.
    /// It carries on if the tab is left meanwhile: a download half done is
    /// worth finishing.
    func open(dark: Bool, zh: Bool) {
        wanted = (dark, zh)
        guard !opening else { return }
        let changed = look.map { $0 != (dark, zh) } ?? true
        guard changed || campus == nil || style == nil || downloadFailed else { return }
        opening = true
        Task {
            await load(dark: dark, zh: zh, changed: changed)
            opening = false
            // The look changed while that was on its way: again for the new one.
            if let w = wanted, look.map({ $0 != w }) ?? true { open(dark: w.dark, zh: w.zh) }
        }
    }

    private func load(dark: Bool, zh: Bool, changed: Bool) async {
        look = (dark, zh)
        if campus == nil {
            let token = app.token
            do {
                campus = try await MapFiles.campus(token: token)
                campusArrived()
            } catch let e as ApiError where e.status == 401 {
                if let token { app.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email.")) }
            } catch {}
        }
        if changed || style == nil { style = await MapFiles.style(dark: dark, zh: zh) ?? style }
        failed = campus == nil || style == nil
        guard !failed else { return }
        // The whole map file for offline. The first time, the map is plain
        // until it's here; then the streets appear.
        downloading = !MapFiles.hasTiles
        do {
            if try await MapFiles.keepTiles(), let look { style = await MapFiles.style(dark: look.dark, zh: look.zh) ?? style }
            downloadFailed = false
        } catch {
            downloadFailed = !MapFiles.hasTiles
        }
        downloading = false
    }

    /// MapLibre couldn't load a style reading the map file: the file goes
    /// (the next look downloads it again) and the map is plain meanwhile.
    /// Only when the file itself fails the check: a load can fail for other
    /// reasons, and a good file kept is one the phone needn't download again.
    func tilesFailed(_ shown: URL) async {
        guard MapFiles.readsTiles(shown), let file = MapFiles.current, !MapFiles.looksLikeTiles(file), let look else { return }
        MapFiles.dropTiles()
        style = await MapFiles.style(dark: look.dark, zh: look.zh) ?? style
    }

    // MARK: the pills

    /// One pill at a time; the same one again turns it off.
    func choose(_ svc: String?) {
        selected = svc == selected ? nil : svc
        buses = []
        busesStale = false
        heardAt = nil
        busStatus = selected == nil ? nil : .finding
        if case .bus = sheet { sheet = nil }
        // That bus is gone with its service: back on its stop's sheet just closes.
        if case .stop(let code, _?) = sheet { sheet = .stop(code) }
    }

    /// A service from another tab (the Buses tab's "Show on map"): its pill on, never toggled off.
    func show(_ svc: String) {
        if selected != svc { choose(svc) }
    }

    /// The Map tab tapped while on it: back to how it opened, no pill on and no sheet open.
    func home() {
        if selected != nil { choose(nil) }
        closeSheet()
        recentre += 1
    }

    // MARK: the live buses

    /// How long a polling loop waits before asking again: `base` while the
    /// API answers, doubling with each failure in a row up to a minute, and
    /// never sooner than a 429's or a 503's Retry-After (`quiet`, Quiet.wait).
    nonisolated static func pollDelay(base: TimeInterval, failures: Int, quiet: TimeInterval) -> TimeInterval {
        max(min(base * pow(2, Double(min(failures, 6))), max(base, 60)), quiet)
    }

    /// The chosen service's buses. A failed poll keeps them drawn, faded once
    /// the last answer is 15 s old (three polls), so last places don't pass
    /// for live. Whether it failed, for the loop's back-off.
    @discardableResult
    func refreshBuses() async -> Bool {
        guard let svc = selected, let token = app.token else { return false }
        do {
            let data = try await Api(token: token).buses(svc: svc)
            guard svc == selected else { return false }
            guard let list = BusList.parse(data) else {
                busStatus = .unavailable
                return true
            }
            buses = list.buses
            busesStale = list.stale && !list.buses.isEmpty
            heardAt = Date()
            busAnswers += 1
            busStatus = !list.available ? .unavailable : list.buses.isEmpty ? .noneRunning : .running(list.buses.count)
            // A bus whose sheet is open and has gone: the sheet closes.
            if case .bus(let b) = sheet, !buses.contains(where: { $0.id == b.id }) { sheet = nil }
            return false
        } catch let e as ApiError where e.status == 401 {
            app.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
            return false
        } catch {
            guard !Task.isCancelled, svc == selected else { return false }
            busStatus = .unavailable
            if let heardAt, Date().timeIntervalSince(heardAt) > 15, !buses.isEmpty { busesStale = true }
            return true
        }
    }

    // MARK: the sheets

    /// A tapped stop's sheet.
    func open(stop code: String, from: Sheet.Bus? = nil) {
        if openStop != code {
            board = nil
            boardFailed = false
            boardError = false
        }
        sheet = .stop(code, from: from)
    }

    func open(bus id: String) { sheet = .bus(Sheet.Bus(id: id)) }

    /// Where the open sheet's stop or bus is on the map, to keep it in sight.
    var sheetSpot: Spot? {
        switch sheet {
        case .stop(let code, _): campus?.stop(code).map { Spot(lat: $0.lat, lon: $0.lon) }
        case .bus(let b): buses.first { $0.id == b.id }.map { Spot(lat: $0.lat, lon: $0.lon) }
        case nil: nil
        }
    }

    /// A stop from another tab (Nearby on Now) or from a bus's sheet (`from`,
    /// which back returns to): its sheet, and the map moved onto it. Unknown codes are ignored.
    func showStop(_ code: String, from: Sheet.Bus? = nil) {
        if let campus, campus.stop(code) == nil { return }
        open(stop: code, from: from)
        if let stop = campus?.stop(code) {
            focus = Spot(lat: stop.lat, lon: stop.lon)
            focusCount += 1
        } else {
            pendingFocus = code
        }
    }

    /// The campus has come: a stop asked for meanwhile is moved to now.
    private func campusArrived() {
        guard let code = pendingFocus else { return }
        pendingFocus = nil
        guard let stop = campus?.stop(code) else {
            if openStop == code { closeSheet() }
            return
        }
        focus = Spot(lat: stop.lat, lon: stop.lon)
        focusCount += 1
    }

    func closeSheet() {
        sheet = nil
        board = nil
        boardFailed = false
        boardError = false
    }

    /// Back: from a stop opened from a bus, to that bus's sheet as it was if
    /// it's still on the map, the map moved back onto it; otherwise closed.
    func back() {
        if case .stop(_, let from?) = sheet, let bus = buses.first(where: { $0.id == from.id }) {
            sheet = .bus(from)
            focus = Spot(lat: bus.lat, lon: bus.lon)
            focusCount += 1
            board = nil
        } else {
            closeSheet()
        }
    }

    /// The open stop's times. Whether it failed, for the loop's back-off.
    @discardableResult
    func refreshBoard() async -> Bool {
        guard let code = openStop, let token = app.token else { return false }
        do {
            let b = try await Api(token: token).board(stop: code, publicBuses: publicBuses)
            guard code == openStop else { return false }
            board = b
            boardFailed = false
            boardError = false
            return false
        } catch let e as ApiError {
            guard code == openStop else { return false }
            switch e.status {
            case 401:
                app.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
                return false
            case 404:
                // A stop the server doesn't know: no times, which is true.
                board = Board(
                    code: code, name: "", opposite: nil, oppositeAcross: false, oppositeName: nil, available: false, rows: [], asOf: nil)
                boardFailed = false
                boardError = false
                return false
            default:
                // Down or busy: not "no times", which would say no buses are coming.
                boardError = true
                boardFailed = false
                return true
            }
        } catch is DecodingError {
            if code == openStop {
                boardError = true
                boardFailed = false
            }
            return true
        } catch {
            if Task.isCancelled || code != openStop { return false }
            boardFailed = true
            boardError = false
            return true
        }
    }

    // MARK: where you are

    /// Your dot. Never asks for location: only with it already allowed.
    func locate() async {
        guard Locator.shared.allowed, let at = await Locator.shared.fix(maxAge: 20) else { return }
        me = Spot(lat: at.coordinate.latitude, lon: at.coordinate.longitude)
    }

    /// "Show where you are": asks for location the first time; then the map
    /// moves onto your dot. Refused, the tab offers Settings instead.
    func locateMe() async {
        let loc = Locator.shared
        if loc.undecided {
            loc.ask()
            // The answer comes a moment after the prompt is closed; a minute at most.
            for _ in 0..<600 where loc.undecided {
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
        guard loc.allowed else { return }
        guard let at = await loc.fix(maxAge: 20) else {
            say(L("Couldn't get your location."))
            return
        }
        me = Spot(lat: at.coordinate.latitude, lon: at.coordinate.longitude)
        locateCount += 1
    }

    /// `text` under the pills for a few seconds, and said to VoiceOver.
    func say(_ text: String) {
        notice = text
        announce(text)
        Task {
            try? await Task.sleep(for: .seconds(4))
            if notice == text { notice = nil }
        }
    }

    // MARK: favourites

    /// The profile, for "Add to favourites" and public buses.
    func loadProfile() async {
        guard let token = app.token, let p = try? await Api(token: token).profile() else { return }
        profile = p
    }

    /// The profile's "public buses": a stop's sheet has them too, as its Buses tab board does.
    var publicBuses: Bool { profile?["publicBuses"] as? Bool ?? false }

    private var places: [[String: Any]] { profile?["places"] as? [[String: Any]] ?? [] }

    /// The favourite going to this stop, if one does.
    func savedAs(_ code: String) -> String? {
        places.first { $0["to"] as? String == code }?["label"] as? String
    }

    /// No room for another favourite (the server's limit; 12 from an older server).
    var placesFull: Bool {
        let limit = ((profile?["limits"] as? [String: Any])?["places"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 12
        return places.count >= limit
    }

    /// Saves a stop as a favourite, named as the map names it: the profile
    /// as the server keeps it, with the place added, so fields this version
    /// doesn't know survive.
    func save(code: String, name: String) async {
        guard let token = app.token, !saving else { return }
        saving = true
        defer { saving = false }
        do {
            let saved = try await Self.addPlace(token: token, code: code, name: name)
            profile = (try? JSONSerialization.jsonObject(with: saved)) as? [String: Any] ?? profile
            announce(L("In your favourites"))
        } catch let e as ApiError where e.status == 401 {
            app.rejected(token, reason: L("This phone was signed out of your account. Sign in again with your email."))
        } catch {
            say(failureMessage(error, otherwise: L("Not saved. Check your connection.")))
        }
    }

    /// The profile with a place going to `code` added, saved, and as the
    /// server then keeps it (JSON, to hand back to the main actor).
    nonisolated private static func addPlace(token: String, code: String, name: String) async throws -> Data {
        let p = try await Api(token: token).changeProfile { p in
            var list = p["places"] as? [[String: Any]] ?? []
            guard !list.contains(where: { $0["to"] as? String == code }) else { return }
            let labelMax = ((p["limits"] as? [String: Any])?["placeLabel"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 24
            let label = String(name.trimmingCharacters(in: .whitespaces).prefix(labelMax))
            list.append(["key": placeKey(label, taken: list.compactMap { $0["key"] as? String }), "label": label, "to": code])
            p["places"] = list
        }
        return try JSONSerialization.data(withJSONObject: p)
    }

    /// A favourite's key from its label, as Android's placeKey: lower case,
    /// dashes for anything else, made unique with -2, -3.
    nonisolated static func placeKey(_ label: String, taken: [String]) -> String {
        var key = String(
            label.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-")).prefix(24))
        if key.isEmpty { key = "place" }
        let base = String(key.prefix(21))
        var n = 2
        while taken.contains(key) {
            key = "\(base)-\(n)"
            n += 1
        }
        return key
    }
}
