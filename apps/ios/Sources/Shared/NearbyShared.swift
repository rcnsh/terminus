import Foundation

enum NearbyShared {
    private static var d: UserDefaults { Shared.defaults }

    static let refetch: TimeInterval = 60
    static let keep: TimeInterval = 30 * 60

    static var fetchedAt: Date? {
        get { d.object(forKey: "nearby.at") as? Date }
        set { d.set(newValue, forKey: "nearby.at") }
    }

    static var error: String? {
        get { d.string(forKey: "nearby.error") }
        set { d.set(newValue, forKey: "nearby.error") }
    }

    static func stops() -> [NearbyStop]? {
        struct R: Decodable { let stops: [NearbyStop] }
        return Shared.lastNearby.flatMap { try? JSONDecoder().decode(R.self, from: $0).stops }
    }

    @discardableResult
    static func keep(_ data: Data, sentWith token: String, at: Date = Date()) -> Bool {
        struct R: Decodable { let stops: [NearbyStop] }
        guard TokenStore.read() == token, (try? JSONDecoder().decode(R.self, from: data)) != nil else { return false }
        Shared.lastNearby = data
        fetchedAt = at
        error = nil
        return true
    }

    static var wanted: Bool { d.integer(forKey: "widgets.nearby") > 0 }

    static func due(now: Date = Date()) -> Bool {
        guard TokenStore.read() != nil, now >= Quiet.until(.app) else { return false }
        return fetchedAt.map { now.timeIntervalSince($0) >= refetch } ?? true
    }

    static func refreshIfDue(needsPlace: Bool = false) async {
        guard due(), !needsPlace || WidgetStore.location != nil else { return }
        _ = await refresh(tapped: false)
    }

    @discardableResult
    static func refresh(tapped: Bool) async -> String? {
        guard let token = TokenStore.read() else { return nil }
        if tapped { error = WidgetFace.updating }
        let loc = WidgetStore.location
        var problem: String?
        do {
            let (_, data) = try await Api(token: token, fast: true).nearby(lat: loc?.lat, lon: loc?.lon, acc: loc?.acc, stopped: true)
            keep(data, sentWith: token)
        } catch let e as ApiError {
            problem = e.status == 400 ? L("Turn on location, or set a home") : e.message
        } catch is DecodingError {
            problem = L("Unexpected response from terminus")
        } catch {
            problem = L("Offline")
        }
        if tapped || error == WidgetFace.updating { error = problem }
        return problem
    }

    static func forget() {
        Shared.lastNearby = nil
        fetchedAt = nil
        error = nil
    }
}

enum NewToNus {
    private static let key = "newToNus"

    static var on: Bool {
        get { Shared.defaults.bool(forKey: key) }
        set { Shared.defaults.set(newValue, forKey: key) }
    }
}
