import Foundation

/// The board of buses near you that every widget showing it shares: the
/// Buses near you widget, the Nearby chip on the others and the large Next
/// bus widget's next buses. Kept in the app group as it came (/me/nearby with
/// `stopped=1`, Shared.lastNearby), whoever fetched it: Now's Nearby, the
/// Buses tab, a widget's ↻ or a widget's reload, at most once a minute
/// between them, with the phone's last place. As Android's NearbyShared.
enum NearbyShared {
    private static var d: UserDefaults { Shared.defaults }

    /// Asked for again in the background at most this often: the server caches arrivals 15 s, and a widget redraws by the minute.
    static let refetch: TimeInterval = 60
    /// The large Next bus widget shows next buses from a board this recent at most.
    static let keep: TimeInterval = 30 * 60

    /// When the kept board came, on this phone's clock.
    static var fetchedAt: Date? {
        get { d.object(forKey: "nearby.at") as? Date }
        set { d.set(newValue, forKey: "nearby.at") }
    }

    /// Why the last fetch failed, or WidgetFace.updating while a tapped one is under way; nil when it worked.
    static var error: String? {
        get { d.string(forKey: "nearby.error") }
        set { d.set(newValue, forKey: "nearby.error") }
    }

    /// The kept board's stops, nearest first; nil before any, or one this version can't read.
    static func stops() -> [NearbyStop]? {
        struct R: Decodable { let stops: [NearbyStop] }
        return Shared.lastNearby.flatMap { try? JSONDecoder().decode(R.self, from: $0).stops }
    }

    /// A board fetched by anyone, kept for the widgets: unless `token` has
    /// been signed out since it was asked for, or it can't be read.
    @discardableResult
    static func keep(_ data: Data, sentWith token: String, at: Date = Date()) -> Bool {
        struct R: Decodable { let stops: [NearbyStop] }
        guard TokenStore.read() == token, (try? JSONDecoder().decode(R.self, from: data)) != nil else { return false }
        Shared.lastNearby = data
        fetchedAt = at
        error = nil
        return true
    }

    /// A Buses near you widget is on the Home or Lock Screen, or a large
    /// Next bus widget whose next buses it fills (counted by the app, TripSync).
    static var wanted: Bool { d.integer(forKey: "widgets.nearby") > 0 }

    /// Whether a fetch with nothing tapped would ask for anything now: signed in, and a minute since the last.
    static func due(now: Date = Date()) -> Bool {
        guard TokenStore.read() != nil, now >= Quiet.until(.app) else { return false }
        return fetchedAt.map { now.timeIntervalSince($0) >= refetch } ?? true
    }

    /// Fetches the board when it's due (`due`); `needsPlace`: only with a
    /// recent place of the phone's, not the home stop the server falls back to.
    static func refreshIfDue(needsPlace: Bool = false) async {
        guard due(), !needsPlace || WidgetStore.location != nil else { return }
        _ = await refresh(tapped: false)
    }

    /// Fetches the board with the phone's last place and keeps it. `tapped`
    /// (↻): says "Updating…" meanwhile and keeps what went wrong after; a
    /// reload keeps quiet, showing the board it has. The error, nil when it came.
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

    /// Signing out, or in as someone else: the board was the old account's.
    static func forget() {
        Shared.lastNearby = nil
        fetchedAt = nil
        error = nil
    }
}

/// "New to NUS", in Settings › Appearance, on this phone only: the Buses near
/// you widget explains the buses for someone who doesn't know the routes
/// yet. Each side of the road says which way its buses go, each bus the
/// places it passes (the server's `via`: the MRT, UTown, PGP), and Live and
/// Scheduled are spelled out. Off, the widget is as dense as it goes: more
/// buses, fewer words. Kept in the app group, which the widgets read, and
/// kept through a sign-out. As Android's NewToNus.
enum NewToNus {
    private static let key = "newToNus"

    static var on: Bool {
        get { Shared.defaults.bool(forKey: key) }
        set { Shared.defaults.set(newValue, forKey: key) }
    }
}
