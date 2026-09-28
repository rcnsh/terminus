import Foundation

struct Place: Decodable, Hashable {
    let key: String
    let label: String
}

/// `/me/next`. label and detail are display-ready; show them verbatim.
struct NextAnswer: Decodable {
    struct Stop: Decodable { let code: String; let name: String }
    struct Dest: Decodable { let to: String; let label: String; let why: String }

    let label: String
    let detail: String
    let alt: String?
    let stop: Stop
    let quality: String
    let asOf: String
    let mode: String?
    let dest: Dest?
    let places: [Place]?
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
    /// Override with NUSBUS_API_BASE=http://localhost:8787 for a local wrangler dev.
    static let base = ProcessInfo.processInfo.environment["NUSBUS_API_BASE"] ?? "https://nusbus.rcn.sh"

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
