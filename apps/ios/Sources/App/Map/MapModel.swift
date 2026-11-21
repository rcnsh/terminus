import CoreLocation
import SwiftUI

@MainActor @Observable
final class MapModel {
    static let shared = MapModel()

    enum Sheet: Equatable {
        struct Bus: Equatable {
            let id: String
            var stops = false
            var all = false
        }
        case stop(String, from: Bus? = nil)
        case bus(Bus)

        var subject: String {
            switch self {
            case .stop(let code, _): "stop:\(code)"
            case .bus(let b): "bus:\(b.id)"
            }
        }
    }

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
    var failed = false
    var selected: String?
    var buses: [LiveBus] = []
    var busAnswers = 0
    var busesStale = false
    var busStatus: BusStatus?
    var sheet: Sheet?
    var board: Board?
    var boardFailed = false
    var boardError = false
    var me: Spot?
    var downloading = false
    var downloadFailed = false
    var recentre = 0
    var focus: Spot?
    var focusCount = 0
    var locateCount = 0
    var notice: String?
    var noticeUndo: (() -> Void)?

    private(set) var profile: [String: Any]?
    private(set) var saving = false

    private var heardAt: Date?
    private var look: (dark: Bool, zh: Bool)?
    private var wanted: (dark: Bool, zh: Bool)?
    private var opening = false
    private var pendingFocus: String?

    var openStop: String? { if case .stop(let c, _) = sheet { c } else { nil } }
    var openBus: LiveBus? { if case .bus(let b) = sheet { buses.first { $0.id == b.id } } else { nil } }
    var openBusSheet: Sheet.Bus? { if case .bus(let b) = sheet { b } else { nil } }

    private var app: AppModel { AppModel.shared }

    func open(dark: Bool, zh: Bool) {
        wanted = (dark, zh)
        guard !opening else { return }
        let changed = look.map { $0 != (dark, zh) } ?? true
        guard changed || campus == nil || style == nil || downloadFailed else { return }
        opening = true
        Task {
            await load(dark: dark, zh: zh, changed: changed)
            opening = false
            if let w = wanted, look.map({ $0 != w }) ?? true { open(dark: w.dark, zh: w.zh) }
        }
    }

    private func load(dark: Bool, zh: Bool, changed: Bool) async {
        look = (dark, zh)
        if campus == nil {
            let token = app.token
            do {
                campus = try await CampusStore.shared.load(self, token: token) { [weak self] in self?.campus = $0.map }.map
                campusArrived()
            } catch let e as ApiError where e.status == 401 {
                if let token { app.rejected(token, reason: signedOutHere) }
            } catch {}
        }
        if changed || style == nil { style = await MapFiles.style(dark: dark, zh: zh) ?? style }
        failed = campus == nil || style == nil
        guard !failed else { return }
        downloading = !MapFiles.hasTiles
        do {
            if try await MapFiles.keepTiles(), let look { style = await MapFiles.style(dark: look.dark, zh: look.zh) ?? style }
            downloadFailed = false
        } catch {
            downloadFailed = !MapFiles.hasTiles
        }
        downloading = false
    }

    func tilesFailed(_ shown: URL) async {
        guard MapFiles.readsTiles(shown), let file = MapFiles.current, !MapFiles.looksLikeTiles(file), let look else { return }
        MapFiles.dropTiles()
        style = await MapFiles.style(dark: look.dark, zh: look.zh) ?? style
    }

    func choose(_ svc: String?) {
        selected = svc == selected ? nil : svc
        buses = []
        busesStale = false
        heardAt = nil
        busStatus = selected == nil ? nil : .finding
        if case .bus = sheet { sheet = nil }
        if case .stop(let code, _?) = sheet { sheet = .stop(code) }
    }

    func show(_ svc: String) {
        if selected != svc { choose(svc) }
    }

    func home() {
        if selected != nil { choose(nil) }
        closeSheet()
        recentre += 1
    }

    nonisolated static func pollDelay(base: TimeInterval, failures: Int, quiet: TimeInterval) -> TimeInterval {
        max(min(base * pow(2, Double(min(failures, 6))), max(base, 60)), quiet)
    }

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
            if case .bus(let b) = sheet, !buses.contains(where: { $0.id == b.id }) { sheet = nil }
            return false
        } catch let e as ApiError where e.status == 401 {
            app.rejected(token, reason: signedOutHere)
            return false
        } catch {
            guard !Task.isCancelled, svc == selected else { return false }
            busStatus = .unavailable
            if let heardAt, Date().timeIntervalSince(heardAt) > 15, !buses.isEmpty { busesStale = true }
            return true
        }
    }

    func open(stop code: String, from: Sheet.Bus? = nil) {
        if openStop != code {
            board = nil
            boardFailed = false
            boardError = false
        }
        sheet = .stop(code, from: from)
    }

    func open(bus id: String) { sheet = .bus(Sheet.Bus(id: id)) }

    var sheetSpot: Spot? {
        switch sheet {
        case .stop(let code, _): campus?.stop(code).map { Spot(lat: $0.lat, lon: $0.lon) }
        case .bus(let b): buses.first { $0.id == b.id }.map { Spot(lat: $0.lat, lon: $0.lon) }
        case nil: nil
        }
    }

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

    func closeSheet(ifShowing shown: Sheet?) {
        guard let shown, let now = sheet, now.subject == shown.subject else { return }
        closeSheet()
    }

    func closeSheet() {
        sheet = nil
        board = nil
        boardFailed = false
        boardError = false
    }

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
                app.rejected(token, reason: signedOutHere)
                return false
            case 404:
                board = Board(
                    code: code, name: "", opposite: nil, oppositeAcross: false, oppositeName: nil, available: false, rows: [], asOf: nil)
                boardFailed = false
                boardError = false
                return false
            default:
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

    func locate() async {
        guard Locator.shared.allowed, let at = await Locator.shared.fix(maxAge: 20) else { return }
        me = Spot(lat: at.coordinate.latitude, lon: at.coordinate.longitude)
    }

    func locateMe() async {
        let loc = Locator.shared
        await loc.decide()
        guard loc.allowed else { return }
        guard let at = await loc.fix(maxAge: 20) else {
            say(L("Couldn't get your location."))
            return
        }
        me = Spot(lat: at.coordinate.latitude, lon: at.coordinate.longitude)
        locateCount += 1
    }

    func say(_ text: String, undo: (() -> Void)? = nil) {
        notice = text
        noticeUndo = undo
        announce(text)
        Task {
            try? await Task.sleep(for: .seconds(undo == nil ? 4 : 6))
            if notice == text {
                notice = nil
                noticeUndo = nil
            }
        }
    }

    func loadProfile() async {
        guard let token = app.token else { return }
        let session = app.session
        guard let p = try? await Api(token: token).profile(), app.session == session else { return }
        profile = p
    }

    func reset() {
        profile = nil
        notice = nil
        noticeUndo = nil
    }

    private func saved(_ data: Data, session: Int) {
        guard app.session == session else { return }
        profile = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? profile
    }

    var publicBuses: Bool { profile?["publicBuses"] as? Bool ?? false }

    private var places: [[String: Any]] { profile?["places"] as? [[String: Any]] ?? [] }

    func savedAs(_ code: String) -> String? {
        places.first { $0["to"] as? String == code }?["key"] as? String
    }

    var placesFull: Bool {
        let limit = ((profile?["limits"] as? [String: Any])?["places"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 12
        return places.count >= limit
    }

    func save(code: String, name: String) async {
        guard let token = app.token, !saving else { return }
        let session = app.session
        saving = true
        defer { saving = false }
        do {
            saved(try await Self.addPlace(token: token, code: code, name: name), session: session)
            announce(L("In your favourites"))
        } catch let e as ApiError where e.status == 401 {
            app.rejected(token, reason: signedOutHere)
        } catch {
            say(failureMessage(error, otherwise: L("Not saved. Check your connection.")))
        }
    }

    func unsave(key: String) async {
        guard let token = app.token, !saving else { return }
        let session = app.session
        saving = true
        defer { saving = false }
        do {
            let (data, removed) = try await Self.removePlace(token: token, key: key)
            saved(data, session: session)
            guard let removed, app.session == session else { return }
            say(L("%@ removed from favourites", removed.label)) { [weak self] in
                Task { await self?.restore(removed) }
            }
        } catch let e as ApiError where e.status == 401 {
            app.rejected(token, reason: signedOutHere)
        } catch {
            say(failureMessage(error, otherwise: L("Not saved. Check your connection.")))
        }
    }

    private func restore(_ removed: RemovedPlace) async {
        guard let token = app.token else { return }
        let session = app.session
        notice = nil
        noticeUndo = nil
        saving = true
        defer { saving = false }
        do {
            let p = try await Api(token: token).changeProfile { p in
                var doc = ProfileDoc(p)
                doc.restorePlace(removed)
                p = doc.json
            }
            guard app.session == session else { return }
            profile = p
        } catch {
            say(failureMessage(error, otherwise: L("Not saved. Check your connection.")))
        }
    }

    nonisolated private static func removePlace(token: String, key: String) async throws -> (Data, RemovedPlace?) {
        let removed = Mutex<RemovedPlace?>(nil)
        let p = try await Api(token: token).changeProfile { p in
            var doc = ProfileDoc(p)
            let r = doc.removePlace(key: key)
            removed.withLock { $0 = r }
            p = doc.json
        }
        return (try JSONSerialization.data(withJSONObject: p), removed.withLock { $0 })
    }

    nonisolated private static func addPlace(token: String, code: String, name: String) async throws -> Data {
        let p = try await Api(token: token).changeProfile { p in
            var list = p["places"] as? [[String: Any]] ?? []
            guard !list.contains(where: { $0["to"] as? String == code }) else { return }
            let labelMax = ((p["limits"] as? [String: Any])?["placeLabel"] as? Int).flatMap { $0 > 0 ? $0 : nil } ?? 24
            let label = clippedUTF16(name.trimmingCharacters(in: .whitespaces), labelMax)
            list.append(["key": placeKey(label, taken: list.compactMap { $0["key"] as? String }), "label": label, "to": code])
            p["places"] = list
        }
        return try JSONSerialization.data(withJSONObject: p)
    }

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
