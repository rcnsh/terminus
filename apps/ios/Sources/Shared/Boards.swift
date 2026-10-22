import Foundation

/// A service at a stop and its next bus, wherever a board appears
/// (/arrivals, /me/nearby, /line). Every time shown is one the API gave.
struct BoardRow: Decodable, Hashable, Sendable {
    struct Later: Decodable, Hashable, Sendable {
        var etaS: Int
        var quality: String
        var eta: String?
        enum CodingKeys: String, CodingKey { case etaS, quality, eta }
        init(etaS: Int, quality: String, eta: String?) {
            self.etaS = etaS
            self.quality = quality
            self.eta = eta
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            guard let e = c.lenientInt(forKey: .etaS) else {
                throw DecodingError.dataCorruptedError(forKey: .etaS, in: c, debugDescription: "no time")
            }
            etaS = e
            quality = c.string(.quality) ?? "live"
            eta = c.string(.eta)
        }
    }

    let svc: String
    var etaS: Int?
    var quality: String
    /// The service's colour ("#8e44c9").
    let color: String?
    /// A public bus, with a fare.
    let paid: Bool
    /// The buses after this one, soonest first.
    var later: [Later]
    /// The next stop's name, then where the route ends.
    let towards: [String]
    /// The well-known places it passes from here ("UTown", "Kent Ridge MRT"),
    /// for someone new to NUS; empty from an older server.
    let via: [String]
    let crowd: String?
    let endsAt: String?
    /// The route ends at this stop.
    let endsHere: Bool
    /// False: calls here but isn't running now (asked for with `stopped=1`).
    let running: Bool
    /// ended, notYet or noService.
    let stopped: String?
    let resumesAt: String?
    /// "4 min", "now", "~6 min", worded on the server.
    var eta: String?
    /// "then 12, ~20, 25 min".
    var laterText: String?
    /// "to Central Library, Kent Vale", "Ends here".
    let toText: String?

    enum CodingKeys: String, CodingKey {
        case svc, etaS, quality, color, paid, later, towards, via, crowd, endsAt, running, stopped, resumesAt, eta, laterText, toText
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        svc = try c.decode(String.self, forKey: .svc)
        etaS = c.lenientInt(forKey: .etaS)
        quality = c.string(.quality) ?? "unknown"
        color = c.string(.color).flatMap { $0.isEmpty ? nil : $0 }
        paid = c.bool(.paid) ?? false
        later = c.lenientList(Later.self, forKey: .later) ?? []
        let to = c.lenientList(String.self, forKey: .towards)
        towards = (to ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        endsHere = to.map { $0.allSatisfy { $0.trimmingCharacters(in: .whitespaces).isEmpty } } ?? false
        via = (c.lenientList(String.self, forKey: .via) ?? []).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        crowd = c.string(.crowd).flatMap { ["low", "medium", "high"].contains($0) ? $0 : nil }
        endsAt = c.string(.endsAt)
        running = c.bool(.running) ?? true
        stopped = c.string(.stopped).flatMap { ["ended", "notYet", "noService"].contains($0) ? $0 : nil }
        resumesAt = c.string(.resumesAt)
        eta = c.string(.eta).flatMap { $0.isEmpty ? nil : $0 }
        laterText = c.string(.laterText).flatMap { $0.isEmpty ? nil : $0 }
        toText = c.string(.toText).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// "4 min", "Arriving", "~6 min": the server's words, else worded here from etaS.
    var etaText: String? {
        if let eta { return eta }
        guard let s = etaS else { return nil }
        if s < BusTimes.arrivingS { return L("Arriving") }
        let m = "\(BusTimes.minutes(s))"
        return quality == "live" ? L("%@ min", m) : L("~%@ min", m)
    }

    /// "then 12, 20 min", the server's or worded here.
    var thenText: String? {
        if let laterText { return laterText }
        let mins = later.sorted { $0.etaS < $1.etaS }.prefix(3).map { "\(BusTimes.minutes($0.etaS))" }
        return mins.isEmpty ? nil : L("then %@ min", mins.joined(separator: ", "))
    }
}

/// A stop from /me/nearby, nearest first.
struct NearbyStop: Decodable, Identifiable, Sendable {
    struct Stop: Decodable, Sendable {
        let code: String
        let name: String
        let longName: String?
        let oppositeAcross: Bool?
        let oppositeName: String?
    }
    let stop: Stop
    let walkS: Int
    let available: Bool
    let board: [BoardRow]
    let opposite: String?
    /// Whether `opposite` is across the road (else only near), and its name:
    /// sent beside `stop`, or inside it by an older server.
    let oppositeAcross: Bool
    let oppositeName: String?
    let distM: Int?
    /// Which way its buses go, by places a newcomer knows ("to UTown, Science,
    /// Kent Ridge MRT"); nil with none, or from an older server.
    let viaText: String?
    var id: String { stop.code }

    enum CodingKeys: String, CodingKey { case stop, walkS, available, board, opposite, oppositeAcross, oppositeName, distM, viaText }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stop = try c.decode(Stop.self, forKey: .stop)
        walkS = c.lenientInt(forKey: .walkS) ?? 0
        available = c.bool(.available) ?? true
        board = c.lenientList(BoardRow.self, forKey: .board) ?? []
        opposite = c.string(.opposite).flatMap { $0.isEmpty ? nil : $0 }
        oppositeAcross = c.bool(.oppositeAcross) ?? stop.oppositeAcross ?? true
        oppositeName = c.string(.oppositeName) ?? stop.oppositeName
        distM = c.lenientInt(forKey: .distM)
        viaText = c.string(.viaText).flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// A stop's board: `/api/arrivals`, or a stop from /me/nearby.
struct Board: Sendable {
    let code: String
    /// The full name, for the page's title.
    let name: String
    let opposite: String?
    let oppositeAcross: Bool
    let oppositeName: String?
    /// False when the feed couldn't be reached: no times, which isn't "no buses".
    let available: Bool
    var rows: [BoardRow]
    let asOf: Date?
    var distM: Int? = nil
    /// When this phone got it, on the server's clock (BusTimes.aged).
    var got: Date? = nil

    /// The board as it stands at `now`: its rows aged.
    func aged(_ now: Date) -> Board {
        guard let got else { return self }
        var b = self
        b.rows = rows.map { BusTimes.aged($0, got: got, now: now) }
        return b
    }

    static func of(_ s: NearbyStop, got: Date?) -> Board {
        Board(
            code: s.stop.code, name: s.stop.longName ?? s.stop.name, opposite: s.opposite, oppositeAcross: s.stop.oppositeAcross ?? true,
            oppositeName: s.stop.oppositeName, available: s.available, rows: s.board, asOf: nil, distM: s.distM, got: got)
    }
}

extension Board: Decodable {
    private struct StopJSON: Decodable {
        let code: String
        let name: String?
        let longName: String?
        let opposite: String?
        let oppositeAcross: Bool?
        let oppositeName: String?
    }
    enum CodingKeys: String, CodingKey { case stop, available, board, asOf }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        let s = try c.decode(StopJSON.self, forKey: .stop)
        code = s.code
        name = [s.longName, s.name].compactMap { $0 }.first { !$0.isEmpty } ?? s.code
        opposite = s.opposite.flatMap { $0.isEmpty ? nil : $0 }
        oppositeAcross = s.oppositeAcross ?? true
        oppositeName = s.oppositeName.flatMap { $0.isEmpty ? nil : $0 }
        available = c.bool(.available) ?? true
        rows = c.lenientList(BoardRow.self, forKey: .board) ?? []
        asOf = c.string(.asOf).flatMap(parseISODate)
    }
}

/// `/api/line`: one service's stops in route order and where its buses are.
struct Line: Decodable, Sendable {
    struct Stop: Decodable, Sendable {
        let code: String
        let name: String
        let services: [String]
        enum CodingKeys: String, CodingKey { case code, name, longName, services }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            code = try c.decode(String.self, forKey: .code)
            name = [c.string(.longName), c.string(.name)].compactMap { $0 }.first { !$0.isEmpty } ?? code
            services = c.lenientList(String.self, forKey: .services) ?? []
        }
    }
    /// At stop `at`, or between stop `after` and the next.
    struct Bus: Decodable, Identifiable, Sendable {
        let id: String
        let plate: String?
        let crowd: String?
        let at: Int?
        let after: Int?
    }
    struct Here: Decodable, Sendable {
        let code: String
        let index: Int
        var row: BoardRow?
    }

    let svc: String
    let color: String?
    let endsAt: String?
    let stops: [Stop]
    let buses: [Bus]
    var here: Here?
    let available: Bool
    let asOf: Date?
    let running: Bool
    let stopped: String?
    let resumesAt: String?
    var got: Date? = nil

    enum CodingKeys: String, CodingKey {
        case svc, color, endsAt, stops, buses
        case here = "stop"
        case available, asOf, running, stopped, resumesAt
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        svc = try c.decode(String.self, forKey: .svc)
        color = c.string(.color)
        endsAt = c.string(.endsAt)
        stops = c.lenientList(Stop.self, forKey: .stops) ?? []
        let n = stops.count
        buses = (c.lenientList(Bus.self, forKey: .buses) ?? []).map {
            Bus(
                id: $0.id, plate: $0.plate.flatMap { $0.isEmpty ? nil : $0 }, crowd: $0.crowd,
                at: $0.at.flatMap { $0 >= 0 && $0 < n ? $0 : nil }, after: $0.after.flatMap { $0 >= 0 && $0 < n ? $0 : nil })
        }
        here = (try? c.decodeIfPresent(Here.self, forKey: .here)).flatMap { $0 }.flatMap { $0.index >= 0 && $0.index < n ? $0 : nil }
        available = c.bool(.available) ?? true
        asOf = c.string(.asOf).flatMap(parseISODate)
        running = c.bool(.running) ?? true
        stopped = c.string(.stopped)
        resumesAt = c.string(.resumesAt)
    }

    func aged(_ now: Date) -> Line {
        guard let got, let row = here?.row else { return self }
        var l = self
        l.here?.row = BusTimes.aged(row, got: got, now: now)
        return l
    }
}

/// How the Buses tab shows one time.
enum BusTimes {
    /// Under this long away: "Arriving", not "0 min" (the server's own threshold, format.ts).
    static let arrivingS = 45
    /// The tab refreshes the page in view this often (the API caches arrivals 15 s).
    static let refreshS: TimeInterval = 15
    /// Times got longer ago than this have missed a refresh at least.
    static let oldS: TimeInterval = 2 * refreshS

    /// Row `r` from an answer got at `got`, as it stands at `now`, as the web's
    /// `aged()`: once it's old its times are counted down from when it came, a
    /// bus over a minute past has no time, and a live time no longer passes as live.
    static func aged(_ r: BoardRow, got: Date, now: Date) -> BoardRow {
        let age = now.timeIntervalSince(got)
        guard let eta = r.etaS, age > oldS else { return r }
        let s = Int(age)
        let left = eta - s
        var out = r
        out.etaS = left > -60 ? max(0, left) : nil
        out.eta = nil
        out.quality = r.quality == "live" ? "stale" : r.quality
        out.laterText = nil
        out.later = r.later.map { BoardRow.Later(etaS: $0.etaS - s, quality: $0.quality, eta: nil) }.filter { $0.etaS > 0 }
        return out
    }

    /// Rounded to the nearest minute, never below 1.
    static func minutes(_ etaS: Int) -> Int { max(1, (etaS + 30) / 60) }
}

/// What a service that isn't running says instead of a time: why, and when it's back.
struct Stopped: Equatable {
    struct Back: Equatable {
        let at: Date
        let today: Bool
        let tomorrow: Bool
    }
    let why: String
    let back: Back?

    static func of(running: Bool, why: String?, resumesAt: String?, now: Date) -> Stopped? {
        guard !running else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .campus
        let back = resumesAt.flatMap(parseISODate).flatMap { at -> Back? in
            guard at > now else { return nil }
            let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: at)).day ?? 0
            return Back(at: at, today: days <= 0, tomorrow: days == 1)
        }
        return Stopped(why: why ?? "ended", back: back)
    }

    /// "Stopped for today", "Back tomorrow at 7:40 AM".
    var lines: (String, String?) {
        let first =
            switch why {
            case "notYet": L("Not running yet")
            case "noService": L("No service today")
            default: L("Stopped for today")
            }
        guard let b = back else { return (first, nil) }
        let t = campusTime(b.at)
        if b.today { return (first, L("Starts at %@", t)) }
        if b.tomorrow { return (first, L("Back tomorrow at %@", t)) }
        let f = DateFormatter()
        f.locale = Lang.locale
        f.timeZone = .campus
        f.setLocalizedDateFormatFromTemplate("EEEE")
        return (first, L("Back %@ at %@", f.string(from: b.at), t))
    }
}

struct Destination: Decodable, Hashable, Sendable {
    let code: String
    let label: String
    let stopCode: String
    let kind: String
    /// Metres on foot from the stop; nil for a stop.
    let walkM: Int?
    /// Other names people search for, lower case ("soc", "mrt").
    let aliases: [String]
    /// A landmark's every stop; the router takes the quicker.
    let stops: [String]
    /// What a landmark is ("Food court").
    let detail: String?

    /// Where a favourite or a class added here goes: a landmark itself, anything else its stop.
    var goesTo: String { kind == "landmark" ? code : stopCode }

    enum CodingKeys: String, CodingKey { case code, label, stopCode, kind, walkM, aliases, stops, detail }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        label = try c.decode(String.self, forKey: .label)
        stopCode = try c.decode(String.self, forKey: .stopCode)
        kind = try c.decode(String.self, forKey: .kind)
        walkM = c.lenientInt(forKey: .walkM)
        aliases = c.lenientList(String.self, forKey: .aliases) ?? []
        stops = c.lenientList(String.self, forKey: .stops) ?? []
        detail = c.string(.detail)
    }
}

/// The destination search, with the rules and cases every client is held to
/// (fixtures/search.json; the web's account/search.js is the
/// reference): exact, then starts with, then a word starts with, then
/// contains; then by kind, then the shorter label, then the list's own order.
/// Rooms only once two characters say which.
enum SearchRank {
    struct Key {
        let kind: String
        let code: String
        let label: String
        let aliases: [String]
    }
    static let kinds = ["timetable", "place", "class", "service", "stop", "landmark", "building", "room"]

    static func rank<T>(_ all: [T], _ query: String, max: Int = 8, key: (T) -> Key) -> [T] {
        let trimmed = query.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}")))
        let q = trimmed.lowercased()
        guard !q.isEmpty else { return [] }
        let norm = { (s: String) in s.lowercased().replacingOccurrences(of: #"[\s\-_]+"#, with: "", options: .regularExpression) }
        let nq = norm(q)
        func kindRank(_ k: String) -> Int { kinds.firstIndex(of: k) ?? kinds.count }
        func words(_ s: String) -> [Substring] { s.split(whereSeparator: { $0.isWhitespace || "()·,/&-".contains($0) }) }
        // Plain comparisons, as JavaScript makes them: by UTF-16 code units.
        func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
        func starts(_ a: some StringProtocol, _ p: String) -> Bool { a.utf16.starts(with: p.utf16) }
        func contains(_ a: String, _ p: String) -> Bool { a.range(of: p, options: .literal) != nil }
        func score(_ k: Key) -> Int {
            let names = [k.code.lowercased(), k.label.lowercased()] + k.aliases.map { $0.lowercased() }
            let code: String? = nq.isEmpty ? nil : norm(k.code)
            if names.contains(where: { same($0, q) }) || code.map({ same($0, nq) }) == true { return 0 }
            if names.contains(where: { starts($0, q) }) || code.map({ starts($0, nq) }) == true { return 1 }
            if names.contains(where: { words($0).contains { starts($0, q) } }) { return 2 }
            if names.contains(where: { contains($0, q) }) { return 3 }
            return -1
        }
        return all.enumerated()
            .map { (i: $0.offset, t: $0.element, k: key($0.element)) }
            .filter { $0.k.kind != "room" || trimmed.utf16.count >= 2 }
            .map { (i: $0.i, t: $0.t, k: $0.k, s: score($0.k)) }
            .filter { $0.s >= 0 }
            .sorted { a, b in
                if a.s != b.s { return a.s < b.s }
                let ka = kindRank(a.k.kind)
                let kb = kindRank(b.k.kind)
                if ka != kb { return ka < kb }
                let la = a.k.label.utf16.count
                let lb = b.k.label.utf16.count
                if la != lb { return la < lb }
                return a.i < b.i
            }
            .prefix(max)
            .map(\.t)
    }
}

func rankDestinations(_ all: [Destination], _ query: String, max: Int = 8) -> [Destination] {
    SearchRank.rank(all, query, max: max) { SearchRank.Key(kind: $0.kind, code: $0.code, label: $0.label, aliases: $0.aliases) }
}

/// `/api/campus`, as the pickers use it: every stop, the residences and the
/// destinations. The map reads the same answer for its lines (CampusMap).
struct Campus: Decodable, Sendable {
    struct Stop: Decodable, Hashable, Sendable {
        let code: String
        let name: String
        let longName: String?
        let lat: Double?
        let lon: Double?
        let services: [String]
        enum CodingKeys: String, CodingKey { case code, name, longName, lat, lon, services }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            code = try c.decode(String.self, forKey: .code)
            name = c.string(.name) ?? code
            longName = c.string(.longName)
            lat = try? c.decodeIfPresent(Double.self, forKey: .lat)
            lon = try? c.decodeIfPresent(Double.self, forKey: .lon)
            services = c.lenientList(String.self, forKey: .services) ?? []
        }
        var fullName: String { longName.flatMap { $0.isEmpty ? nil : $0 } ?? name }
    }
    /// `common`: where most students live, shown first. `walkMin`: minutes on foot to its stop.
    struct Residence: Decodable, Hashable, Sendable {
        let code: String
        let name: String
        let stops: [String]
        let walkM: Double?
        let walkMin: Int?
        let common: Bool?
        var minutes: Int { walkMin ?? max(1, Int(((walkM ?? 0) / 1.3 / 60).rounded())) }
    }
    struct Route: Decodable, Sendable { let color: String? }
    let stops: [Stop]
    let residences: [Residence]
    let destinations: [Destination]
    let routes: [String: Route]

    enum CodingKeys: String, CodingKey { case stops, residences, destinations, routes }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = (c.lenientList(Stop.self, forKey: .stops) ?? []).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        residences = (c.lenientList(Residence.self, forKey: .residences) ?? []).sorted {
            ($0.common == true) != ($1.common == true) ? $0.common == true : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        destinations = c.lenientList(Destination.self, forKey: .destinations) ?? []
        routes = (try? c.decodeIfPresent([String: Route].self, forKey: .routes)) ?? [:]
    }

    func stopName(_ code: String) -> String { stops.first { $0.code == code }?.name ?? code }
    func stop(_ code: String) -> Stop? { stops.first { $0.code == code } }
    func color(_ svc: String) -> String? { routes[svc]?.color }
    /// Every shuttle service, in code order.
    var services: [String] { routes.keys.sorted() }
}
