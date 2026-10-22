import Foundation

/// The Buses tab's own requests: /me/nearby with the answer's `asOf` (for
/// "Updated 5 s ago"), and /campus read in its own order for the search.
extension Api {
    /// /me/nearby's stops as boards, nearest first, with the services not
    /// running now, and the answer as it came (kept for the widgets,
    /// NearbyShared). Without a location the server answers from the home
    /// stop; with neither it answers 400.
    func nearbyBoards(lat: Double?, lon: Double?, acc: Double? = nil) async throws -> (boards: [Board], data: Data) {
        // Whether the twin is across the road, and its name, may come on the
        // stop or beside it (as Android reads them): the stop's first.
        struct Twin: Decodable {
            struct S: Decodable {
                let oppositeAcross: Bool?
                let oppositeName: String?
            }
            let stop: S?
            let oppositeAcross: Bool?
            let oppositeName: String?
        }
        struct R: Decodable {
            let stops: [NearbyStop]
            let asOf: String?
        }
        struct T: Decodable { let stops: [Twin] }
        let data = try await send("GET", "/api/me/nearby", query: Self.coords(lat, lon, acc) + [URLQueryItem(name: "stopped", value: "1")])
        let r = try JSONDecoder().decode(R.self, from: data)
        let twins = (try? JSONDecoder().decode(T.self, from: data).stops) ?? []
        let asOf = r.asOf.flatMap(parseISODate)
        let got = ServerClock.now
        let boards = r.stops.enumerated().map { i, s in
            let t = twins.indices.contains(i) ? twins[i] : nil
            let name = t?.stop?.oppositeName ?? t?.oppositeName
            return Board(
                code: s.stop.code, name: s.stop.longName ?? s.stop.name, opposite: s.opposite,
                oppositeAcross: t?.stop?.oppositeAcross ?? t?.oppositeAcross ?? true,
                oppositeName: name.flatMap { $0.isEmpty ? nil : $0 },
                available: s.available, rows: s.board, asOf: asOf, distM: s.distM, got: got)
        }
        return (boards, data)
    }

    /// `/api/campus` as the Buses tab uses it.
    func busCampus() async throws -> BusCampus {
        try JSONDecoder().decode(BusCampus.self, from: await send("GET", "/api/campus"))
    }
}

/// `/api/campus` for the Buses tab: its stops in the order the server gives
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
    private struct Route: Decodable { let color: String? }
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
    /// Each stop's nicknames, from /campus's destinations of kind "stop".
    let aliases: [String: [String]]

    enum CodingKeys: String, CodingKey { case stops, routes, destinations }

    init(stops: [Stop], colors: [String: String], services: [String], aliases: [String: [String]]) {
        self.stops = stops
        self.colors = colors
        self.services = services
        self.aliases = aliases
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = c.lenientList(Stop.self, forKey: .stops) ?? []
        let routes = (try? c.decodeIfPresent([String: Route].self, forKey: .routes)) ?? [:]
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
