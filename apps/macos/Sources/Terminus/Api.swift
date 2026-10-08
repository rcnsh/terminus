import AppKit
import Foundation

struct Place: Decodable, Hashable {
    let key: String
    let label: String
}

/// `/me/next`. label and detail are display-ready; show them verbatim.
struct NextAnswer: Decodable {
    struct Stop: Decodable { let code: String; let name: String }
    struct Dest: Decodable { let to: String?; let label: String; let why: String }

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
    /// Display-ready text and the stale time, worded on the server (card.ts).
    let card: Card?
    /// The user's walking speed (m/s, from their pace), for walk times worked out here (search).
    let walkSpeedMs: Double?
    /// The response as it came, sent with an "Is this wrong?" report. Never in the JSON.
    var raw: Data? = nil

    struct Timing: Decodable { let status: String?; let text: String?; let classAt: String?; let reachAt: String? }
    struct Leave: Decodable { let at: String; let estimated: Bool?; let svc: String?; let stop: String?; let board: String?; let arrive: String?; let note: String? }
    /// Every field but `kind` is optional and read on its own: one field this
    /// version can't read is left out (nil, or gone from its list), never the
    /// whole card with it.
    struct Card: Decodable {
        /// class, trip, nearby, rest, arrived, setup or free; "trip" for one
        /// missing or this version doesn't know.
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
        /// v2: where the trip is (idle, due, heading, waiting, riding, missed, arrived).
        let phase: String?
        /// "On your way", above the answer. Nil when idle.
        let phaseText: String?
        /// 12 characters, for the menu bar.
        let glance: String?
        let line: String?
        /// Buttons the server decided to show; a click sends one to /me/signal.
        let actions: [CardAction]?
        /// "Last D2 from UTown in 18 min".
        let warning: String?
        let nextChangeAt: String?
        /// False when reminders are off for this class.
        let remind: Bool?
        /// "Leave one bus earlier for CS2030?", accepted or turned down with /me/choice.
        let suggestion: Suggestion?
        /// "NUS's live bus times have been down since 9:14 AM", above the answer.
        let notice: String?
        /// The next class, on a free day, after your day and at home.
        let upcoming: Upcoming?
        /// The headline: "R2 · 09:06", "A1 · ~09:11", or the label when there's no time.
        let title: String?
        /// "Next class · GEA1000 @ UTown", "Heading home"; nil with nowhere to go.
        let heading: String?
        /// When the leave reminder goes; nil: no reminder for this trip.
        let remindAt: String?
        /// The trip as steps, worded on the server.
        let journey: Journey?
        /// On the bus: the stops from boarding to getting off.
        let ride: Ride?
        /// The planned bus has left and nothing says whether you're on it:
        /// `line` says so and gives the next way there. Never "Leave now".
        let gone: Bool

        static let kinds: Set = ["class", "trip", "nearby", "rest", "arrived", "setup", "free"]

        enum CodingKeys: String, CodingKey {
            case kind, staleAt, crowd, quality, leaveBy, leaveVia, `catch`, arrive, late, goNow, note, estimate, phase, phaseText, glance, line, actions, warning, nextChangeAt, remind, suggestion, notice, upcoming
            case title, heading, remindAt, journey, ride, gone
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
        }
    }

    /// The trip as steps, every line worded on the server: "To GEA1000 @ UTown · starts 10:00",
    /// "5 min walk", "10 min ride · off at Opp NUSS", "Arrive ~09:51 · 9 min early".
    /// Each line on its own: one this version can't read is left out.
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
        /// The bus to catch, for its service and colour beside the ride.
        let bus: Bus?
        struct Bus: Decodable { let svc: String; let color: String? }
        /// A change of bus on the way: `bus` is the first, this the second.
        /// One this version can't read leaves `rideText`, which names the change.
        let change: Change?
        /// "14 min ride · off at Kent Vale", "Change at Kent Vale · 5 min wait",
        /// "14 min ride": the first bus's line, the change, the second bus's line.
        struct Change: Decodable {
            let bus: Bus
            let firstRideText: String
            let changeText: String
            let rideText: String
        }

        enum CodingKeys: String, CodingKey { case title, byText, walkText, rideText, walkEndText, arriveText, arriveWhere, backupText, summary, bus, change }

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

    /// The ride: its stops from boarding to getting off, and when each end is.
    /// Where the bus is comes from the clock, the stops taken as evenly spaced
    /// between the two times, as the phone and the web show it.
    struct Ride: Decodable {
        struct Stop: Decodable, Hashable { let code: String?; let name: String }
        let svc: String
        let stops: [Stop]
        let board: String
        let arrive: String
        /// The bus you change to where this one drops you ("Then P at 09:42
        /// from Kent Vale"); `stops` are this bus's alone.
        let change: Change?
        struct Change: Decodable { let svc: String; let text: String }

        enum CodingKeys: String, CodingKey { case svc, stops, board, arrive, change }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            svc = try c.decode(String.self, forKey: .svc)
            stops = c.lenientList(Stop.self, forKey: .stops) ?? []
            board = try c.decode(String.self, forKey: .board)
            arrive = try c.decode(String.self, forKey: .arrive)
            change = try? c.decodeIfPresent(Change.self, forKey: .change)
            // Fewer than two stops: there's no ride to draw.
            guard stops.count >= 2 else { throw DecodingError.dataCorruptedError(forKey: .stops, in: c, debugDescription: "a ride needs two stops") }
        }

        /// 0 to 1 along the ride at `now` (the server's clock).
        func progress(at now: Date) -> Double {
            guard let b = parseISODate(board), let a = parseISODate(arrive) else { return 0 }
            return min(1, max(0, now.timeIntervalSince(b) / max(1, a.timeIntervalSince(b))))
        }

        /// How many stops have been passed at `now`; the last is where you get off.
        func passed(at now: Date) -> Int { Int(progress(at: now) * Double(stops.count - 1)) }
    }
    /// Worded on the server: "Tomorrow · Fri", "CS2030 at 10:00", "At COM1 · get off at COM 3",
    /// and why today has none on a break ("Recess week").
    struct Upcoming: Decodable { let when: String; let title: String; let `where`: String; let off: String? }

    enum CodingKeys: String, CodingKey { case label, detail, alt, stop, quality, asOf, mode, dest, places, departsAt, refreshAt, timing, arrivals, arrived, leave, card, walkSpeedMs }

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
        walkSpeedMs = (try? c.decodeIfPresent(Double.self, forKey: .walkSpeedMs)).flatMap { $0 }
    }
    struct ArrivalLite: Decodable { let svc: String; let crowd: String? }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }
    /// The service, for an older server's answer without a card (the menu bar's fallback).
    var service: String { label.components(separatedBy: " · ").first ?? label }
    var leaveAt: Date? { leave.flatMap { parseISODate($0.at) } }
    /// What the header counts down to: the leave-by, or at the stop (phase
    /// `waiting`, where the headline names the bus) the bus's own time.
    var countdownAt: Date? {
        if card?.phase == "waiting", let board = leave?.board.flatMap(parseISODate) { return board }
        return leaveAt
    }
    var classAt: Date? { timing?.classAt.flatMap(parseISODate) }
    /// Dim from this instant (the bus has gone, the plan moved on, or it's old).
    var staleAt: Date? { card?.staleAt.flatMap(parseISODate) }

    // Every line below is worded on the server (card.ts), once for all clients.
    var isClassPlan: Bool { card?.kind == "class" }
    /// No classes today (or none left): nothing to catch.
    var isFree: Bool { mode == "free" }
    /// A trip under way: its phase is what the menu bar says.
    var tripUnderWay: Bool { ["heading", "waiting", "riding", "missed"].contains(card?.phase ?? "idle") }
    var nextChange: Date? { card?.nextChangeAt.flatMap(parseISODate) }
    /// "Leave by ~09:38", or "Leave now" once it has passed: the only part that ticks.
    /// At the stop it's the bus to wait for ("D2 at 09:41"), as the server says it.
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
    /// Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP".
    func leaveText(now: Date = ServerClock.now) -> String? {
        guard let head = leaveHeadline(now: now) else { return nil }
        return card?.leaveVia.map { "\(head) · \($0)" } ?? head
    }

    var hasLiveTime: Bool { departure != nil && quality != "unknown" && quality != "ended" }
}

/// One element of a list that may not decode: nil instead of failing the list.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from d: Decoder) throws { value = try? T(from: d) }
}

extension KeyedDecodingContainer {
    /// A list with the elements this version can't read left out; nil when
    /// it's missing or isn't a list at all.
    func lenientList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        (try? decodeIfPresent([Lossy<T>].self, forKey: key))?.compactMap(\.value)
    }

    /// A whole number that may come as 95.5: rounded, or nil when it's missing or not a number.
    func lenientInt(forKey key: Key) -> Int? {
        (try? decodeIfPresent(Double.self, forKey: key))?.flatMap { $0.isFinite ? Int($0.rounded()) : nil }
    }
}

/// The server's clock, as near as this Mac can tell. Times in answers
/// (departures, leave-bys, staleAt) are the server's; a Mac clock a minute
/// out would count them down a minute out. The error is learned from the
/// HTTP `Date` header of uncached API responses.
enum ServerClock {
    /// `Date` has one-second resolution, and the answer takes a moment to
    /// arrive: anything under this is noise, not a wrong clock.
    static let ignoreS: TimeInterval = 3

    private static let lock = NSLock()
    nonisolated(unsafe) private static var offset: TimeInterval = 0

    /// Seconds to add to this Mac's clock to get the server's.
    static var skew: TimeInterval { lock.withLock { offset } }

    /// Now, on the server's clock: use it wherever a server time is compared with now.
    static var now: Date { now(local: Date()) }

    static func now(local: Date) -> Date { now(local: local, skew: skew) }

    static func now(local: Date, skew: TimeInterval) -> Date { local.addingTimeInterval(skew) }

    /// The server's `Date` minus this Mac's at the response; 0 when it's within `ignoreS`.
    static func skew(server: Date, local: Date) -> TimeInterval {
        let s = server.timeIntervalSince(local)
        return abs(s) < ignoreS ? 0 : s
    }

    /// "Wed, 07 Oct 2026 01:14:02 GMT" (RFC 9110's IMF-fixdate).
    static func parseHTTPDate(_ s: String) -> Date? { httpDate.date(from: s) }

    /// The skew a response says, if it came from the server just now: a
    /// cached one (anything but `no-store`) carries the time it was first sent.
    static func skew(from resp: HTTPURLResponse, at local: Date) -> TimeInterval? {
        guard (resp.value(forHTTPHeaderField: "cache-control") ?? "").contains("no-store"),
              let server = resp.value(forHTTPHeaderField: "date").flatMap(parseHTTPDate) else { return nil }
        return skew(server: server, local: local)
    }

    /// Learns the skew from a response read at `local`.
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
/// In the account's 12- or 24-hour style ([usesHour12]), as the server writes the card.
func campusTime(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = Lang.locale
    f.timeZone = .campus
    f.setLocalizedDateFormatFromTemplate(usesHour12 ? "hmm" : "HHmm")
    // "下午 6:36", with the space the server's Chinese has.
    return f.string(from: d).replacingOccurrences(of: #"([上下]午)(\d)"#, with: "$1 $2", options: .regularExpression)
}

extension TimeZone {
    /// Singapore's, where the campus is: times are shown in it whatever zone this Mac is set to.
    static let campus = TimeZone(identifier: "Asia/Singapore")!
}

/// The account's 12- or 24-hour choice (its profile's `clock`): "auto"
/// follows this Mac. Kept here so the menu bar has it before the profile loads.
enum Clock {
    private static let key = "clock"
    static var pref: String {
        get { UserDefaults.standard.string(forKey: key) ?? "auto" }
        set { UserDefaults.standard.set(["12", "24"].contains(newValue) ? newValue : "auto", forKey: key) }
    }
}

/// Whether to show 12-hour times: the account's choice, else this Mac's
/// (the "j" skeleton picks up an "a").
var usesHour12: Bool {
    switch Clock.pref {
    case "12": true
    case "24": false
    default: (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
    }
}

/// "1.0.10" > "1.0.9", and a release is newer than its own pre-release:
/// "2.0.0" > "2.0.0-beta.2" > "2.0.0-beta" > "1.3.10".
func isNewer(_ latest: String, than current: String) -> Bool {
    func split(_ v: String) -> (String, String?) {
        // A blank version (a bad latest.json) splits into nothing.
        let p = v.split(separator: "-", maxSplits: 1).map(String.init)
        return (p.first ?? "", p.count > 1 ? p[1] : nil)
    }
    let (an, ap) = split(latest), (bn, bp) = split(current)
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
    /// The service's colour ("#8e44c9"), as on the buses: /me/nearby sends it.
    var color: String? = nil
    /// A public bus, with a fare (absent for a shuttle).
    var paid: Bool? = nil
    /// The buses after this one (/me/nearby), soonest first.
    var later: [Later]? = nil
    /// "4 min", "now", "~6 min", worded on the server; nil from an older one (or with no time).
    var eta: String? = nil

    struct Later: Decodable, Hashable {
        let etaS: Int?
        let quality: String
        var eta: String? = nil
    }
}

struct NearbyStop: Decodable, Identifiable {
    struct Stop: Decodable { let code: String; let name: String }
    let stop: Stop
    let walkS: Int
    let available: Bool
    let board: [BoardRow]
    var id: String { stop.code }

    enum CodingKeys: String, CodingKey { case stop, walkS, available, board }

    /// Only the stop is required: a walk time sent as 95.5, or a row of the
    /// board this version can't read, must not lose the whole list.
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stop = try c.decode(Stop.self, forKey: .stop)
        walkS = c.lenientInt(forKey: .walkS) ?? 0
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? true
        board = c.lenientList(BoardRow.self, forKey: .board) ?? []
    }
}

struct Destination: Decodable, Hashable {
    let code: String
    let label: String
    let stopCode: String
    let kind: String
    /// Metres on foot from the stop; nil for a stop.
    let walkM: Int?
    /// Other names people search for, lower case ("soc", "mrt").
    let aliases: [String]?
    /// A landmark's every stop; the router takes the quicker.
    let stops: [String]?
    /// What a landmark is ("Food court").
    let detail: String?

    /// Where a favourite or a class added here goes: a landmark (a food
    /// court) itself, anything else its stop.
    var goesTo: String { kind == "landmark" ? code : stopCode }

    enum CodingKeys: String, CodingKey { case code, label, stopCode, kind, walkM, aliases, stops, detail }

    /// The four names are required; the rest are read on their own, so one
    /// odd field (a fractional walkM) doesn't drop the place.
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

/// The destination search, with the rules and cases every client is held to
/// (apps/api/test/fixtures/search.json; the web's account/search.js is the
/// reference): exact, then starts with, then a word starts with, then
/// contains; then by kind, then the shorter label, then the list's own order.
/// Rooms only once two characters say which.
func rankDestinations(_ all: [Destination], _ query: String, max: Int = 8) -> [Destination] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    let q = trimmed.lowercased()
    guard !q.isEmpty else { return [] }
    /// A code as typed any way: lower case, without whitespace, hyphens or underscores.
    let norm = { (s: String) in s.lowercased().replacingOccurrences(of: #"[\s\-_]+"#, with: "", options: .regularExpression) }
    let nq = norm(q)
    let kinds = ["timetable", "place", "class", "service", "stop", "landmark", "building", "room"]
    func kindRank(_ k: String) -> Int { kinds.firstIndex(of: k) ?? kinds.count }
    func words(_ s: String) -> [Substring] { s.split(whereSeparator: { $0.isWhitespace || "()·,/&-".contains($0) }) }
    // Plain comparisons, as JavaScript makes them: by UTF-16 code units, not Unicode equivalence.
    func same(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    func starts(_ a: some StringProtocol, _ p: String) -> Bool { a.utf16.starts(with: p.utf16) }
    func contains(_ a: String, _ p: String) -> Bool { a.range(of: p, options: .literal) != nil }
    func score(_ d: Destination) -> Int {
        let names = [d.code.lowercased(), d.label.lowercased()] + (d.aliases ?? []).map { $0.lowercased() }
        // Only hyphens or underscores typed: nothing to match a code by.
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
            let ka = kindRank(a.d.kind), kb = kindRank(b.d.kind)
            if ka != kb { return ka < kb }
            let la = a.d.label.utf16.count, lb = b.d.label.utf16.count
            if la != lb { return la < lb }
            return a.i < b.i
        }
        .prefix(max)
        .map(\.d)
}

/// What the popover shows: the planned trip, a saved place, or any stop/venue.
enum Target: Hashable {
    case plan
    case place(key: String)
    case code(String, label: String)
}

/// `/campus`: every stop, and the residences with the stops that serve them.
struct Campus: Decodable {
    struct Stop: Decodable, Hashable { let code: String; let name: String; let lat: Double?; let lon: Double? }
    /// `common`: where most students live (PGP, UTown Residence), shown first in the pickers.
    /// `walkMin`: minutes on foot to its stop at a normal pace, as the server works it out.
    struct Residence: Decodable, Hashable { let code: String; let name: String; let stops: [String]; let walkM: Double?; var walkMin: Int?; var common: Bool? }
    let stops: [Stop]
    let residences: [Residence]

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = try c.decode([Stop].self, forKey: .stops).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        // The common ones first, so home stops several share (every UTown college is UTOWN's) match the likelier one.
        residences = ((try? c.decodeIfPresent([Residence].self, forKey: .residences)) ?? []).sorted {
            ($0.common == true) != ($1.common == true) ? $0.common == true : $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
    enum CodingKeys: String, CodingKey { case stops, residences }

    func stopName(_ code: String) -> String { stops.first { $0.code == code }?.name ?? code }

    /// The stop nearest a point, for "Pick the stop nearest me".
    func nearest(lat: Double, lon: Double) -> Stop? {
        stops.filter { $0.lat != nil && $0.lon != nil }.min { a, b in
            func d(_ s: Stop) -> Double {
                let dLat = s.lat! - lat, dLon = (s.lon! - lon) * cos(lat * .pi / 180)
                return dLat * dLat + dLon * dLon
            }
            return d(a) < d(b)
        }
    }
}

/// An imported class whose room couldn't be placed: the person picks its stop, or skips it.
struct Unplaced: Hashable {
    let module: String
    let venue: String
    let day: Int
    let arriveByMin: Int
    let endMin: Int?
    let offCampus: Bool
}

/// `/me/import`: what was found, what couldn't be placed, and for which semester.
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
            Unplaced(module: $0["module"] as? String ?? "", venue: $0["venue"] as? String ?? "", day: $0["day"] as? Int ?? 1, arriveByMin: $0["arriveByMin"] as? Int ?? 0, endMin: $0["endMin"] as? Int, offCampus: $0["offCampus"] as? Bool ?? false)
        }
        missing = o["missing"] as? [String] ?? []
        term = o["term"] as? String ?? ""
    }

    /// "Imported 12 classes for AY2026/27 Semester 1."
    var summary: String {
        classes == 1 ? L("Imported 1 class for %@.", term) : L("Imported %@ classes for %@.", "\(classes)", term)
    }

    /// The modules NUSMods had nothing for this semester, if any.
    var missingText: String? {
        missing.isEmpty ? nil : L("NUSMods has no classes this semester for %@.", missing.joined(separator: ", "))
    }
}

/// `/me`: who this Mac is signed in as.
struct Me: Decodable {
    let email: String?
    let anonymous: Bool?
    /// The timetable is for a semester that has ended.
    let needsReimport: Bool?
    let term: String?
}

/// A class you chose to leave a bus earlier for (`earlier`) or get no reminders for (`quiet`).
struct TripChoice: Decodable, Hashable {
    let trip: String
    let pref: String
    let label: String?
}

/// `/me/choices`: those classes, and how many trips are remembered.
struct Choices: Decodable {
    let choices: [TripChoice]
    let history: Int
}

/// A device signed in to the account, as Settings lists it.
struct Device: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let platform: String?
    let lastSeen: Double?
    let current: Bool?
}

/// `/me/day`: today's classes and the trips home, and where each stands.
struct DayPlan: Decodable {
    struct Item: Decodable, Identifiable {
        struct Leave: Decodable { let at: String; let estimated: Bool?; let svc: String?; let stop: String? }
        struct Timing: Decodable { let status: String?; let text: String? }
        struct OnBus: Decodable { let svc: String; let off: String?; let arrive: String? }
        let kind: String
        let key: String
        let label: String
        /// "GEA1000 @ UTown", "Home, from UTown": worded on the server.
        let serverTitle: String?
        /// "Leave by ~09:36 · R2 from PGP", "Not going"; nil when done.
        let line: String?
        /// done | now | next | later | skipped
        let status: String
        let fromName: String?
        let startsAt: String
        /// A trip home: when it stops being the next thing (nil: an hour after it starts).
        let endsAt: String?
        let leave: Leave?
        let timing: Timing?
        let onBus: OnBus?
        /// Can be taken off today (the × on the row): anything not done yet.
        let removable: Bool?
        var id: String { key }

        enum CodingKeys: String, CodingKey {
            case kind, key, label, line, status, fromName, startsAt, endsAt, leave, timing, onBus, removable
            case serverTitle = "title"
        }

        /// "Leave by 09:38 · D2 from PGP", "On the D2 · off at UTown · arrive 09:52", or nil:
        /// the server's `line`, worded here only for an older server's plan.
        var sub: String? {
            if let line { return line }
            if serverTitle != nil || status == "done" { return nil }
            if status == "skipped" { return L("Not going") }
            if status == "done" { return nil }
            if let b = onBus {
                return ([L("On the %@", b.svc), b.off.map { L("off at %@", $0) }, b.arrive.flatMap(parseISODate).map { L("arrive %@", campusTime($0)) }] as [String?]).compactMap { $0 }.joined(separator: " · ")
            }
            guard let l = leave, let at = parseISODate(l.at) else { return nil }
            let how = l.svc.map { L("%@ from %@", $0, l.stop ?? fromName ?? "") } ?? L("walk")
            return ([L("Leave by %@", l.estimated == true ? L("~%@", campusTime(at)) : campusTime(at)), how, timing?.status == "late" ? timing?.text : nil] as [String?]).compactMap { $0 }.joined(separator: " · ")
        }
        var title: String { serverTitle ?? (kind == "home" ? (fromName.map { L("Home, from %@", $0) } ?? L("Home after your last class")) : label) }
    }
    var items: [Item]
    let note: String?
    /// The SGT day it's for (YYYY-MM-DD): a plan kept for offline is only used that day.
    let date: String?

    enum CodingKeys: String, CodingKey { case items, note, date }

    /// One entry this version can't read is left out, not the whole of today.
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        items = c.lenientList(Item.self, forKey: .items) ?? []
        note = try? c.decodeIfPresent(String.self, forKey: .note)
        date = try? c.decodeIfPresent(String.self, forKey: .date)
    }
}

/// A button on the card: `id` is the signal to send, `trip` which trip it's about.
struct CardAction: Decodable, Hashable {
    let id: String
    let label: String
    let trip: String
}

/// Something terminus learned and offers to change; `id` goes back to /me/choice.
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

/// After a 429, every request of the same kind from this Mac waits out the
/// server's Retry-After, at most 5 minutes (`maxS`): asking again sooner only
/// keeps the limit tripped, and each refused request still costs the server
/// one. Signing in and the answers are limited apart on the server, so they
/// wait apart here: a mistyped code doesn't stop the menu bar, nor the other
/// way. A 503's Retry-After (the accounts database or the map file down for
/// a moment) isn't a gate: only the polling loops wait it out (`later`).
enum Quiet {
    enum Scope { case signIn, app }

    /// The longest any Retry-After is honoured, a 429's or a 503's.
    static let maxS: TimeInterval = 300

    private static let lock = NSLock()
    nonisolated(unsafe) private static var untilDates: [Scope: Date] = [:]
    nonisolated(unsafe) private static var laterDate = Date.distantPast

    /// Sign-in and pairing (`/auth/…`, `/pair`, `/me/pair-code`), or everything else.
    static func scope(_ path: String) -> Scope {
        path == "/pair" || path == "/me/pair-code" || path.hasPrefix("/auth/") ? .signIn : .app
    }

    static func until(_ scope: Scope) -> Date { lock.withLock { untilDates[scope] ?? .distantPast } }

    static func after(_ retryAfter: String?, scope: Scope, now: Date = Date()) {
        let s = retryAfterS(retryAfter, now: now) ?? 60
        lock.withLock { untilDates[scope] = now.addingTimeInterval(cap(s)) }
    }

    /// A 503: the polling loops wait its Retry-After, when it gives one.
    static func later(_ retryAfter: String?, now: Date = Date()) {
        guard let s = retryAfterS(retryAfter, now: now) else { return }
        lock.withLock { laterDate = now.addingTimeInterval(cap(s)) }
    }

    /// How long a polling loop waits before asking again, at least: a 429's
    /// wait or a 503's (0: now).
    static func wait(now: Date = Date()) -> TimeInterval {
        max(until(.app).timeIntervalSince(now), lock.withLock { laterDate }.timeIntervalSince(now), 0)
    }

    /// A Retry-After as honoured: at least a second, at most `maxS`.
    static func cap(_ s: TimeInterval) -> TimeInterval { min(max(s, 1), maxS) }
}

/// Retry-After in seconds, from either form HTTP allows ("120", or a date);
/// nil when it's missing or unreadable.
func retryAfterS(_ header: String?, now: Date = Date()) -> TimeInterval? {
    guard let h = header?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return nil }
    if let s = Double(h) { return s > 0 ? s : nil }
    return ServerClock.parseHTTPDate(h).map { $0.timeIntervalSince(now) }.flatMap { $0 > 0 ? $0 : nil }
}

/// A 426: this version is older than the server still serves (the
/// `config:minClient` minimum). Every request with a token would be refused
/// the same way until it's updated, so none goes out for half an hour:
/// Sparkle's update is what fixes it, and a relaunch into it starts afresh.
/// Then one asks again, in case the minimum was lowered meanwhile; a reply
/// that isn't a 426 ends it. What the server still serves (`gated`) goes.
enum Outdated {
    static let holdS: TimeInterval = 30 * 60

    private static let lock = NSLock()
    nonisolated(unsafe) private static var untilDate = Date.distantPast

    static var active: Bool { lock.withLock { Date() < untilDate } }

    static func mark() { lock.withLock { untilDate = Date().addingTimeInterval(holdS) } }

    /// Whether the server refuses this request to an outdated app, as
    /// apps/api checks it: an account's routes (`/me…`) and the answers it
    /// asks with its token (KEYED in index.ts). Not signing in or out
    /// (`/auth/…`, `/pair…`), the released version (`/download/…`), nor
    /// deleting the account or taking the device off pushes
    /// (`DELETE /me`, `DELETE /me/push`).
    static func gated(_ method: String, _ path: String) -> Bool {
        let p = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if method == "DELETE" && (p == "/me" || p == "/me/push") { return false }
        return p == "/me" || p.hasPrefix("/me/") || answers.contains(p)
    }

    /// The bus answers the server refuses an outdated app (KEYED in apps/api/src/index.ts).
    private static let answers: Set<String> = ["/next", "/trip", "/arrivals", "/buses", "/line", "/campus", "/stops/pairs"]
}

struct ApiError: LocalizedError {
    let status: Int
    let message: String
    /// Seconds the server asked to wait (Retry-After on a 429 or 503).
    var retryAfter: TimeInterval? = nil
    /// The reply's own `status`, when it has one ("denied" for a sign-in code tried too often).
    var state: String? = nil
    var errorDescription: String? { message }
    /// This version is too old for the server (426): only an update helps.
    var updateRequired: Bool { status == 426 }
}

/// What to show for a failed request: the server's message when it answered,
/// "can't read" when it answered with something this version doesn't
/// understand, else `otherwise` (it couldn't be reached, by default).
func failureMessage(_ error: Error, otherwise: String = L("Couldn't reach terminus. Check your connection and try again.")) -> String {
    if let e = error as? ApiError { return e.message }
    if error is DecodingError { return L("terminus sent something this version can't read.") }
    return otherwise
}

/// The API's errors are lowercase phrases for API users ("not a valid NUSMods
/// share link"); shown here as sentences, as on the web and Android.
func sentence(_ text: String) -> String {
    guard let first = text.first else { return text }
    let s = first.uppercased() + text.dropFirst()
    if ".!?。！？".contains(s.last!) { return s }
    // Chinese ends with a full-width stop.
    return s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? s + "。" : s + "."
}

/// Which server the app talks to. Only ever one built in: the site's own
/// two addresses, and in a debug build the local dev stub. The developer menu
/// (Settings, About) picks one; nothing can add one, so it can't send the
/// token anywhere but our own servers.
///
/// The default is terminus.rcn.sh, not the address people see
/// (terminus.run): it's the one kept for good, so a Mac that's never updated
/// keeps working whichever address the site moves to.
enum Servers {
    /// The default: TerminusAPI in the beta build's Info.plist (build.sh), else the stable site's.
    static let defaultBase = Bundle.main.object(forInfoDictionaryKey: "TerminusAPI") as? String ?? "https://terminus.rcn.sh"
    static let stub = "http://localhost:8787"
    private static let key = "server"
    private static let menuKey = "developerMenu"

    /// [defaultBase] first, then the address people see, then in a debug build the stub.
    static func all(default base: String, site: String, debug: Bool) -> [String] {
        var out: [String] = []
        for s in [base, site] + (debug ? [stub] : []) where !out.contains(s) { out.append(s) }
        return out
    }

    /// The saved choice if it's still one of [all], else the default: a server
    /// dropped from the app, or anything else written into its preferences
    /// (any app running as you can), is never used.
    static func pick(_ saved: String?, from all: [String]) -> String {
        if let saved, all.contains(saved) { return saved }
        return all[0]
    }

    /// Plain HTTP to this Mac: the dev stub (apps/api/scripts/dev-stub.mjs).
    static func isLocal(_ base: String) -> Bool {
        guard let u = URL(string: base), u.scheme == "http", let host = u.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1"
    }

    /// The menu shows in debug and beta builds; in a stable release, once the
    /// version in About is clicked [unlockClicks] times.
    static func menuAlways(debug: Bool, beta: Bool) -> Bool { debug || beta }
    static let unlockClicks = 7

    static var isDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    static var choices: [String] { all(default: defaultBase, site: Api.site, debug: isDebug) }
    static var current: String { pick(UserDefaults.standard.string(forKey: key), from: choices) }
    static var menuShown: Bool { menuAlways(debug: isDebug, beta: Api.isBeta) || UserDefaults.standard.bool(forKey: menuKey) }
    static func unlockMenu() { UserDefaults.standard.set(true, forKey: menuKey) }

    /// Saves [base] and starts terminus again on it. The stub keeps its own
    /// sign-in (TokenStore), so the real account's token never goes to it.
    @MainActor static func choose(_ base: String) {
        guard choices.contains(base), base != Api.base else { return }
        UserDefaults.standard.set(base, forKey: key)
        let app = Bundle.main.bundleURL
        guard app.pathExtension == "app" else { NSApp.terminate(nil); return }
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

struct Api {
    static let stableSite = "https://terminus.run"
    /// The site this app belongs to, as people see it: terminus.run, or the
    /// beta's (TerminusSite in the beta build's Info.plist; see build.sh).
    static let site = Bundle.main.object(forInfoDictionaryKey: "TerminusSite") as? String ?? stableSite
    /// The site as people type it, for text.
    static var siteHost: String { site.replacingOccurrences(of: "https://", with: "") }
    /// Where links open (the account page, downloads, pairing QR codes): the
    /// old address, kept for good like the API's, so a Mac never updated
    /// keeps working if the site moves, and because NUS Wi-Fi refuses
    /// terminus.run for now. The server sends those pages on to [site] once it can.
    static let linkBase = Servers.defaultBase
    static var isBeta: Bool { site != stableSite }
    /// Where requests go: the server chosen (Servers), or TERMINUS_API_BASE=http://localhost:8787
    /// for the local dev stub (apps/api/scripts/dev-stub.mjs).
    static let base = devOverride("TERMINUS_API_BASE") ?? Servers.current

    /// An environment override for local development: any URL in a debug
    /// build, only this Mac (localhost, 127.0.0.1) in a release one, so the
    /// launch environment can't send a real install's sign-in elsewhere.
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

    /// This build's version ("2.4.2"); nil run without a bundle (`swift run`, tests).
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String

    /// `x-terminus-client`: platform and version.
    static let client = "mac/\(version ?? "dev")"

    func pair(code: String, name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/pair", body: ["code": code, "name": name])
        return r.token
    }

    /// Starts a sign-in approved from the email, on any device. The Mac shows `match`.
    func signInStart(email: String, name: String) async throws -> SignInRequest {
        try await request("POST", "/auth/app/start", body: ["email": email, "name": name])
    }

    /// pending, approved (with a token, once), denied or expired.
    func signInPoll(_ r: SignInRequest) async throws -> SignInPoll {
        try await request("POST", "/auth/app/poll", body: ["request": r.request, "poll": r.poll])
    }

    /// The code from the email, typed here. A wrong one throws with the server's message.
    func signInCode(_ r: SignInRequest, code: String) async throws -> SignInPoll {
        try await request("POST", "/auth/app/code", body: ["request": r.request, "poll": r.poll, "code": code])
    }

    func next(_ target: Target, lat: Double?, lon: Double?, acc: Double? = nil) async throws -> NextAnswer {
        var q = Self.coords(lat, lon, acc)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        return try await answer("GET", "/me/next", query: q + Self.h12)
    }

    /// Something that happened on the trip; answers with the new planned answer.
    func signal(_ action: CardAction) async throws -> NextAnswer {
        let body: [String: Any] = ["kind": action.id, "trip": action.trip]
        return try await answer("POST", "/me/signal", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body))
    }

    /// A suggestion accepted or turned down.
    func choice(id: String, accept: Bool) async throws {
        let body: [String: Any] = ["id": id, "choice": accept ? "accept" : "dismiss"]
        _ = try await send("POST", "/me/choice", json: try JSONSerialization.data(withJSONObject: body))
    }

    /// "Is this wrong?": the answer as it came from the server, with a reason
    /// (an id from `ReportForm.reasons`, as /me/feedback takes them), a note,
    /// or both. Needs an account with an email.
    func report(reason: String?, note: String, answer: Data?) async throws {
        try await feedback(kind: "wrong", note: note, reason: reason, context: answer.flatMap { try? JSONSerialization.jsonObject(with: $0) })
    }

    // MARK: setup and devices: the account page's routes, from the app

    /// The profile as the server keeps it, kept as JSON so fields this version
    /// doesn't know about survive a save.
    func profile() async throws -> Data {
        try await send("GET", "/me/profile")
    }

    /// Saves the whole profile; answers with it as saved.
    func saveProfile(_ profile: Data) async throws -> Data {
        try await send("PUT", "/me/profile", json: profile)
    }

    /// Imports a NUSMods share link; the server replaces the imported classes only if it all worked.
    /// The import's answer as JSON (see ImportResult).
    func importTimetable(_ share: String) async throws -> Data {
        try await send("POST", "/me/import", json: JSONSerialization.data(withJSONObject: ["share": share]))
    }

    /// Stops and residences, for the home picker.
    func campus() async throws -> Campus {
        try JSONDecoder().decode(Campus.self, from: await send("GET", "/campus"))
    }

    /// A pairing code for another device (accounts with an email only).
    func pairCode() async throws -> String {
        struct R: Decodable { let code: String }
        return try JSONDecoder().decode(R.self, from: await send("POST", "/me/pair-code", json: Data("{}".utf8))).code
    }

    func devices() async throws -> [Device] {
        struct R: Decodable { let devices: [Device] }
        return try JSONDecoder().decode(R.self, from: await send("GET", "/me/devices")).devices
    }

    /// The owner is emailed about every removal.
    func removeDevice(_ id: String) async throws {
        let safe = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await send("DELETE", "/me/devices/\(safe)")
    }

    /// Today at a glance: each class with its leave-by, and the trips home.
    /// With a location, the next class is planned from there, as the card is.
    func day(lat: Double? = nil, lon: Double? = nil, acc: Double? = nil) async throws -> DayPlan {
        try JSONDecoder().decode(DayPlan.self, from: try await send("GET", "/me/day", query: Self.coords(lat, lon, acc) + Self.h12))
    }

    func nearby(lat: Double?, lon: Double?, acc: Double? = nil) async throws -> [NearbyStop] {
        struct R: Decodable { let stops: [NearbyStop] }
        let r: R = try await request("GET", "/me/nearby", query: Self.coords(lat, lon, acc))
        return r.stops
    }

    func destinations() async throws -> [Destination] {
        struct R: Decodable { let destinations: [Destination] }
        let r: R = try await request("GET", "/campus")
        return r.destinations
    }

    /// Starts without an email: an account of its own for this Mac, as the phone's first launch.
    func anon(name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/auth/anon", body: ["name": name, "platform": "mac"])
        return r.token
    }

    /// After adding an email where both had a setup: keep the account's, or this Mac's.
    func merge(anon: String, keepDevice: Bool) async throws {
        _ = try await send("POST", "/auth/app/merge", json: JSONSerialization.data(withJSONObject: ["anon": anon, "keep": keepDevice ? "device" : "account"]))
    }

    func me() async throws -> Me {
        try JSONDecoder().decode(Me.self, from: await send("GET", "/me"))
    }

    /// A one-off trip later today, planned like a class. Answers with the new plan.
    func once(_ target: Target, atMin: Int) async throws -> NextAnswer {
        var body: [String: Any] = ["atMin": atMin]
        switch target {
        case .plan: break
        case .place(let key): body["place"] = key
        case .code(let code, let label): body["to"] = code; body["label"] = label
        }
        return try await answer("POST", "/me/once", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body))
    }

    /// Send feedback: a note about anything, emailed to the operator like "Is this wrong?".
    /// Needs an account with an email.
    func feedback(note: String) async throws {
        try await feedback(kind: "other", note: note)
    }

    /// A note to /me/feedback with this build's version, and for a report the answer it's about.
    private func feedback(kind: String, note: String, reason: String? = nil, context: Any? = nil) async throws {
        var body: [String: Any] = ["kind": kind, "note": note, "platform": "mac"]
        if let reason { body["reason"] = reason }
        if let v = Api.version { body["appVersion"] = v }
        if let context { body["context"] = context }
        _ = try await send("POST", "/me/feedback", json: try JSONSerialization.data(withJSONObject: body))
    }

    /// Download my data: everything the account holds, as JSON.
    func export() async throws -> Data {
        try await send("GET", "/me/export")
    }

    func choices() async throws -> Choices {
        try JSONDecoder().decode(Choices.self, from: await send("GET", "/me/choices"))
    }

    /// A class's "one bus earlier" or "no reminders" undone.
    func undoChoice(trip: String, pref: String) async throws {
        _ = try await send("POST", "/me/choice", json: JSONSerialization.data(withJSONObject: ["choice": "undo", "trip": trip, "pref": pref]))
    }

    /// Clear trip history: the outcomes go; the choices made from them stay.
    func clearHistory() async throws {
        _ = try await send("DELETE", "/me/history")
    }

    /// An account without an email: everything goes. (One with an email is deleted on the account page.)
    func deleteAccount() async throws {
        _ = try await send("DELETE", "/me")
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

    /// `acc` is how far out the fix may be (fixUncertaintyM): the server
    /// treats one further out than 200 m as no location, and follows the timetable.
    static func coords(_ lat: Double?, _ lon: Double?, _ acc: Double? = nil) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        // Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and
        // no more precise than that in URLs that pass through logs.
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        var q = [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
        if let acc { q.append(URLQueryItem(name: "acc", value: String(Int(acc.rounded())))) }
        return q
    }

    /// The card's clock times in this Mac's 12- or 24-hour style.
    private static var h12: [URLQueryItem] { usesHour12 ? [URLQueryItem(name: "h12", value: "1")] : [] }

    /// A NextAnswer, keeping the response as it came for "Is this wrong?".
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

    /// The response body of a 2xx; anything else throws with the server's message.
    private func send(_ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil) async throws -> Data {
        // Too old for the server: nothing with a token goes out until an update.
        let scope = Quiet.scope(path)
        if token != nil, Outdated.gated(method, path), Outdated.active { throw ApiError(status: 426, message: L("Update terminus to keep using it.")) }
        // Asked to slow down: nothing goes out until Retry-After is up.
        let quietUntil = Quiet.until(scope)
        if Date() < quietUntil { throw ApiError(status: 429, message: L("terminus is busy. Try again in a minute."), retryAfter: quietUntil.timeIntervalSinceNow) }
        var comps = URLComponents(string: Api.base + path)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!, timeoutInterval: 10)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")
        // So the server can tell the Mac from other CFNetwork clients, and versions apart.
        req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
        // The server writes answers, cards and errors in the app's language.
        req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = json
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if let http { ServerClock.observe(http) }
        let retryAfter = http?.value(forHTTPHeaderField: "retry-after")
        if status == 429 { Quiet.after(retryAfter, scope: scope) }
        if status == 503 { Quiet.later(retryAfter) }
        if status == 426 { Outdated.mark() }
        guard (200..<300).contains(status) else {
            let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let msg = o?["error"] as? String
            // No message of its own (a proxy's or Cloudflare's HTML page): plain words, not a status code.
            throw ApiError(
                status: status,
                message: status == 426 ? L("Update terminus to keep using it.") : msg.map(sentence) ?? L("Couldn't reach terminus. Try again in a moment."),
                retryAfter: retryAfterS(retryAfter),
                state: o?["status"] as? String
            )
        }
        return data
    }
}
