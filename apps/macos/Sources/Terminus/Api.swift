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
    /// Already at the destination: no bus, no countdown.
    let arrived: Bool
    /// When the plan changes by itself (a class starts, the day ends).
    let refreshAt: String?
    let timing: Timing?
    let arrivals: [ArrivalLite]?
    /// The latest time to set off; for a class, the latest that's still on time.
    let leave: Leave?

    struct Timing: Decodable { let status: String?; let text: String?; let classAt: String?; let reachAt: String? }
    struct Leave: Decodable { let at: String; let estimated: Bool?; let svc: String?; let stop: String?; let board: String?; let arrive: String? }

    enum CodingKeys: String, CodingKey { case label, detail, alt, stop, quality, asOf, mode, dest, places, departsAt, refreshAt, timing, arrivals, arrived, leave }

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
        arrived = (try? c.decodeIfPresent(Bool.self, forKey: .arrived)) ?? false
        leave = try? c.decodeIfPresent(Leave.self, forKey: .leave)
    }
    struct ArrivalLite: Decodable { let svc: String; let crowd: String? }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }
    var service: String { label.components(separatedBy: " · ").first ?? label }
    /// Crowd on the recommended bus, not whichever is first in the list.
    var crowd: String? { arrivals?.first { $0.svc == service }?.crowd }
    private var tilde: String { leave?.estimated == true ? "~" : "" }
    var leaveAt: Date? { leave.flatMap { parseISODate($0.at) } }
    var classAt: Date? { timing?.classAt.flatMap(parseISODate) }

    /// A class with a leave-by time: lead with when to leave, and offer the
    /// next bus as "or go now". Same rule as the Android app.
    var isClassPlan: Bool { dest?.why == "class" && leaveAt != nil && classAt != nil && !arrived && mode == "trip" }

    /// "Leave by ~09:38", or "Leave now" once it has passed.
    func leaveHeadline(now: Date = Date()) -> String? {
        guard let at = leaveAt else { return nil }
        return now >= at ? "Leave now" : "Leave by \(tilde)\(campusTime(at))"
    }

    /// "Catch the ~09:41 D2 at PGP · arrive ~09:55, 3 min early", or on foot.
    var catchLine: String? {
        guard let l = leave else { return nil }
        let how: String
        if let svc = l.svc {
            how = l.board.flatMap(parseISODate).map { "Catch the \(tilde)\(campusTime($0)) \(svc) at \(l.stop ?? "")" } ?? "Catch the \(svc) at \(l.stop ?? "")"
        } else {
            how = "Walk there"
        }
        guard let arrive = l.arrive.flatMap(parseISODate) else { return how }
        let slack = classAt.map { c -> String in
            let m = Int((c.timeIntervalSince(arrive) / 60).rounded())
            return m > 0 ? ", \(m) min early" : m == 0 ? ", just in time" : ", ~\(-m) min late"
        } ?? ""
        return "\(how) · arrive \(tilde)\(campusTime(arrive))\(slack)"
    }

    var leaveLate: Bool {
        guard let a = leave?.arrive.flatMap(parseISODate), let c = classAt else { return false }
        return a > c
    }

    /// The headline bus when it isn't the one to wait for.
    var goNowLine: String? {
        guard hasLiveTime, let d = departure else { return nil }
        if let b = leave?.board.flatMap(parseISODate), abs(b.timeIntervalSince(d)) < 60 { return nil }
        let reach = timing?.reachAt.flatMap(parseISODate).map { " · arrive \(campusTime($0))" } ?? ""
        return "Or go now: \(service) at \(quality == "scheduled" ? "~" : "")\(campusTime(d))\(reach)"
    }

    /// Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP".
    func leaveText(now: Date = Date()) -> String? {
        guard let head = leaveHeadline(now: now), let l = leave else { return nil }
        guard let svc = l.svc else { return head }
        let t = l.board.flatMap(parseISODate).map { "\(tilde)\(campusTime($0)) " } ?? ""
        return "\(head) · catch the \(t)\(svc) at \(l.stop ?? "")"
    }

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

/// One vocabulary everywhere, matching the API's detail line.
func crowdWord(_ c: String?) -> String? {
    switch c {
    case "low": "Quiet"
    case "medium": "Filling"
    case "high": "Packed"
    default: nil
    }
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
        // Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and
        // no more precise than that in URLs that pass through logs.
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        return [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
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
