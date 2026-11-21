import Foundation

enum WidgetStore {
    private static var d: UserDefaults { Shared.defaults }

    static var answerAt: Date? {
        get { d.object(forKey: "widget.answerAt") as? Date }
        set { d.set(newValue, forKey: "widget.answerAt") }
    }

    static var error: String? {
        get { d.string(forKey: "widget.error") }
        set { d.set(newValue, forKey: "widget.error") }
    }

    static func plan() -> (NextAnswer, Date)? {
        guard let data = Shared.lastAnswer, let a = try? NextAnswer.decode(data) else { return nil }
        return (a, answerAt ?? .distantPast)
    }

    static func day() -> DayPlan? {
        Shared.lastDay.flatMap { try? JSONDecoder().decode(DayPlan.self, from: $0) }
    }

    static func keep(_ a: NextAnswer, at: Date = Date()) {
        Shared.lastAnswer = a.raw
        answerAt = at
        error = nil
    }

    static let recent: TimeInterval = 15

    static func refreshPlan(force: Bool = false) async -> NextAnswer? {
        guard let token = TokenStore.read() else {
            error = nil
            return nil
        }
        if !force, let (a, at) = plan(), -at.timeIntervalSinceNow < recent, error == nil || error == WidgetFace.updating {
            error = nil
            return a
        }
        let loc = location
        do {
            let a = try await Api(token: token, fast: true).next(.plan, lat: loc?.lat, lon: loc?.lon, acc: loc?.acc)
            guard TokenStore.read() == token else { return nil }
            keep(a)
            return a
        } catch let e as ApiError {
            error = e.status == 401 ? signedOutHere : e.message
        } catch is DecodingError {
            error = L("Unexpected response from terminus")
        } catch {
            self.error = L("Offline")
        }
        return nil
    }

    static var linkKey: String {
        if let k = d.string(forKey: "linkKey") { return k }
        let k = UUID().uuidString
        d.set(k, forKey: "linkKey")
        return k
    }

    static var location: (lat: Double, lon: Double, acc: Double?)? {
        guard let at = d.object(forKey: "widget.loc.at") as? Date else { return nil }
        guard -at.timeIntervalSinceNow < 2 * 3600 else {
            forgetLocation()
            return nil
        }
        let acc = d.object(forKey: "widget.loc.acc") as? Double
        return (d.double(forKey: "widget.loc.lat"), d.double(forKey: "widget.loc.lon"), acc)
    }

    static func saveLocation(lat: Double, lon: Double, acc: Double?, at: Date) {
        d.set((lat * 10_000).rounded() / 10_000, forKey: "widget.loc.lat")
        d.set((lon * 10_000).rounded() / 10_000, forKey: "widget.loc.lon")
        d.set(acc, forKey: "widget.loc.acc")
        d.set(at, forKey: "widget.loc.at")
    }

    struct Slot: Codable {
        var mode: String = "plan"
        var label: String?
        var at: Date?
        var json: Data?
        var fetchedAt: Date?
        var error: String?
        var swap: WidgetSwap.Swap?

        var chosen: WidgetMode { WidgetMode.of(id: mode, label: label) }

        var nearby: [NearbyStop]? {
            guard chosen == .nearby else { return nil }
            return NearbyShared.stops()
        }

        var shownAt: Date? { chosen == .nearby ? NearbyShared.fetchedAt : fetchedAt }

        var answer: NextAnswer? {
            guard case .to = chosen, let json else { return nil }
            return try? NextAnswer.decode(json)
        }
    }

    private static func file(_ slot: String) -> URL { Shared.folder.appendingPathComponent("widget-\(slot).json") }

    static func slot(_ id: String) -> Slot {
        (try? Data(contentsOf: file(id))).flatMap { try? JSONDecoder().decode(Slot.self, from: $0) } ?? Slot()
    }

    static func save(_ s: Slot, _ id: String) {
        try? FileManager.default.createDirectory(at: Shared.folder, withIntermediateDirectories: true)
        try? JSONEncoder().encode(s).write(to: file(id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static let slots = ["next.large", "places.medium", "places.large"]
    static let nearbySlots = ["nearby.small", "nearby.medium", "nearby.large", "nearby.rect"]

    static func choose(_ mode: WidgetMode, slot id: String) async {
        var s = slot(id)
        let same = s.mode == mode.id
        s.mode = mode.id
        s.label = mode == .timetable ? nil : mode.label
        s.at = Date()
        s.error = WidgetFace.updating
        if !same {
            s.json = nil
            s.fetchedAt = nil
            s.swap = nil
        }
        save(s, id)
        if mode == .timetable {
            s.error = nil
            save(s, id)
            _ = await refreshPlan()
            return
        }
        await fetch(slot: id)
    }

    static func fetch(slot id: String) async {
        var s = slot(id)
        let mode = s.chosen
        guard mode != .timetable, let token = TokenStore.read() else { return }
        if mode == .nearby {
            let problem = await NearbyShared.refresh(tapped: false)
            guard TokenStore.read() == token else { return }
            s = slot(id)
            guard s.mode == mode.id else { return }
            s.error = problem
            save(s, id)
            return
        }
        let api = Api(token: token, fast: true)
        let loc = location
        do {
            let data = try await api.next(mode.target!, lat: loc?.lat, lon: loc?.lon, acc: loc?.acc).raw ?? Data()
            guard TokenStore.read() == token else { return }
            s = slot(id)
            guard s.mode == mode.id else { return }
            s.json = data
            s.fetchedAt = Date()
            s.error = nil
        } catch let e as ApiError {
            s = slot(id)
            s.error = e.message
        } catch {
            s = slot(id)
            s.error = L("Offline")
        }
        save(s, id)
    }

    static func refreshChosen(now: Date = Date()) async {
        for id in slots {
            let s = slot(id)
            guard s.chosen != .timetable, let at = s.at, now.timeIntervalSince(at) <= WidgetMode.keep else { continue }
            if let f = s.shownAt, now.timeIntervalSince(f) < WidgetMode.refetch { continue }
            await fetch(slot: id)
        }
    }

    static func swap(from: String, to: String, slot id: String) {
        var s = slot(id)
        if s.swap?.from == from && s.swap?.to == to { s.swap = nil } else { s.swap = WidgetSwap.Swap(from: from, to: to, at: Date()) }
        save(s, id)
    }

    static func forget() {
        for id in slots + nearbySlots { try? FileManager.default.removeItem(at: file(id)) }
        NearbyShared.forget()
        answerAt = nil
        error = nil
        forgetLocation()
    }

    static func forgetLocation() {
        for k in ["widget.loc.lat", "widget.loc.lon", "widget.loc.acc", "widget.loc.at"] { d.removeObject(forKey: k) }
    }

    static var added: [(code: String, label: String)] {
        struct A: Decodable {
            let code: String
            let label: String
        }
        let list = d.data(forKey: "added").flatMap { try? JSONDecoder().decode([A].self, from: $0) } ?? []
        return list.map { ($0.code, $0.label) }
    }
}
