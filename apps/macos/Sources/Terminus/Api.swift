import Foundation

struct Place: Decodable, Hashable {
    let key: String
    let label: String
}

/// `/me/next`. label and detail are display-ready; show them verbatim.
struct NextAnswer: Decodable {
    struct Stop: Decodable { let code: String; let name: String }
    struct Dest: Decodable { let to: String; let label: String; let why: String }

    // Only `label` is required. Anything else missing (a newer or older API)
    // must not turn the whole answer into "Offline".
    let label: String
    let detail: String
    let alt: String?
    let stop: Stop?
    let quality: String
    let asOf: String?
    let mode: String?
    let dest: Dest?
    let places: [Place]?
    /// When the bus leaves. Count down from this; `label` is only true when fetched.
    let departsAt: String?
    /// When the plan changes by itself (a class starts, the day ends).
    let refreshAt: String?
    let timing: Timing?
    let arrivals: [ArrivalLite]?

    struct Timing: Decodable { let status: String?; let text: String? }

    enum CodingKeys: String, CodingKey { case label, detail, alt, stop, quality, asOf, mode, dest, places, departsAt, refreshAt, timing, arrivals }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        detail = (try? c.decodeIfPresent(String.self, forKey: .detail)) ?? ""
        alt = try? c.decodeIfPresent(String.self, forKey: .alt)
        stop = try? c.decodeIfPresent(Stop.self, forKey: .stop)
        quality = (try? c.decodeIfPresent(String.self, forKey: .quality)) ?? "unknown"
        asOf = try? c.decodeIfPresent(String.self, forKey: .asOf)
        mode = try? c.decodeIfPresent(String.self, forKey: .mode)
        dest = try? c.decodeIfPresent(Dest.self, forKey: .dest)
        places = try? c.decodeIfPresent([Place].self, forKey: .places)
        departsAt = try? c.decodeIfPresent(String.self, forKey: .departsAt)
        refreshAt = try? c.decodeIfPresent(String.self, forKey: .refreshAt)
        timing = try? c.decodeIfPresent(Timing.self, forKey: .timing)
        arrivals = try? c.decodeIfPresent([ArrivalLite].self, forKey: .arrivals)
    }
    struct ArrivalLite: Decodable { let svc: String; let crowd: String? }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }
    var service: String { label.components(separatedBy: " · ").first ?? label }
    /// Crowd on the recommended bus, not whichever is first in the list.
    var crowd: String? { arrivals?.first { $0.svc == service }?.crowd }
    var hasLiveTime: Bool { departure != nil && quality != "unknown" && quality != "ended" }
}

/// The API's times may or may not carry milliseconds ("…:02Z" or "…:02.000Z").
/// A default ISO8601DateFormatter rejects the second form, so try both.
func parseISODate(_ s: String) -> Date? {
    ISOFormats.plain.date(from: s) ?? ISOFormats.fractional.date(from: s)
}

private enum ISOFormats {
    nonisolated(unsafe) static let plain = ISO8601DateFormatter()
    nonisolated(unsafe) static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

/// Campus time. Class times and "Arrive 09:52" come from the server in
/// Singapore time, so bus times must too, even on a Mac set to another zone.
func campusTime(_ d: Date) -> String {
    d.formatted(Date.FormatStyle(date: .omitted, time: .shortened, timeZone: TimeZone(identifier: "Asia/Singapore")!))
}

/// "1.0.10" is newer than "1.0.9".
func isNewer(_ latest: String, than current: String) -> Bool {
    latest.compare(current, options: .numeric) == .orderedDescending
}

struct BoardRow: Decodable, Hashable {
    let svc: String
    let etaS: Int?
    let quality: String
}

struct NearbyStop: Decodable, Identifiable {
    struct Stop: Decodable { let code: String; let name: String }
    let stop: Stop
    let walkS: Int
    let available: Bool
    let board: [BoardRow]
    var id: String { stop.code }
}

struct Destination: Decodable, Hashable {
    let code: String
    let label: String
    let stopCode: String
    let kind: String
}

/// What the popover shows: the planned trip, a saved place, or any stop/venue.
enum Target: Hashable {
    case plan
    case place(key: String)
    case code(String, label: String)
}

struct ApiError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

struct Api {
    /// Override with TERMINUS_API_BASE=http://localhost:8787 for a local wrangler dev.
    static let base = ProcessInfo.processInfo.environment["TERMINUS_API_BASE"] ?? "https://terminus.rcn.sh"

    let token: String?

    func pair(code: String, name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/pair", body: ["code": code, "name": name])
        return r.token
    }

    func next(_ target: Target, lat: Double?, lon: Double?) async throws -> NextAnswer {
        var q = coords(lat, lon)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        return try await request("GET", "/me/next", query: q)
    }

    func nearby(lat: Double?, lon: Double?) async throws -> [NearbyStop] {
        struct R: Decodable { let stops: [NearbyStop] }
        let r: R = try await request("GET", "/me/nearby", query: coords(lat, lon))
        return r.stops
    }

    func destinations() async throws -> [Destination] {
        struct R: Decodable { let destinations: [Destination] }
        let r: R = try await request("GET", "/campus")
        return r.destinations
    }

    /// The released version, from /download/latest.json.
    func latestVersion() async throws -> String {
        struct R: Decodable { let version: String }
        let r: R = try await request("GET", "/download/latest.json")
        return r.version
    }

    /// Ends this device's session on the server.
    func logout() async throws {
        struct R: Decodable {}
        let _: R = try await request("POST", "/auth/logout", body: [:])
    }

    private func coords(_ lat: Double?, _ lon: Double?) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        return [URLQueryItem(name: "lat", value: String(lat)), URLQueryItem(name: "lon", value: String(lon))]
    }

    private func request<T: Decodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil
    ) async throws -> T {
        var comps = URLComponents(string: Api.base + path)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!, timeoutInterval: 10)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ApiError(status: status, message: msg ?? "HTTP \(status)")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
