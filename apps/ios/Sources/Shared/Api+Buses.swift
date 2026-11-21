import Foundation

extension Api {
    func pinnedStops(_ codes: [String], lat: Double?, lon: Double?, acc: Double? = nil) async throws -> [NearbyStop] {
        struct R: Decodable { let stops: [NearbyStop] }
        let q =
            [URLQueryItem(name: "codes", value: codes.joined(separator: ","))] + Self.coords(lat, lon, acc)
            + [URLQueryItem(name: "stopped", value: "1")]
        return try JSONDecoder().decode(R.self, from: await send("GET", "/api/me/stops", query: q)).stops
    }

    func lineCounts() async throws -> (counts: [String: LineCount], asOf: Date?) {
        struct R: Decodable {
            let lines: [String: Lossy<LineCount>]
            let asOf: String?
        }
        let r = try JSONDecoder().decode(R.self, from: await send("GET", "/api/lines"))
        return (r.lines.compactMapValues(\.value), r.asOf.flatMap(parseISODate))
    }
}

struct LineCount: Decodable, Equatable, Sendable {
    let out: Int
    let outText: String
    let stale: Bool

    enum CodingKeys: String, CodingKey { case out, outText, stale }

    init(out: Int, outText: String, stale: Bool = false) {
        self.out = out
        self.outText = outText
        self.stale = stale
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        guard let out = c.lenientInt(forKey: .out), let text = c.string(.outText), !text.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .outText, in: c, debugDescription: "no count")
        }
        self.out = out
        outText = text
        stale = c.bool(.stale) ?? false
    }
}

struct BusCampus: Decodable, Sendable {
    struct Stop: Decodable, Hashable, Sendable {
        let code: String
        let name: String
        let longName: String?
        let services: [String]
        enum CodingKeys: String, CodingKey { case code, name, longName, services }
        init(code: String, name: String, longName: String?, services: [String]) {
            self.code = code
            self.name = name
            self.longName = longName
            self.services = services
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            code = try c.decode(String.self, forKey: .code)
            name = c.string(.name) ?? code
            longName = c.string(.longName).flatMap { $0.isEmpty ? nil : $0 }
            services = c.lenientList(String.self, forKey: .services) ?? []
        }
        var fullName: String { longName ?? name }
    }
    struct Route: Decodable, Hashable, Sendable {
        let seq: [String]
        let loop: Bool
        let color: String?
        let name: String?
        let via: String?
        enum CodingKeys: String, CodingKey { case seq, loop, color, name, via }
        init(seq: [String], loop: Bool, color: String? = nil, name: String? = nil, via: String? = nil) {
            self.seq = seq
            self.loop = loop
            self.color = color
            self.name = name
            self.via = via
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            seq = c.lenientList(String.self, forKey: .seq) ?? []
            loop = (try? c.decodeIfPresent(Bool.self, forKey: .loop)) ?? false
            color = c.string(.color)
            name = c.string(.name).flatMap { $0.isEmpty ? nil : $0 }
            via = c.string(.via).flatMap { $0.isEmpty ? nil : $0 }
        }
    }
    private struct Dest: Decodable {
        let code: String
        let kind: String
        let aliases: [String]?
    }

    let stops: [Stop]
    let colors: [String: String]
    let services: [String]
    let routes: [String: Route]
    let aliases: [String: [String]]

    enum CodingKeys: String, CodingKey { case stops, routes, destinations }

    init(stops: [Stop], colors: [String: String], services: [String], aliases: [String: [String]], routes: [String: Route] = [:]) {
        self.stops = stops
        self.colors = colors
        self.services = services
        self.aliases = aliases
        self.routes = routes
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = c.lenientList(Stop.self, forKey: .stops) ?? []
        routes = (try? c.decodeIfPresent([String: Route].self, forKey: .routes)) ?? [:]
        colors = routes.compactMapValues(\.color)
        services = routes.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        let dests = c.lenientList(Dest.self, forKey: .destinations) ?? []
        var a: [String: [String]] = [:]
        for d in dests where d.kind == "stop" { a[d.code] = d.aliases ?? [] }
        aliases = a
    }

    func stop(_ code: String) -> Stop? { stops.first { $0.code == code } }
    func color(_ svc: String) -> String? { colors[svc] }
}
