import Foundation

/// The Buses tab's own request: /campus read in its own order for the search.
extension Api {
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
    /// A service's stops in the order it calls (a loop's first stop once), and whether it's a loop.
    struct Route: Decodable, Hashable, Sendable {
        let seq: [String]
        let loop: Bool
        let color: String?
        enum CodingKeys: String, CodingKey { case seq, loop, color }
        init(seq: [String], loop: Bool, color: String? = nil) {
            self.seq = seq
            self.loop = loop
            self.color = color
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            seq = c.lenientList(String.self, forKey: .seq) ?? []
            loop = (try? c.decodeIfPresent(Bool.self, forKey: .loop)) ?? false
            color = c.string(.color)
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
