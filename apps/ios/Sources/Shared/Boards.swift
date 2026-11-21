import Foundation

struct BoardRow: Decodable, Hashable, Sendable {
    struct Later: Decodable, Hashable, Sendable {
        var etaS: Int
        var quality: String
        var eta: String?
        var at: String?
        enum CodingKeys: String, CodingKey { case etaS, quality, eta, at }
        init(etaS: Int, quality: String, eta: String?, at: String? = nil) {
            self.etaS = etaS
            self.quality = quality
            self.eta = eta
            self.at = at
        }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            guard let e = c.lenientInt(forKey: .etaS) else {
                throw DecodingError.dataCorruptedError(forKey: .etaS, in: c, debugDescription: "no time")
            }
            etaS = e
            quality = c.string(.quality) ?? "live"
            eta = c.string(.eta)
            at = c.string(.at).flatMap { $0.isEmpty ? nil : $0 }
        }

        var etaText: String { eta ?? BusTimes.words(etaS, quality: quality) }
    }

    let svc: String
    var etaS: Int?
    var quality: String
    let color: String?
    let paid: Bool
    var later: [Later]
    let towards: [String]
    let via: [String]
    var crowd: String?
    let endsAt: String?
    let endsHere: Bool
    var running: Bool
    var stopped: String?
    var resumesAt: String?
    var eta: String?
    var laterText: String?
    let toText: String?
    let at: String?
    var dest: String?
    var destPlace: String?

    enum CodingKeys: String, CodingKey {
        case svc, etaS, quality, color, paid, later, towards, via, crowd, endsAt, running, stopped, resumesAt, eta, laterText, toText, at,
            dest, destPlace
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
        at = c.string(.at).flatMap { $0.isEmpty ? nil : $0 }
        dest = c.string(.dest).flatMap { $0.isEmpty ? nil : $0 }
        destPlace = c.string(.destPlace).flatMap { $0.isEmpty ? nil : $0 }
    }

    var etaText: String? { eta ?? etaS.map { BusTimes.words($0, quality: quality) } }

    var thenText: String? {
        if let laterText { return laterText }
        let mins = later.sorted { $0.etaS < $1.etaS }.prefix(2).map { "\(BusTimes.minutes($0.etaS))" }
        return mins.isEmpty ? nil : L("then %@ min", mins.joined(separator: ", "))
    }
}

struct NearbyStop: Decodable, Identifiable, Sendable {
    struct Stop: Decodable, Sendable {
        let code: String
        let name: String
        let longName: String?
    }
    let stop: Stop
    let walkS: Int?
    var available: Bool
    var board: [BoardRow]
    let opposite: String?
    let oppositeAcross: Bool
    let oppositeName: String?
    let distM: Int?
    let viaText: String?
    var id: String { stop.code }

    enum CodingKeys: String, CodingKey { case stop, walkS, available, board, opposite, oppositeAcross, oppositeName, distM, viaText }

    func aged(got: Date?, now: Date) -> NearbyStop {
        guard let got else { return self }
        var s = self
        s.board = board.map { BusTimes.aged($0, got: got, now: now) }
        return s
    }

    init(placeholder code: String, name: String) {
        stop = Stop(code: code, name: name, longName: nil)
        walkS = nil
        available = true
        board = []
        opposite = nil
        oppositeAcross = true
        oppositeName = nil
        distM = nil
        viaText = nil
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stop = try c.decode(Stop.self, forKey: .stop)
        walkS = c.lenientInt(forKey: .walkS)
        available = c.bool(.available) ?? true
        board = c.lenientList(BoardRow.self, forKey: .board) ?? []
        opposite = c.string(.opposite).flatMap { $0.isEmpty ? nil : $0 }
        oppositeAcross = c.bool(.oppositeAcross) ?? true
        oppositeName = c.string(.oppositeName)
        distM = c.lenientInt(forKey: .distM)
        viaText = c.string(.viaText).flatMap { $0.isEmpty ? nil : $0 }
    }
}

struct Board: Sendable {
    let code: String
    let name: String
    let opposite: String?
    let oppositeAcross: Bool
    let oppositeName: String?
    let available: Bool
    var rows: [BoardRow]
    let asOf: Date?
    var distM: Int? = nil
    var got: Date? = nil

    func aged(_ now: Date) -> Board {
        guard let got else { return self }
        var b = self
        b.rows = rows.map { BusTimes.aged($0, got: got, now: now) }
        return b
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

struct Line: Decodable, Sendable {
    struct Stop: Decodable, Sendable {
        let code: String
        let name: String
        let services: [String]
        enum CodingKeys: String, CodingKey { case code, name, longName, services }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            code = try c.decode(String.self, forKey: .code)
            name = Self.named(code, name: c.string(.name), longName: c.string(.longName))
            services = c.lenientList(String.self, forKey: .services) ?? []
        }
        static func named(_ code: String, name: String?, longName: String?) -> String {
            [longName, name].compactMap { $0 }.first { !$0.isEmpty } ?? code
        }
    }
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
    let out: LineCount?
    var got: Date? = nil

    enum CodingKeys: String, CodingKey {
        case svc, color, endsAt, stops, buses
        case here = "stop"
        case available, asOf, running, stopped, resumesAt, out
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
        out = (try? c.decodeIfPresent(LineCount.self, forKey: .out)).flatMap { $0 }
    }

    func aged(_ now: Date) -> Line {
        guard let got, let row = here?.row else { return self }
        var l = self
        l.here?.row = BusTimes.aged(row, got: got, now: now)
        return l
    }
}

enum BusTimes {
    static let arrivingS = 45
    static let refreshS: TimeInterval = 15
    static let oldS: TimeInterval = 2 * refreshS

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
        out.later = r.later.map { BoardRow.Later(etaS: $0.etaS - s, quality: $0.quality, eta: nil, at: $0.at) }
            .filter { $0.etaS > 0 }
        return out
    }

    static func words(_ etaS: Int, quality: String) -> String {
        let m = "\(minutes(etaS))"
        guard quality == "live" else { return L("~%@ min", m) }
        return etaS < arrivingS ? L("Arriving") : L("%@ min", m)
    }

    static func minutes(_ etaS: Int) -> Int { max(1, (etaS + 30) / 60) }
}

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
    let walkM: Int?
    let aliases: [String]
    let stops: [String]
    let detail: String?

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
    var services: [String] { routes.keys.sorted() }
}
