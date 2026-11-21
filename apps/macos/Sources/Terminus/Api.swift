import AppKit
import Foundation

struct Place: Decodable, Hashable {
    let key: String
    let label: String
}

struct NextAnswer: Decodable {
    struct Stop: Decodable {
        let code: String
        let name: String
    }
    struct Dest: Decodable {
        let to: String?
        let label: String
        let why: String
        let place: Bool?
    }

    let label: String
    let detail: String
    let alt: String?
    let stop: Stop?
    let quality: String
    let asOf: String?
    let mode: String?
    let dest: Dest?
    let places: [Place]?
    let departsAt: String?
    let arrived: Bool
    let refreshAt: String?
    let timing: Timing?
    let arrivals: [ArrivalLite]?
    let leave: Leave?
    let card: Card?
    let walkSpeedMs: Double?
    var raw: Data? = nil

    struct Timing: Decodable {
        let status: String?
        let text: String?
        let classAt: String?
        let reachAt: String?
    }
    struct Leave: Decodable {
        let at: String
        let estimated: Bool?
        let svc: String?
        let stop: String?
        let board: String?
        let arrive: String?
        let note: String?
    }
    struct Card: Decodable {
        let kind: String
        let staleAt: String?
        let crowd: String?
        let quality: String?
        let leaveBy: String?
        let leaveVia: String?
        let `catch`: String?
        let arrive: String?
        let late: Bool?
        let goNow: String?
        let note: String?
        let estimate: String?
        let fromNus: Bool?
        let reasons: [String]?
        let phase: String?
        let phaseText: String?
        let glance: String?
        let line: String?
        let actions: [CardAction]?
        let warning: String?
        let nextChangeAt: String?
        let remind: Bool?
        let suggestion: Suggestion?
        let notice: String?
        let upcoming: Upcoming?
        let title: String?
        let heading: String?
        let remindAt: String?
        let journey: Journey?
        let ride: Ride?
        let gone: Bool
        let step: Step?

        static let kinds: Set = ["class", "trip", "nearby", "rest", "arrived", "setup", "free"]

        enum CodingKeys: String, CodingKey {
            case kind, staleAt, crowd, quality, leaveBy, leaveVia, `catch`, arrive, late, goNow, note, estimate, phase, phaseText, glance,
                line, actions, warning, nextChangeAt, remind, suggestion, notice, upcoming
            case title, heading, remindAt, journey, ride, gone, step, fromNus, reasons
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            let s = { (k: CodingKeys) in try? c.decodeIfPresent(String.self, forKey: k) }
            kind = s(.kind).flatMap { Self.kinds.contains($0) ? $0 : nil } ?? "trip"
            staleAt = s(.staleAt)
            crowd = s(.crowd)
            quality = s(.quality)
            leaveBy = s(.leaveBy)
            leaveVia = s(.leaveVia)
            `catch` = s(.catch)
            arrive = s(.arrive)
            late = try? c.decodeIfPresent(Bool.self, forKey: .late)
            goNow = s(.goNow)
            note = s(.note)
            estimate = s(.estimate)
            fromNus = try? c.decodeIfPresent(Bool.self, forKey: .fromNus)
            reasons = try? c.decodeIfPresent([String].self, forKey: .reasons)
            phase = s(.phase)
            phaseText = s(.phaseText)
            glance = s(.glance)
            line = s(.line)
            actions = c.lenientList(CardAction.self, forKey: .actions)
            warning = s(.warning)
            nextChangeAt = s(.nextChangeAt)
            remind = try? c.decodeIfPresent(Bool.self, forKey: .remind)
            suggestion = try? c.decodeIfPresent(Suggestion.self, forKey: .suggestion)
            notice = s(.notice)
            upcoming = try? c.decodeIfPresent(Upcoming.self, forKey: .upcoming)
            title = s(.title)
            heading = s(.heading)
            remindAt = s(.remindAt)
            journey = try? c.decodeIfPresent(Journey.self, forKey: .journey)
            ride = try? c.decodeIfPresent(Ride.self, forKey: .ride)
            gone = (try? c.decodeIfPresent(Bool.self, forKey: .gone)) == true
            step = try? c.decodeIfPresent(Step.self, forKey: .step)
        }
    }

    struct Step: Decodable, Equatable {
        let trip: String
        let earlier: StepTarget?
        let later: StepTarget?
        let moved: Bool
        let earlierLabel: String
        let laterLabel: String
        let bestLabel: String

        enum CodingKeys: String, CodingKey { case trip, earlier, later, moved, earlierLabel, laterLabel, bestLabel }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            trip = try c.decode(String.self, forKey: .trip)
            earlier = try? c.decodeIfPresent(StepTarget.self, forKey: .earlier)
            later = try? c.decodeIfPresent(StepTarget.self, forKey: .later)
            moved = (try? c.decodeIfPresent(Bool.self, forKey: .moved)) == true
            earlierLabel = try c.decode(String.self, forKey: .earlierLabel)
            laterLabel = try c.decode(String.self, forKey: .laterLabel)
            bestLabel = try c.decode(String.self, forKey: .bestLabel)
        }
    }

    struct Journey: Decodable {
        let title: String
        let byText: String?
        let walkText: String?
        let rideText: String?
        let walkEndText: String?
        let arriveText: String?
        let arriveWhere: String?
        let backupText: String?
        let summary: String?
        let bus: Bus?
        struct Bus: Decodable {
            let svc: String
            let color: String?
        }
        let change: Change?
        struct Change: Decodable {
            let bus: Bus
            let firstRideText: String
            let changeText: String
            let rideText: String
        }

        enum CodingKeys: String, CodingKey {
            case title, byText, walkText, rideText, walkEndText, arriveText, arriveWhere, backupText, summary, bus, change
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            title = try c.decode(String.self, forKey: .title)
            let s = { (k: CodingKeys) in try? c.decodeIfPresent(String.self, forKey: k) }
            byText = s(.byText)
            walkText = s(.walkText)
            rideText = s(.rideText)
            walkEndText = s(.walkEndText)
            arriveText = s(.arriveText)
            arriveWhere = s(.arriveWhere)
            backupText = s(.backupText)
            summary = s(.summary)
            bus = try? c.decodeIfPresent(Bus.self, forKey: .bus)
            change = bus == nil ? nil : try? c.decodeIfPresent(Change.self, forKey: .change)
        }
    }

    struct Ride: Decodable {
        struct Stop: Decodable, Hashable {
            let code: String?
            let name: String
        }
        let svc: String
        let stops: [Stop]
        let board: String
        let arrive: String
        let change: Change?
        struct Change: Decodable {
            let svc: String
            let text: String
        }

        enum CodingKeys: String, CodingKey { case svc, stops, board, arrive, change }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            svc = try c.decode(String.self, forKey: .svc)
            stops = c.lenientList(Stop.self, forKey: .stops) ?? []
            board = try c.decode(String.self, forKey: .board)
            arrive = try c.decode(String.self, forKey: .arrive)
            change = try? c.decodeIfPresent(Change.self, forKey: .change)
            guard stops.count >= 2 else {
                throw DecodingError.dataCorruptedError(forKey: .stops, in: c, debugDescription: "a ride needs two stops")
            }
        }

        func progress(at now: Date) -> Double {
            guard let b = parseISODate(board), let a = parseISODate(arrive) else { return 0 }
            return min(1, max(0, now.timeIntervalSince(b) / max(1, a.timeIntervalSince(b))))
        }

        func passed(at now: Date) -> Int { Int(progress(at: now) * Double(stops.count - 1)) }
    }
    struct Upcoming: Decodable {
        let when: String
        let title: String
        let `where`: String
        let off: String?
    }

    enum CodingKeys: String, CodingKey {
        case label, detail, alt, stop, quality, asOf, mode, dest, places, departsAt, refreshAt, timing, arrivals, arrived, leave, card,
            walkSpeedMs
    }

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
        places = c.lenientList(Place.self, forKey: .places)
        departsAt = try? c.decodeIfPresent(String.self, forKey: .departsAt)
        refreshAt = try? c.decodeIfPresent(String.self, forKey: .refreshAt)
        timing = try? c.decodeIfPresent(Timing.self, forKey: .timing)
        arrivals = c.lenientList(ArrivalLite.self, forKey: .arrivals)
        arrived = (try? c.decodeIfPresent(Bool.self, forKey: .arrived)) ?? false
        leave = try? c.decodeIfPresent(Leave.self, forKey: .leave)
        card = try? c.decodeIfPresent(Card.self, forKey: .card)
        walkSpeedMs = try? c.decodeIfPresent(Double.self, forKey: .walkSpeedMs)
    }
    struct ArrivalLite: Decodable {
        let svc: String
        let crowd: String?
    }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }
    var service: String { label.components(separatedBy: " · ").first ?? label }
    var leaveAt: Date? { leave.flatMap { parseISODate($0.at) } }
    var countdownAt: Date? {
        if card?.phase == "waiting", let board = leave?.board.flatMap(parseISODate) { return board }
        return leaveAt
    }
    var classAt: Date? { timing?.classAt.flatMap(parseISODate) }
    var staleAt: Date? { card?.staleAt.flatMap(parseISODate) }

    var isClassPlan: Bool { card?.kind == "class" }
    func startsAt(_ c: Date) -> String { dest?.place == true ? L("arrive by %@", campusTime(c)) : L("starts %@", campusTime(c)) }
    var isFree: Bool { mode == "free" }
    var tripUnderWay: Bool { ["heading", "waiting", "riding", "missed"].contains(card?.phase ?? "idle") }
    var nextChange: Date? { card?.nextChangeAt.flatMap(parseISODate) }
    func leaveHeadline(now: Date = ServerClock.now) -> String? {
        guard let at = leaveAt else { return nil }
        if card?.phase == "waiting" { return card?.leaveBy }
        return now >= at ? L("Leave now") : card?.leaveBy
    }
    var catchHow: String? { card?.catch }
    var catchArrive: String? { card?.arrive }
    var leaveLate: Bool { card?.late ?? false }
    var goNowLine: String? { card?.goNow }
    var crowdText: String? {
        guard let c = card?.crowd else { return nil }
        return detail.localizedCaseInsensitiveContains(c) ? nil : c
    }
    func leaveText(now: Date = ServerClock.now) -> String? {
        guard let head = leaveHeadline(now: now) else { return nil }
        return card?.leaveVia.map { "\(head) · \($0)" } ?? head
    }

    var hasLiveTime: Bool { departure != nil && quality != "unknown" && quality != "ended" }
}

private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from d: Decoder) throws { value = try? T(from: d) }
}

extension KeyedDecodingContainer {
    func lenientList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        (try? decodeIfPresent([Lossy<T>].self, forKey: key))?.compactMap(\.value)
    }

    func lenientInt(forKey key: Key) -> Int? {
        (try? decodeIfPresent(Double.self, forKey: key))?.flatMap { $0.isFinite ? Int($0.rounded()) : nil }
    }
}

enum ServerClock {
    static let ignoreS: TimeInterval = 3

    private static let lock = NSLock()
    nonisolated(unsafe) private static var offset: TimeInterval = 0

    static var skew: TimeInterval { lock.withLock { offset } }

    static var now: Date { now(local: Date()) }

    static func now(local: Date) -> Date { now(local: local, skew: skew) }

    static func now(local: Date, skew: TimeInterval) -> Date { local.addingTimeInterval(skew) }

    static func skew(server: Date, local: Date) -> TimeInterval {
        let s = server.timeIntervalSince(local)
        return abs(s) < ignoreS ? 0 : s
    }

    static func parseHTTPDate(_ s: String) -> Date? { httpDate.date(from: s) }

    static func skew(from resp: HTTPURLResponse, at local: Date) -> TimeInterval? {
        guard (resp.value(forHTTPHeaderField: "cache-control") ?? "").contains("no-store"),
            let server = resp.value(forHTTPHeaderField: "date").flatMap(parseHTTPDate)
        else { return nil }
        return skew(server: server, local: local)
    }

    static func observe(_ resp: HTTPURLResponse, at local: Date = Date()) {
        guard let s = skew(from: resp, at: local) else { return }
        lock.withLock { offset = s }
    }

    private static let httpDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f
    }()
}

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

func campusTime(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = Lang.locale
    f.timeZone = .campus
    f.setLocalizedDateFormatFromTemplate(usesHour12 ? "hmm" : "HHmm")
    return f.string(from: d).replacingOccurrences(of: #"([上下]午)(\d)"#, with: "$1 $2", options: .regularExpression)
}

extension TimeZone {
    static let campus = TimeZone(identifier: "Asia/Singapore")!
}

enum Clock {
    private static let key = "clock"
    static var pref: String {
        get { UserDefaults.standard.string(forKey: key) ?? "auto" }
        set { UserDefaults.standard.set(["12", "24"].contains(newValue) ? newValue : "auto", forKey: key) }
    }
}

var usesHour12: Bool {
    switch Clock.pref {
    case "12": true
    case "24": false
    default: (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
    }
}

func isNewer(_ latest: String, than current: String) -> Bool {
    func split(_ v: String) -> (String, String?) {
        let p = v.split(separator: "-", maxSplits: 1).map(String.init)
        return (p.first ?? "", p.count > 1 ? p[1] : nil)
    }
    let (an, ap) = split(latest)
    let (bn, bp) = split(current)
    switch an.compare(bn, options: .numeric) {
    case .orderedDescending: return true
    case .orderedAscending: return false
    case .orderedSame:
        guard let bp else { return false }
        guard let ap else { return true }
        return ap.compare(bp, options: .numeric) == .orderedDescending
    }
}

struct BoardRow: Decodable, Hashable {
    let svc: String
    let etaS: Int?
    let quality: String
    var color: String? = nil
    var paid: Bool? = nil
    var later: [Later]? = nil
    var eta: String? = nil
    var towards: [String]? = nil
    var toText: String? = nil
    var dest: String? = nil
    var destPlace: String? = nil

    struct Later: Decodable, Hashable {
        let etaS: Int?
        let quality: String
        var eta: String? = nil
    }
}

struct NearbyStop: Decodable, Identifiable {
    struct Stop: Decodable {
        let code: String
        let name: String
    }
    let stop: Stop
    let walkS: Int
    let available: Bool
    let board: [BoardRow]
    var id: String { stop.code }

    enum CodingKeys: String, CodingKey { case stop, walkS, available, board }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stop = try c.decode(Stop.self, forKey: .stop)
        walkS = c.lenientInt(forKey: .walkS) ?? 0
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? true
        board = c.lenientList(BoardRow.self, forKey: .board) ?? []
    }
}

struct Destination: Decodable, Hashable {
    static func list(_ campus: Data) -> [Destination]? {
        struct R: Decodable { let destinations: [Destination] }
        return (try? JSONDecoder().decode(R.self, from: campus))?.destinations
    }

    let code: String
    let label: String
    let stopCode: String
    let kind: String
    let walkM: Int?
    let aliases: [String]?
    let stops: [String]?
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
        aliases = c.lenientList(String.self, forKey: .aliases)
        stops = c.lenientList(String.self, forKey: .stops)
        detail = try? c.decodeIfPresent(String.self, forKey: .detail)
    }
}

func rankDestinations(_ all: [Destination], _ query: String, max: Int = 8) -> [Destination] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let q = trimmed.lowercased()
    guard !q.isEmpty else { return [] }
    let norm = { (s: String) in s.lowercased().replacingOccurrences(of: #"[\s\-_]+"#, with: "", options: .regularExpression) }
    let nq = norm(q)
    let kinds = ["timetable", "place", "class", "service", "stop", "landmark", "building", "room"]
    func kindRank(_ k: String) -> Int { kinds.firstIndex(of: k) ?? kinds.count }
    func words(_ s: String) -> [Substring] { s.split(whereSeparator: { $0.isWhitespace || "()·,/&-".contains($0) }) }
    func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    func starts(_ a: some StringProtocol, _ p: String) -> Bool { a.utf16.starts(with: p.utf16) }
    func contains(_ a: String, _ p: String) -> Bool { a.range(of: p, options: .literal) != nil }
    func score(_ d: Destination) -> Int {
        let names = [d.code.lowercased(), d.label.lowercased()] + (d.aliases ?? []).map { $0.lowercased() }
        let code: String? = nq.isEmpty ? nil : norm(d.code)
        if names.contains(where: { same($0, q) }) || code.map({ same($0, nq) }) == true { return 0 }
        if names.contains(where: { starts($0, q) }) || code.map({ starts($0, nq) }) == true { return 1 }
        if names.contains(where: { words($0).contains { starts($0, q) } }) { return 2 }
        if names.contains(where: { contains($0, q) }) { return 3 }
        return -1
    }
    return all.enumerated()
        .filter { $0.element.kind != "room" || trimmed.utf16.count >= 2 }
        .map { (i: $0.offset, d: $0.element, s: score($0.element)) }
        .filter { $0.s >= 0 }
        .sorted { a, b in
            if a.s != b.s { return a.s < b.s }
            let ka = kindRank(a.d.kind)
            let kb = kindRank(b.d.kind)
            if ka != kb { return ka < kb }
            let la = a.d.label.utf16.count
            let lb = b.d.label.utf16.count
            if la != lb { return la < lb }
            return a.i < b.i
        }
        .prefix(max)
        .map(\.d)
}

enum Target: Hashable {
    case plan
    case place(key: String)
    case code(String, label: String)
}

struct Campus: Decodable {
    struct Stop: Decodable, Hashable {
        let code: String
        let name: String
        let lat: Double?
        let lon: Double?
    }
    struct Residence: Decodable, Hashable {
        let code: String
        let name: String
        let stops: [String]
        let walkM: Double?
        var walkMin: Int?
        var common: Bool?
    }
    let stops: [Stop]
    let residences: [Residence]

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = try c.decode([Stop].self, forKey: .stops).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        residences = (c.lenientList(Residence.self, forKey: .residences) ?? []).sorted {
            ($0.common == true) != ($1.common == true) ? $0.common == true : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    enum CodingKeys: String, CodingKey { case stops, residences }

    func stopName(_ code: String) -> String { stops.first { $0.code == code }?.name ?? code }

    func nearest(lat: Double, lon: Double) -> Stop? {
        stops.filter { $0.lat != nil && $0.lon != nil }.min { a, b in
            func d(_ s: Stop) -> Double {
                let dLat = s.lat! - lat
                let dLon = (s.lon! - lon) * cos(lat * .pi / 180)
                return dLat * dLat + dLon * dLon
            }
            return d(a) < d(b)
        }
    }
}

struct Unplaced: Hashable {
    let module: String
    let venue: String
    let day: Int
    let arriveByMin: Int
    let endMin: Int?
    let offCampus: Bool
}

struct ImportResult {
    let profile: [String: Any]
    let classes: Int
    let unplaced: [Unplaced]
    let missing: [String]
    let term: String

    init(_ o: [String: Any]) {
        profile = o["profile"] as? [String: Any] ?? [:]
        classes = (profile["trips"] as? [Any])?.count ?? 0
        unplaced = (o["unresolved"] as? [[String: Any]] ?? []).map {
            Unplaced(
                module: $0["module"] as? String ?? "", venue: $0["venue"] as? String ?? "", day: $0["day"] as? Int ?? 1,
                arriveByMin: $0["arriveByMin"] as? Int ?? 0, endMin: $0["endMin"] as? Int, offCampus: $0["offCampus"] as? Bool ?? false)
        }
        missing = o["missing"] as? [String] ?? []
        term = o["term"] as? String ?? ""
    }

    var summary: String {
        classes == 1 ? L("Imported 1 class for %@.", term) : L("Imported %@ classes for %@.", "\(classes)", term)
    }

    var missingText: String? {
        missing.isEmpty ? nil : L("NUSMods has no classes this semester for %@.", missing.joined(separator: ", "))
    }
}

struct Me: Decodable {
    let email: String?
    let anonymous: Bool?
    let needsReimport: Bool?
    let term: String?
}

struct TripChoice: Decodable, Hashable {
    let trip: String
    let pref: String
    let label: String?
}

struct Choices: Decodable {
    let choices: [TripChoice]
    let history: Int
}

struct Device: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let platform: String?
    var watch: Bool? = nil
    let lastSeen: Double?
    let current: Bool?
}

struct DayPlan: Decodable {
    struct Item: Decodable, Identifiable {
        struct Leave: Decodable {
            let at: String
            let estimated: Bool?
            let svc: String?
            let stop: String?
        }
        struct Timing: Decodable {
            let status: String?
            let text: String?
        }
        struct OnBus: Decodable {
            let svc: String
            let off: String?
            let arrive: String?
        }
        let kind: String
        let key: String
        let label: String
        let serverTitle: String?
        let line: String?
        let status: String
        let fromName: String?
        let startsAt: String
        let endsAt: String?
        let leave: Leave?
        let timing: Timing?
        let onBus: OnBus?
        let removable: Bool?
        var id: String { key }

        enum CodingKeys: String, CodingKey {
            case kind, key, label, line, status, fromName, startsAt, endsAt, leave, timing, onBus, removable
            case serverTitle = "title"
        }

        var sub: String? {
            if let line { return line }
            if serverTitle != nil || status == "done" { return nil }
            if status == "skipped" { return L("Not going") }
            if let b = onBus {
                return
                    ([
                        L("On the %@", b.svc), b.off.map { L("off at %@", $0) },
                        b.arrive.flatMap(parseISODate).map { L("arrive %@", campusTime($0)) },
                    ] as [String?]).compactMap { $0 }.joined(separator: " · ")
            }
            guard let l = leave, let at = parseISODate(l.at) else { return nil }
            let how = l.svc.map { L("%@ from %@", $0, l.stop ?? fromName ?? "") } ?? L("walk")
            return
                ([
                    L("Leave by %@", l.estimated == true ? L("~%@", campusTime(at)) : campusTime(at)), how,
                    timing?.status == "late" ? timing?.text : nil,
                ] as [String?]).compactMap { $0 }.joined(separator: " · ")
        }
        var title: String {
            serverTitle ?? (kind == "home" ? (fromName.map { L("Home, from %@", $0) } ?? L("Home after your last class")) : label)
        }
    }
    var items: [Item]
    let note: String?
    let date: String?

    enum CodingKeys: String, CodingKey { case items, note, date }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        items = c.lenientList(Item.self, forKey: .items) ?? []
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
    }
}

struct CardAction: Decodable, Hashable {
    let id: String
    let label: String
    let trip: String
}

struct StepTarget: Decodable, Hashable {
    let svc: String
    let stop: String
    let board: String
}

enum StepDirection: String {
    case earlier, later
}

struct Suggestion: Decodable, Hashable {
    let id: String
    let text: String
    let accept: String
    let dismiss: String
}

struct SignInRequest: Decodable, Equatable {
    let request: String
    let poll: String
    let match: Int
}

struct SignInPoll: Decodable {
    let status: String
    let token: String?
    let email: String?
    let outcome: String?
}

enum Quiet {
    enum Scope { case signIn, app }

    static let maxS: TimeInterval = 300

    private static let lock = NSLock()
    nonisolated(unsafe) private static var untilDates: [Scope: Date] = [:]
    nonisolated(unsafe) private static var laterDate = Date.distantPast

    static func scope(_ path: String) -> Scope {
        path == "/api/pair" || path == "/api/me/pair-code" || path.hasPrefix("/api/auth/") ? .signIn : .app
    }

    static func until(_ scope: Scope) -> Date { lock.withLock { untilDates[scope] ?? .distantPast } }

    static func after(_ retryAfter: String?, scope: Scope, now: Date = Date()) {
        let s = retryAfterS(retryAfter, now: now) ?? 60
        lock.withLock { untilDates[scope] = now.addingTimeInterval(cap(s)) }
    }

    static func later(_ retryAfter: String?, now: Date = Date()) {
        guard let s = retryAfterS(retryAfter, now: now) else { return }
        lock.withLock { laterDate = now.addingTimeInterval(cap(s)) }
    }

    static func wait(now: Date = Date()) -> TimeInterval {
        max(until(.app).timeIntervalSince(now), lock.withLock { laterDate }.timeIntervalSince(now), 0)
    }

    static func cap(_ s: TimeInterval) -> TimeInterval { min(max(s, 1), maxS) }
}

func retryAfterS(_ header: String?, now: Date = Date()) -> TimeInterval? {
    guard let h = header?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return nil }
    if let s = Double(h) { return s > 0 ? s : nil }
    return ServerClock.parseHTTPDate(h).map { $0.timeIntervalSince(now) }.flatMap { $0 > 0 ? $0 : nil }
}

enum Outdated {
    static let holdS: TimeInterval = 30 * 60

    private static let lock = NSLock()
    nonisolated(unsafe) private static var untilDate = Date.distantPast

    static var active: Bool { lock.withLock { Date() < untilDate } }

    static func mark() { lock.withLock { untilDate = Date().addingTimeInterval(holdS) } }

    static func gated(_ method: String, _ path: String) -> Bool {
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if method == "DELETE" && (p == "/api/me" || p == "/api/me/push") { return false }
        return p == "/api/me" || p.hasPrefix("/api/me/") || answers.contains(p)
    }

    private static let answers: Set<String> = [
        "/api/next", "/api/trip", "/api/arrivals", "/api/buses", "/api/line", "/api/campus", "/api/stops/pairs",
    ]
}

struct ApiError: LocalizedError {
    let status: Int
    let message: String
    var retryAfter: TimeInterval? = nil
    var state: String? = nil
    var errorDescription: String? { message }
    var updateRequired: Bool { status == 426 }
}

func failureMessage(_ error: Error, otherwise: String = L("Couldn't reach terminus. Check your connection and try again.")) -> String {
    if let e = error as? ApiError { return e.message }
    if error is DecodingError { return L("terminus sent something this version can't read.") }
    return otherwise
}

func sentence(_ text: String) -> String {
    guard let first = text.first else { return text }
    let s = first.uppercased() + text.dropFirst()
    if ".!?。！？".contains(s.last!) { return s }
    return s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? s + "。" : s + "."
}

enum Servers {
    static let defaultBase = Bundle.main.object(forInfoDictionaryKey: "TerminusAPI") as? String ?? "https://terminus.run"
    static let backupBase = Bundle.main.object(forInfoDictionaryKey: "TerminusBackup") as? String
    static let stub = "http://localhost:8787"
    private static let key = "server"
    private static let menuKey = "developerMenu"

    static func all(default base: String, backup: String?, debug: Bool) -> [String] {
        var out: [String] = []
        for s in [base] + (backup.map { [$0] } ?? []) + (debug ? [stub] : []) where !out.contains(s) { out.append(s) }
        return out
    }

    static func backup(of base: String, in all: [String]) -> String? {
        isLocal(base) ? nil : all.first { $0 != base && !isLocal($0) }
    }

    static func order(_ base: String, in all: [String], detour: String?) -> [String] {
        guard let other = backup(of: base, in: all) else { return [base] }
        return detour == other ? [other, base] : [base, other]
    }

    static func unreached(_ error: Error, method: String) -> Bool {
        guard let e = error as? URLError else { return false }
        switch e.code {
        case .cannotFindHost, .dnsLookupFailed, .cannotConnectToHost, .secureConnectionFailed: return true
        case .networkConnectionLost: return method == "GET"
        default: return false
        }
    }

    static let detourS: TimeInterval = 600
    private static let lock = NSLock()
    nonisolated(unsafe) private static var detour: (base: String, until: Date)?

    static func tries(_ base: String, now: Date = Date()) -> [String] {
        let d = lock.withLock { detour }
        return order(base, in: choices, detour: d.flatMap { now < $0.until ? $0.base : nil })
    }

    static func answered(_ at: String, base: String, now: Date = Date()) {
        lock.withLock {
            if at == base {
                detour = nil
            } else if let d = detour, d.base == at, now < d.until {
            } else {
                detour = (at, now.addingTimeInterval(detourS))
            }
        }
    }

    static func first<T>(
        _ tries: [String], method: String, _ attempt: (String) async throws -> T
    ) async throws -> (at: String, result: T) {
        for (i, base) in tries.enumerated() {
            do { return (base, try await attempt(base)) } catch {
                if i == tries.count - 1 || !unreached(error, method: method) { throw error }
            }
        }
        throw URLError(.cannotConnectToHost)
    }

    static func reach<T>(method: String, _ attempt: (String) async throws -> T) async throws -> T {
        let (at, result) = try await first(tries(Api.base), method: method, attempt)
        answered(at, base: Api.base)
        return result
    }

    static func pick(_ saved: String?, from all: [String]) -> String {
        if let saved, all.contains(saved) { return saved }
        return all[0]
    }

    static func isLocal(_ base: String) -> Bool {
        guard let u = URL(string: base), u.scheme == "http", let host = u.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1"
    }

    static func menuAlways(debug: Bool, beta: Bool) -> Bool { debug || beta }
    static let unlockClicks = 7

    static var isDebug: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    static var choices: [String] { all(default: defaultBase, backup: backupBase, debug: isDebug) }
    static var current: String { pick(UserDefaults.standard.string(forKey: key), from: choices) }
    static var menuShown: Bool { menuAlways(debug: isDebug, beta: Api.isBeta) || UserDefaults.standard.bool(forKey: menuKey) }
    static func unlockMenu() { UserDefaults.standard.set(true, forKey: menuKey) }

    @MainActor static func choose(_ base: String, failed: @escaping @MainActor () -> Void = {}) {
        guard choices.contains(base), base != Api.base else { return }
        UserDefaults.standard.set(base, forKey: key)
        let app = Bundle.main.bundleURL
        guard app.pathExtension == "app" else {
            NSApp.terminate(nil)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        let running = Api.base
        NSWorkspace.shared.openApplication(at: app, configuration: config) { launched, error in
            let started = launched != nil && error == nil
            DispatchQueue.main.async {
                if started {
                    NSApp.terminate(nil)
                    return
                }
                UserDefaults.standard.set(running, forKey: key)
                failed()
            }
        }
    }
}

struct Api {
    static let stableSite = "https://terminus.run"
    static let site = Bundle.main.object(forInfoDictionaryKey: "TerminusSite") as? String ?? stableSite
    static var siteHost: String { site.replacingOccurrences(of: "https://", with: "") }
    static let linkBase = site
    static var isBeta: Bool { site != stableSite }
    static let base = devOverride("TERMINUS_API_BASE") ?? Servers.current

    static func devOverride(_ name: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        #if DEBUG
            return value
        #else
            guard let host = URL(string: value)?.host?.lowercased(), host == "localhost" || host == "127.0.0.1" else { return nil }
            return value
        #endif
    }

    let token: String?

    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String

    static let client = "mac/\(version ?? "dev")"

    func pair(code: String, name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/pair", body: ["code": code, "name": name])
        return r.token
    }

    func signInStart(email: String, name: String) async throws -> SignInRequest {
        try await request("POST", "/api/auth/app/start", body: ["email": email, "name": name])
    }

    func signInPoll(_ r: SignInRequest) async throws -> SignInPoll {
        try await request("POST", "/api/auth/app/poll", body: ["request": r.request, "poll": r.poll])
    }

    func signInCode(_ r: SignInRequest, code: String) async throws -> SignInPoll {
        try await request("POST", "/api/auth/app/code", body: ["request": r.request, "poll": r.poll, "code": code])
    }

    func next(_ target: Target, lat: Double?, lon: Double?, acc: Double? = nil) async throws -> NextAnswer {
        var q = Self.coords(lat, lon, acc)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        return try await answer("GET", "/api/me/next", query: q + Self.h12)
    }

    func signal(_ action: CardAction) async throws -> NextAnswer {
        let body: [String: Any] = ["kind": action.id, "trip": action.trip]
        return try await answer("POST", "/api/me/signal", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body))
    }

    func step(trip: String, to: StepTarget?, dir: StepDirection?) async throws -> NextAnswer {
        var body: [String: Any] = ["trip": trip, "to": to.map { ["svc": $0.svc, "stop": $0.stop, "board": $0.board] } ?? NSNull()]
        if let dir { body["dir"] = dir.rawValue }
        return try await answer("POST", "/api/me/step", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body))
    }

    func choice(id: String, accept: Bool) async throws {
        let body: [String: Any] = ["id": id, "choice": accept ? "accept" : "dismiss"]
        _ = try await send("POST", "/api/me/choice", json: try JSONSerialization.data(withJSONObject: body))
    }

    func report(reason: String?, note: String, answer: Data?) async throws {
        try await feedback(
            kind: "wrong", note: note, reason: reason, context: answer.flatMap { try? JSONSerialization.jsonObject(with: $0) })
    }

    func profile() async throws -> Data {
        try await send("GET", "/api/me/profile")
    }

    func changeProfile(_ change: @Sendable (inout [String: Any]) -> Void) async throws -> [String: Any] {
        try await Self.changeProfile(
            read: { try await sendTagged("GET", "/api/me/profile") },
            save: { body, tag in try await send("PUT", "/api/me/profile", json: body, ifMatch: tag) },
            change: change)
    }

    static func changeProfile(
        read: () async throws -> (Data, String?), save: (Data, String?) async throws -> Data,
        change: (inout [String: Any]) -> Void
    ) async throws -> [String: Any] {
        var attempt = 0
        while true {
            attempt += 1
            let (data, tag) = try await read()
            var p = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            change(&p)
            do {
                let saved = try await save(JSONSerialization.data(withJSONObject: p), tag)
                return try JSONSerialization.jsonObject(with: saved) as? [String: Any] ?? [:]
            } catch let e as ApiError where e.status == 412 && attempt < 3 {
                continue
            }
        }
    }

    func importTimetable(_ share: String) async throws -> Data {
        try await send("POST", "/api/me/import", json: JSONSerialization.data(withJSONObject: ["share": share]))
    }

    func campusJSON(etag: String? = nil) async throws -> (Data, String?)? {
        do {
            return try await sendTagged("GET", "/api/campus", ifNoneMatch: etag)
        } catch let e as ApiError where e.status == 304 {
            return nil
        }
    }

    func pairCode() async throws -> String {
        struct R: Decodable { let code: String }
        return try JSONDecoder().decode(R.self, from: await send("POST", "/api/me/pair-code", json: Data("{}".utf8))).code
    }

    func devices() async throws -> [Device] {
        struct R: Decodable { let devices: [Device] }
        return try JSONDecoder().decode(R.self, from: await send("GET", "/api/me/devices")).devices
    }

    func removeDevice(_ id: String) async throws {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await send("DELETE", "/api/me/devices/\(safe)")
    }

    func day(lat: Double? = nil, lon: Double? = nil, acc: Double? = nil) async throws -> DayPlan {
        try JSONDecoder().decode(DayPlan.self, from: try await send("GET", "/api/me/day", query: Self.coords(lat, lon, acc) + Self.h12))
    }

    func nearby(lat: Double?, lon: Double?, acc: Double? = nil) async throws -> [NearbyStop] {
        struct R: Decodable { let stops: [NearbyStop] }
        let r: R = try await request("GET", "/api/me/nearby", query: Self.coords(lat, lon, acc))
        return r.stops
    }

    func anon(name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/auth/anon", body: ["name": name, "platform": "mac"])
        return r.token
    }

    func merge(anon: String, keepDevice: Bool) async throws {
        _ = try await send(
            "POST", "/api/auth/app/merge",
            json: JSONSerialization.data(withJSONObject: ["anon": anon, "keep": keepDevice ? "device" : "account"]))
    }

    func me() async throws -> Me {
        try JSONDecoder().decode(Me.self, from: await send("GET", "/api/me"))
    }

    func once(_ target: Target, atMin: Int, lat: Double? = nil, lon: Double? = nil, acc: Double? = nil) async throws -> NextAnswer {
        var body: [String: Any] = ["atMin": atMin]
        switch target {
        case .plan: break
        case .place(let key): body["place"] = key
        case .code(let code, let label):
            body["to"] = code
            body["label"] = label
        }
        return try await answer(
            "POST", "/api/me/once", query: Self.coords(lat, lon, acc) + Self.h12, json: try JSONSerialization.data(withJSONObject: body))
    }

    func feedback(note: String) async throws {
        try await feedback(kind: "other", note: note)
    }

    private func feedback(kind: String, note: String, reason: String? = nil, context: Any? = nil, extra: [String: String] = [:])
        async throws
    {
        var body: [String: Any] = ["kind": kind, "note": note, "platform": "mac"]
        body.merge(extra) { a, _ in a }
        if let reason { body["reason"] = reason }
        if let v = Api.version { body["appVersion"] = v }
        if let context { body["context"] = context }
        _ = try await send("POST", "/api/me/feedback", json: try JSONSerialization.data(withJSONObject: body))
    }

    func export() async throws -> Data {
        try await send("GET", "/api/me/export")
    }

    func choices() async throws -> Choices {
        try JSONDecoder().decode(Choices.self, from: await send("GET", "/api/me/choices"))
    }

    func undoChoice(trip: String, pref: String) async throws {
        _ = try await send(
            "POST", "/api/me/choice", json: JSONSerialization.data(withJSONObject: ["choice": "undo", "trip": trip, "pref": pref]))
    }

    func clearHistory() async throws {
        _ = try await send("DELETE", "/api/me/history")
    }

    func deleteAccount() async throws {
        _ = try await send("DELETE", "/api/me")
    }

    func latestVersion() async throws -> String {
        struct R: Decodable { let version: String }
        let r: R = try await request("GET", "/download/latest.json")
        return r.version
    }

    func logout() async throws {
        struct R: Decodable {}
        let _: R = try await request("POST", "/api/auth/logout", body: [:])
    }

    static func coords(_ lat: Double?, _ lon: Double?, _ acc: Double? = nil) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        var q = [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
        if let acc { q.append(URLQueryItem(name: "acc", value: String(Int(acc.rounded())))) }
        return q
    }

    private static var h12: [URLQueryItem] { usesHour12 ? [URLQueryItem(name: "h12", value: "1")] : [] }

    private func answer(_ method: String, _ path: String, query: [URLQueryItem], json: Data? = nil) async throws -> NextAnswer {
        let data = try await send(method, path, query: query, json: json)
        var answer = try JSONDecoder().decode(NextAnswer.self, from: data)
        answer.raw = data
        return answer
    }

    private func request<T: Decodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil
    ) async throws -> T {
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        return try JSONDecoder().decode(T.self, from: try await send(method, path, query: query, json: json))
    }

    private func send(_ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil, ifMatch: String? = nil)
        async throws -> Data
    {
        try await sendTagged(method, path, query: query, json: json, ifMatch: ifMatch).0
    }

    private func sendTagged(
        _ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil, ifMatch: String? = nil, ifNoneMatch: String? = nil
    ) async throws -> (Data, String?) {
        let scope = Quiet.scope(path)
        if token != nil, Outdated.gated(method, path), Outdated.active {
            throw ApiError(status: 426, message: L("Update terminus to keep using it."))
        }
        let quietUntil = Quiet.until(scope)
        if Date() < quietUntil {
            throw ApiError(status: 429, message: L("terminus is busy. Try again in a minute."), retryAfter: quietUntil.timeIntervalSinceNow)
        }
        func urlRequest(_ base: String) -> URLRequest {
            var comps = URLComponents(string: base + path)!
            if !query.isEmpty { comps.queryItems = query }
            var req = URLRequest(url: comps.url!, timeoutInterval: 10)
            req.httpMethod = method
            req.setValue("application/json", forHTTPHeaderField: "accept")
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            if let ifMatch { req.setValue(ifMatch, forHTTPHeaderField: "if-match") }
            if let ifNoneMatch { req.setValue(ifNoneMatch, forHTTPHeaderField: "if-none-match") }
            if let json {
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = json
            }
            return req
        }
        let started = Date()
        func logged(_ status: Int?, _ error: Error?) {
            RequestLog.record(
                method, path, base: Api.base, status: status, tookMs: Int(Date().timeIntervalSince(started) * 1000), failure: error)
        }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await Servers.reach(method: method) { try await URLSession.shared.data(for: urlRequest($0)) }
        } catch {
            logged(nil, error)
            throw error
        }
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        logged(http?.statusCode, nil)
        if let http { ServerClock.observe(http) }
        let retryAfter = http?.value(forHTTPHeaderField: "retry-after")
        if status == 429 { Quiet.after(retryAfter, scope: scope) }
        if status == 503 { Quiet.later(retryAfter) }
        if status == 426 { Outdated.mark() }
        guard (200..<300).contains(status) else {
            let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = o?["error"] as? String
            throw ApiError(
                status: status,
                message: status == 426
                    ? L("Update terminus to keep using it.") : msg.map(sentence) ?? L("Couldn't reach terminus. Try again in a moment."),
                retryAfter: retryAfterS(retryAfter),
                state: o?["status"] as? String
            )
        }
        return (data, http?.value(forHTTPHeaderField: "etag"))
    }
}
