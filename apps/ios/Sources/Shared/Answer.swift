import Foundation

/// The answer's shapes, read leniently: only what a screen can't do without
/// is required, and one field this version can't read is left out (nil, or
/// gone from its list), never the whole answer with it. Every line is worded
/// on the server (card.ts); the app shows it as it comes and only counts the
/// clock down.

struct Place: Decodable, Hashable, Sendable {
    let key: String
    let label: String
}

/// `/api/me/next`.
struct NextAnswer: Decodable, Sendable {
    struct Stop: Decodable, Sendable {
        let code: String
        let name: String
    }
    struct Dest: Decodable, Sendable {
        let to: String?
        let label: String
        let why: String?
    }
    struct Timing: Decodable, Sendable {
        let status: String?
        let text: String?
        let classAt: String?
        let reachAt: String?
    }
    struct Leave: Decodable, Sendable {
        let at: String
        let estimated: Bool?
        let svc: String?
        let stop: String?
        let board: String?
        let arrive: String?
        let note: String?
    }
    struct ArrivalLite: Decodable, Sendable {
        let svc: String
        let crowd: String?
    }

    let label: String
    let detail: String
    let alt: String?
    let stop: Stop?
    let quality: String
    let asOf: String?
    let mode: String
    let dest: Dest?
    let places: [Place]
    /// When the bus leaves. Count down from this; `label` is only true when fetched.
    let departsAt: String?
    let arrived: Bool
    let refreshAt: String?
    let timing: Timing?
    let arrivals: [ArrivalLite]
    let leave: Leave?
    let card: Card?
    /// The user's walking speed (m/s, from their pace), for walk times worked out here.
    let walkSpeedMs: Double?
    /// The response as it came, sent with an "Is this wrong?" report. Never in the JSON.
    var raw: Data? = nil

    enum CodingKeys: String, CodingKey {
        case label, detail, alt, stop, quality, asOf, mode, dest, places, departsAt, refreshAt, timing, arrivals, arrived, leave, card,
            walkSpeedMs
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        label = try c.decode(String.self, forKey: .label)
        detail = c.string(.detail) ?? ""
        alt = c.string(.alt)
        stop = try? c.decodeIfPresent(Stop.self, forKey: .stop)
        quality = c.string(.quality) ?? "unknown"
        asOf = c.string(.asOf)
        mode = c.string(.mode) ?? "trip"
        dest = try? c.decodeIfPresent(Dest.self, forKey: .dest)
        places = c.lenientList(Place.self, forKey: .places) ?? []
        departsAt = c.string(.departsAt)
        refreshAt = c.string(.refreshAt)
        timing = try? c.decodeIfPresent(Timing.self, forKey: .timing)
        arrivals = c.lenientList(ArrivalLite.self, forKey: .arrivals) ?? []
        arrived = c.bool(.arrived) ?? false
        leave = try? c.decodeIfPresent(Leave.self, forKey: .leave)
        card = try? c.decodeIfPresent(Card.self, forKey: .card)
        walkSpeedMs = (try? c.decodeIfPresent(Double.self, forKey: .walkSpeedMs)).flatMap { $0 }
    }

    /// An answer from its JSON, keeping the JSON for "Is this wrong?".
    static func decode(_ data: Data) throws -> NextAnswer {
        var a = try JSONDecoder().decode(NextAnswer.self, from: data)
        a.raw = data
        return a
    }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var leaveAt: Date? { leave.flatMap { parseISODate($0.at) } }
    var classAt: Date? { timing?.classAt.flatMap(parseISODate) }
    var staleAt: Date? { card?.staleAt.flatMap(parseISODate) }
    var nextChange: Date? { card?.nextChangeAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }

    var isClassPlan: Bool { card?.kind == "class" }
    /// No classes today (or none left): nothing to catch.
    var isFree: Bool { mode == "free" }
    var phase: String { card?.phase ?? "idle" }
    /// A trip under way.
    var tripUnderWay: Bool { ["heading", "waiting", "riding", "missed"].contains(phase) }
    var leaveLate: Bool { card?.late ?? false }
    var qualityText: String? { card?.quality }
    var leaveNote: String? { leave?.note }

    /// What the countdown counts to: the leave-by, or at the stop (phase
    /// `waiting`, where the headline names the bus) the bus's own time.
    var countdownAt: Date? {
        if phase == "waiting", let board = leave?.board.flatMap(parseISODate) { return board }
        return leaveAt
    }

    /// "Leave by ~09:38", or "Leave now" once it has passed: the only part that ticks.
    /// At the stop it's the bus to wait for ("D2 at 09:41"), as the server says it.
    func leaveHeadline(now: Date) -> String? {
        guard let at = leaveAt else { return nil }
        if phase == "waiting" { return card?.leaveBy }
        return now >= at ? L("Leave now") : card?.leaveBy
    }

    /// Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP".
    func leaveText(now: Date) -> String? {
        guard let head = leaveHeadline(now: now) else { return nil }
        return card?.leaveVia.map { "\(head) · \($0)" } ?? head
    }

    /// "Crowding: low", unless the detail already says it.
    var crowdText: String? {
        guard let c = card?.crowd else { return nil }
        return detail.localizedCaseInsensitiveContains(c) ? nil : c
    }

    /// The headline: the server's ("R2 · 09:06"), or for an older server one
    /// made from the label and the departure time, a guess with a "~".
    var title: String {
        if let t = card?.title { return t }
        guard let at = departure, quality != "unknown", quality != "ended" else { return label }
        let svc = label.components(separatedBy: " · ").first ?? label
        return "\(svc) · \(quality == "live" ? campusTime(at) : L("~%@", campusTime(at)))"
    }

    /// Past the card's staleAt: its times may be gone.
    func isOld(at now: Date) -> Bool { staleAt.map { now >= $0 } ?? false }
}

/// `card` in /me/next (apps/api's card.ts). Lines are shown verbatim.
struct Card: Decodable, Sendable {
    /// class, trip, nearby, rest, arrived, setup or free; "trip" for one this version doesn't know.
    let kind: String
    let staleAt: String?
    let crowd: String?
    let quality: String?
    let leaveBy: String?
    let leaveVia: String?
    let `catch`: String?
    let arrive: String?
    let catchLine: String?
    let late: Bool
    let goNow: String?
    let note: String?
    let estimate: String?
    /// idle, due, heading, waiting, riding, missed, arrived.
    let phase: String
    /// "On your way", above the answer. Nil when idle.
    let phaseText: String?
    /// 12 characters: a glance (the lock screen, the Live Activity's compact view).
    let glance: String?
    /// One line: a notification, a small widget.
    let line: String?
    let actions: [CardAction]
    let warning: String?
    let nextChangeAt: String?
    /// False when reminders are off for this class.
    let remind: Bool
    let suggestion: Suggestion?
    let notice: String?
    let upcoming: Upcoming?
    let title: String?
    let heading: String?
    /// When the leave reminder goes; nil: no reminder for this trip.
    let remindAt: String?
    let journey: Journey?
    let ride: Ride?
    /// The planned bus has left and nothing says whether you're on it. Never "Leave now".
    let gone: Bool
    /// Where to walk to now, for walking directions.
    let walkTo: WalkTo?

    static let kinds: Set = ["class", "trip", "nearby", "rest", "arrived", "setup", "free"]

    enum CodingKeys: String, CodingKey {
        case kind, staleAt, crowd, quality, leaveBy, leaveVia, `catch`, arrive, catchLine, late, goNow, note, estimate, phase, phaseText,
            glance, line, actions, warning, nextChangeAt, remind, suggestion, notice, upcoming
        case title, heading, remindAt, journey, ride, gone, walkTo
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        kind = c.string(.kind).flatMap { Self.kinds.contains($0) ? $0 : nil } ?? "trip"
        staleAt = c.string(.staleAt)
        crowd = c.string(.crowd)
        quality = c.string(.quality)
        leaveBy = c.string(.leaveBy)
        leaveVia = c.string(.leaveVia)
        `catch` = c.string(.catch)
        arrive = c.string(.arrive)
        catchLine = c.string(.catchLine)
        late = c.bool(.late) ?? false
        goNow = c.string(.goNow)
        note = c.string(.note)
        estimate = c.string(.estimate)
        phase = c.string(.phase) ?? "idle"
        phaseText = c.string(.phaseText)
        glance = c.string(.glance)
        line = c.string(.line)
        actions = c.lenientList(CardAction.self, forKey: .actions) ?? []
        warning = c.string(.warning)
        nextChangeAt = c.string(.nextChangeAt)
        remind = c.bool(.remind) ?? true
        suggestion = try? c.decodeIfPresent(Suggestion.self, forKey: .suggestion)
        notice = c.string(.notice)
        upcoming = try? c.decodeIfPresent(Upcoming.self, forKey: .upcoming)
        title = c.string(.title)
        heading = c.string(.heading)
        remindAt = c.string(.remindAt)
        journey = try? c.decodeIfPresent(Journey.self, forKey: .journey)
        ride = try? c.decodeIfPresent(Ride.self, forKey: .ride)
        gone = c.bool(.gone) ?? false
        walkTo = try? c.decodeIfPresent(WalkTo.self, forKey: .walkTo)
    }
}

/// A button on the card: `id` is the signal to send, `trip` which trip it's about.
struct CardAction: Decodable, Hashable, Sendable {
    let id: String
    let label: String
    let trip: String
}

/// Something terminus learned and offers to change; `id` goes back to /me/choice.
struct Suggestion: Decodable, Hashable, Sendable {
    let id: String
    let text: String
    let accept: String
    let dismiss: String
}

/// The next class, on a free day, after your day and at home.
struct Upcoming: Decodable, Sendable {
    let when: String
    let title: String
    let `where`: String
    let off: String?

    enum CodingKeys: String, CodingKey { case when, title, `where`, off }
    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        title = try c.decode(String.self, forKey: .title)
        when = c.string(.when) ?? ""
        `where` = c.string(.where) ?? ""
        off = c.string(.off)
    }
}

/// A stop to walk to, and where it is.
struct WalkTo: Decodable, Sendable {
    let name: String
    let lat: Double
    let lon: Double

    /// Walking directions there in Apple Maps.
    var mapsURL: URL? {
        var u = URLComponents(string: "https://maps.apple.com/")!
        u.queryItems = [
            URLQueryItem(name: "daddr", value: String(format: "%.6f,%.6f", locale: Locale(identifier: "en_US_POSIX"), lat, lon)),
            URLQueryItem(name: "dirflg", value: "w"),
        ]
        return u.url
    }
}

/// On the bus: its stops from boarding to getting off, and when each end is.
/// Where the bus is comes from the clock, the stops taken as evenly spaced
/// between the two times, as the phone and the web show it.
struct Ride: Decodable, Sendable {
    struct Stop: Decodable, Hashable, Sendable {
        let code: String?
        let name: String
    }
    struct Change: Decodable, Sendable {
        let svc: String
        let color: String?
        let text: String
    }
    let svc: String
    let stops: [Stop]
    let board: String
    let arrive: String
    let change: Change?

    enum CodingKeys: String, CodingKey { case svc, stops, board, arrive, change }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        svc = try c.decode(String.self, forKey: .svc)
        stops = c.lenientList(Stop.self, forKey: .stops) ?? []
        board = try c.decode(String.self, forKey: .board)
        arrive = try c.decode(String.self, forKey: .arrive)
        change = try? c.decodeIfPresent(Change.self, forKey: .change)
        guard stops.count >= 2, let b = parseISODate(board), let a = parseISODate(arrive), a > b else {
            throw DecodingError.dataCorruptedError(forKey: .stops, in: c, debugDescription: "a ride needs two stops and its times")
        }
    }

    var boardAt: Date { parseISODate(board) ?? .distantPast }
    var arriveAt: Date { parseISODate(arrive) ?? .distantPast }

    /// 0 to 1 along the ride at `now` (the server's clock).
    func progress(at now: Date) -> Double {
        min(1, max(0, now.timeIntervalSince(boardAt) / max(1, arriveAt.timeIntervalSince(boardAt))))
    }

    /// How many stops have been passed at `now`; the last is where you get off.
    func passed(at now: Date) -> Int { Int(progress(at: now) * Double(stops.count - 1)) }

    /// "Next: Opp NUSS · 3 stops to go", the same in the app, the widget and
    /// the Live Activity. Nearing the stop to change at, the second bus too.
    func nextText(at now: Date, withChange: Bool = true) -> String {
        let p = passed(at: now)
        let left = max(0, stops.count - 1 - p)
        let next = p + 1 < stops.count ? stops[p + 1].name : nil
        let text: String
        if next == nil || left == 0 {
            text = L("Getting off at %@", stops.last!.name)
        } else if left == 1 {
            text = L("Next: %@, where you get off", stops.last!.name)
        } else {
            text = L("Next: %@ · %@ stops to go", next!, "\(left)")
        }
        if withChange, let change, left <= 1 { return "\(text) · \(change.text)" }
        return text
    }
}

/// `card.journey`: the trip as steps (walk to the stop, take the bus, get
/// there), worded on the server; on foot the whole way, the walk alone, with
/// no `bus`. The app draws it in the card style chosen in Settings ›
/// Appearance; only the countdowns tick here.
struct Journey: Decodable, Sendable {
    struct Bus: Decodable, Sendable {
        let svc: String
        let color: String?
        let stop: String
        let board: String
        let paid: Bool
        enum CodingKeys: String, CodingKey { case svc, color, stop, board, paid }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            svc = try c.decode(String.self, forKey: .svc)
            color = c.string(.color)
            stop = c.string(.stop) ?? ""
            board = c.string(.board) ?? ""
            paid = c.bool(.paid) ?? false
        }
    }
    /// A change of bus on the way: `bus` is the first, this the second.
    struct Change: Decodable, Sendable {
        let from: String
        let stop: String
        let reach: String?
        let walk: String?
        let wait: String?
        let bus: Bus
        let boardAt: String
        let ride: String?
        let firstRide: String?
        let firstRideText: String?
        let changeText: String
        let rideText: String?
    }

    /// When to set off ("4:01 PM"); nil when it's now.
    let leave: String?
    /// The walk to the stop ("3 min"); nil at the stop. On foot, the whole walk there.
    let walk: String?
    let bus: Bus?
    /// When the bus leaves, to count down to; nil on foot.
    let boardAt: String?
    let ride: String?
    let off: String?
    let to: String
    let toStop: String
    let arrive: String?
    let walkEnd: String?
    let arriveStop: String?
    let slack: String?
    let live: Bool
    let backup: Bus?
    let why: String?
    let change: Change?
    // The server's words.
    let title: String?
    let placeText: String?
    let byText: String?
    let walkText: String?
    let rideText: String?
    let walkEndText: String?
    let arriveText: String?
    let arriveWhere: String?
    let backupText: String?
    let summary: String?

    enum CodingKeys: String, CodingKey {
        case leave, walk, bus, boardAt, ride, off, to, toStop, arrive, walkEnd, arriveStop, slack, live, backup, why, change
        case title
        case placeText = "place"
        case byText, walkText, rideText, walkEndText, arriveText, arriveWhere, backupText, summary
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        let busPresent = (try? c.decodeNil(forKey: .bus)) == false && c.contains(.bus)
        bus = try? c.decodeIfPresent(Bus.self, forKey: .bus)
        // A bus that can't be read isn't a walk: no journey rather than the wrong one.
        if busPresent && bus == nil { throw DecodingError.dataCorruptedError(forKey: .bus, in: c, debugDescription: "unreadable bus") }
        boardAt = bus == nil ? nil : c.string(.boardAt)
        if bus != nil && boardAt.flatMap(parseISODate) == nil {
            throw DecodingError.dataCorruptedError(forKey: .boardAt, in: c, debugDescription: "a bus needs its time")
        }
        walk = c.string(.walk)
        if bus == nil && walk == nil {
            throw DecodingError.dataCorruptedError(forKey: .walk, in: c, debugDescription: "neither bus nor walk")
        }
        leave = c.string(.leave)
        ride = bus == nil ? nil : c.string(.ride)
        off = c.string(.off)
        to = c.string(.to) ?? ""
        toStop = c.string(.toStop) ?? ""
        arrive = c.string(.arrive)
        walkEnd = c.string(.walkEnd)
        arriveStop = c.string(.arriveStop) ?? arrive
        slack = c.string(.slack)
        live = c.bool(.live) ?? false
        backup = try? c.decodeIfPresent(Bus.self, forKey: .backup)
        why = c.string(.why)
        change = bus == nil ? nil : try? c.decodeIfPresent(Change.self, forKey: .change)
        title = c.string(.title)
        placeText = c.string(.placeText)
        byText = c.string(.byText)
        walkText = c.string(.walkText)
        rideText = c.string(.rideText)
        walkEndText = c.string(.walkEndText)
        arriveText = c.string(.arriveText)
        arriveWhere = c.string(.arriveWhere)
        backupText = c.string(.backupText)
        summary = c.string(.summary)
    }

    var boardDate: Date? { boardAt.flatMap(parseISODate) }

    /// Where you're going, short enough for the end of a line: "GEA1000", not "GEA1000 @ UTown".
    var place: String { placeText ?? to.components(separatedBy: " @ ").first ?? to }
}

/// `/api/me/day`: today's classes and the trips home, and where each stands.
struct DayPlan: Decodable, Sendable {
    struct Item: Decodable, Identifiable, Sendable {
        struct Leave: Decodable, Sendable {
            let at: String
            let estimated: Bool?
            let svc: String?
            let stop: String?
        }
        struct Timing: Decodable, Sendable {
            let status: String?
            let text: String?
        }
        struct OnBus: Decodable, Sendable {
            let svc: String
            let off: String?
            let arrive: String?
        }
        let kind: String
        let key: String
        let label: String
        let serverTitle: String?
        /// "Leave by ~09:36 · R2 from PGP", "Not going"; nil when done.
        let line: String?
        /// done | now | next | later | skipped
        let status: String
        let fromName: String?
        let startsAt: String
        let endsAt: String?
        let leave: Leave?
        let timing: Timing?
        let onBus: OnBus?
        let removable: Bool
        var id: String { key }

        enum CodingKeys: String, CodingKey {
            case kind, key, label, line, status, fromName, startsAt, endsAt, leave, timing, onBus, removable
            case serverTitle = "title"
        }

        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: CodingKeys.self)
            kind = c.string(.kind) ?? "class"
            key = try c.decode(String.self, forKey: .key)
            label = c.string(.label) ?? ""
            serverTitle = c.string(.serverTitle)
            line = c.string(.line)
            status = c.string(.status) ?? "later"
            fromName = c.string(.fromName)
            startsAt = try c.decode(String.self, forKey: .startsAt)
            endsAt = c.string(.endsAt)
            leave = try? c.decodeIfPresent(Leave.self, forKey: .leave)
            timing = try? c.decodeIfPresent(Timing.self, forKey: .timing)
            onBus = try? c.decodeIfPresent(OnBus.self, forKey: .onBus)
            removable = c.bool(.removable) ?? false
        }

        var title: String {
            serverTitle ?? (kind == "home" ? (fromName.map { L("Home, from %@", $0) } ?? L("Home after your last class")) : label)
        }
        var starts: Date? { parseISODate(startsAt) }
    }
    var items: [Item]
    let note: String?
    /// The SGT day it's for (YYYY-MM-DD): a plan kept for offline is only used that day.
    let date: String?

    enum CodingKeys: String, CodingKey { case items, note, date }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        items = c.lenientList(Item.self, forKey: .items) ?? []
        note = c.string(.note)
        date = c.string(.date)
    }
}

/// One element of a list that may not decode: nil instead of failing the list.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from d: Decoder) throws { value = try? T(from: d) }
}

extension KeyedDecodingContainer {
    /// A list with the elements this version can't read left out; nil when it's missing or isn't a list.
    func lenientList<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T]? {
        (try? decodeIfPresent([Lossy<T>].self, forKey: key))?.compactMap(\.value)
    }

    /// A whole number that may come as 95.5: rounded, or nil when it's missing or not a number.
    func lenientInt(forKey key: Key) -> Int? {
        (try? decodeIfPresent(Double.self, forKey: key))?.flatMap { $0.isFinite ? Int($0.rounded()) : nil }
    }

    func string(_ key: Key) -> String? { (try? decodeIfPresent(String.self, forKey: key)) ?? nil }
    func bool(_ key: Key) -> Bool? { (try? decodeIfPresent(Bool.self, forKey: key)) ?? nil }
}
