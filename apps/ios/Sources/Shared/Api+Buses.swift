import Foundation

/// The Stops tab's own requests: the pinned stops as Nearby shows them, and
/// each line's buses out. `/api/campus` comes through CampusStore, read as
/// BusCampus.
extension Api {
    /// `/api/me/stops`: the stops asked for, each exactly as Nearby shows it;
    /// with a location, the walk to each, else none.
    func pinnedStops(_ codes: [String], lat: Double?, lon: Double?, acc: Double? = nil) async throws -> [NearbyStop] {
        struct R: Decodable { let stops: [NearbyStop] }
        let q = [URLQueryItem(name: "codes", value: codes.joined(separator: ","))] + Self.coords(lat, lon, acc)
        return try JSONDecoder().decode(R.self, from: await send("GET", "/api/me/stops", query: q)).stops
    }

    /// `/api/lines`: how many of each service's buses are out, by service (a
    /// service the feed didn't answer for is left out), and when they were counted.
    func lineCounts() async throws -> (counts: [String: LineCount], asOf: Date?) {
        struct R: Decodable {
            let lines: [String: Lossy<LineCount>]
            let asOf: String?
        }
        let r = try JSONDecoder().decode(R.self, from: await send("GET", "/api/lines"))
        return (r.lines.compactMapValues(\.value), r.asOf.flatMap(parseISODate))
    }
}

/// One service's buses out now, worded by the server ("3 out", "None out").
struct LineCount: Decodable, Equatable, Sendable {
    let out: Int
    let outText: String
    /// The feed's last answer rather than a new one.
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

/// `/api/campus` for the Stops tab: its stops in the order the server gives
/// them (the search's last tie-break is that order, as on Android and the
/// web), each service's colour, and each stop's nicknames.
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
        /// The full name ("Kent Ridge Bus Terminal"); `name` is the short one.
        var fullName: String { longName ?? name }
    }
    /// A service's stops in the order it calls (a loop's first stop once), and whether it's a loop;
    /// its name ("Loop from KR Bus Ter") and the stops it passes ("via AS 5, PGP, KR MRT"), worded by the server.
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
    /// Each service's colour ("#8e44c9"), by its code.
    let colors: [String: String]
    /// Every shuttle service, in plain code order.
    let services: [String]
    /// Each service's route, by its code.
    let routes: [String: Route]
    /// Each stop's nicknames, from /campus's destinations of kind "stop".
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
