import Foundation

/// What the widgets keep in the app group besides the latest answer
/// (Shared.lastAnswer): when it came and the last refresh's error, each
/// widget's own choice (the timetable, Nearby or a place) with its answer,
/// and where the phone was last, for a refresh with the app closed.
enum WidgetStore {
    private static var d: UserDefaults { Shared.defaults }

    // MARK: the plan

    /// When Shared.lastAnswer came, on this phone's clock.
    static var answerAt: Date? {
        get { d.object(forKey: "widget.answerAt") as? Date }
        set { d.set(newValue, forKey: "widget.answerAt") }
    }

    /// Why the last refresh failed ("Offline"), or WidgetFace.updating while one is under way; nil when it worked.
    static var error: String? {
        get { d.string(forKey: "widget.error") }
        set { d.set(newValue, forKey: "widget.error") }
    }

    /// The plan as kept, with when it came.
    static func plan() -> (NextAnswer, Date)? {
        guard let data = Shared.lastAnswer, let a = try? NextAnswer.decode(data) else { return nil }
        return (a, answerAt ?? .distantPast)
    }

    /// Today's plan as kept for offline.
    static func day() -> DayPlan? {
        Shared.lastDay.flatMap { try? JSONDecoder().decode(DayPlan.self, from: $0) }
    }

    /// A newly fetched plan: kept for every widget, with when it came.
    static func keep(_ a: NextAnswer, at: Date = Date()) {
        Shared.lastAnswer = a.raw
        answerAt = at
        error = nil
    }

    /// An answer fetched this recently (by the app, a push, another widget) isn't asked for again.
    static let recent: TimeInterval = 15

    /// Fetches the plan for whatever is outside the app (a widget, a push, the
    /// background refresh), with the last place the phone was, and keeps it.
    /// Nil when there's no new one: signed out, offline, refused (its error
    /// kept for the widgets to show). With `force` it asks even just after
    /// another fetch (a push: the card changed since).
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
            // Signed out (or in again) while it was out: the old account's, so none of it is kept.
            guard TokenStore.read() == token else { return nil }
            keep(a)
            return a
        } catch let e as ApiError {
            error = e.status == 401 ? L("This phone was signed out of your account. Sign in again with your email.") : e.message
        } catch is DecodingError {
            error = L("Unexpected response from terminus")
        } catch {
            self.error = L("Offline")
        }
        return nil
    }

    /// The key this phone's widgets put on a stop's link (`k`), so only they
    /// can add a place to the app's tabs (Links.route). Made the first time it's asked for.
    static var linkKey: String {
        if let k = d.string(forKey: "linkKey") { return k }
        let k = UUID().uuidString
        d.set(k, forKey: "linkKey")
        return k
    }

    // MARK: where the phone was

    /// The phone's last fix, rounded to about 11 m, as the app had it: a
    /// widget or a push has none of its own. Kept two hours at most.
    static var location: (lat: Double, lon: Double, acc: Double?)? {
        guard let at = d.object(forKey: "widget.loc.at") as? Date else { return nil }
        // Past its two hours it's gone from the phone too, not just unused.
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

    // MARK: each widget's choice

    /// One widget's choice and what it fetched for it. Widgets of the same
    /// kind and size share one (WidgetKit doesn't say which of them was tapped).
    struct Slot: Codable {
        var mode: String = "plan"
        var label: String?
        var at: Date?
        /// The answer for the choice as it came: /me/nearby's, or /me/next's for a place.
        var json: Data?
        var fetchedAt: Date?
        var error: String?
        var swap: WidgetSwap.Swap?

        var chosen: WidgetMode { WidgetMode.of(id: mode, label: label) }

        var nearby: [NearbyStop]? {
            guard chosen == .nearby, let json else { return nil }
            struct R: Decodable { let stops: [NearbyStop] }
            return (try? JSONDecoder().decode(R.self, from: json))?.stops
        }

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

    /// Every widget's slot, for a refresh of the ones showing a place or Nearby.
    static let slots = ["next.large", "places.medium", "places.large"]

    /// Shows `mode` on a widget and fetches it. A different place's old answer goes: it's someone else's.
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

    /// What a widget's choice shows, asked for once; its error kept on failure.
    static func fetch(slot id: String) async {
        var s = slot(id)
        let mode = s.chosen
        guard mode != .timetable, let token = TokenStore.read() else { return }
        let api = Api(token: token, fast: true)
        let loc = location
        do {
            let data: Data
            if mode == .nearby {
                data = try await api.nearby(lat: loc?.lat, lon: loc?.lon, acc: loc?.acc).1
            } else {
                data = try await api.next(mode.target!, lat: loc?.lat, lon: loc?.lon, acc: loc?.acc).raw ?? Data()
            }
            guard TokenStore.read() == token else { return }
            s = slot(id)
            guard s.mode == mode.id else { return }
            s.json = data
            s.fetchedAt = Date()
            s.error = nil
        } catch let e as ApiError {
            s = slot(id)
            s.error = e.status == 400 && mode == .nearby ? L("Turn on location, or set a home") : e.message
        } catch {
            s = slot(id)
            s.error = L("Offline")
        }
        save(s, id)
    }

    /// The widgets showing a place or Nearby, kept current: at most once a
    /// minute each, and only while the choice stands.
    static func refreshChosen(now: Date = Date()) async {
        for id in slots {
            let s = slot(id)
            guard s.chosen != .timetable, let at = s.at, now.timeIntervalSince(at) <= WidgetMode.keep else { continue }
            if let f = s.fetchedAt, now.timeIntervalSince(f) < WidgetMode.refetch { continue }
            await fetch(slot: id)
        }
    }

    /// The nearest stop's twin shown first, or, tapped again, the nearest again.
    static func swap(from: String, to: String, slot id: String) {
        var s = slot(id)
        if s.swap?.from == from && s.swap?.to == to { s.swap = nil } else { s.swap = WidgetSwap.Swap(from: from, to: to, at: Date()) }
        save(s, id)
    }

    /// Signing out: every widget forgets its place or Nearby list, which were the old account's.
    static func forget() {
        for id in slots { try? FileManager.default.removeItem(at: file(id)) }
        answerAt = nil
        error = nil
        forgetLocation()
    }

    static func forgetLocation() {
        for k in ["widget.loc.lat", "widget.loc.lon", "widget.loc.acc", "widget.loc.at"] { d.removeObject(forKey: k) }
    }

    /// The places added from "Go somewhere else" (AppModel.Added, kept in the app group), newest first.
    static var added: [(code: String, label: String)] {
        struct A: Decodable {
            let code: String
            let label: String
        }
        let list = d.data(forKey: "added").flatMap { try? JSONDecoder().decode([A].self, from: $0) } ?? []
        return list.map { ($0.code, $0.label) }
    }
}
