import Foundation

struct Place: Decodable, Hashable {
    let key: String
    let label: String
}

/// `/me/next`. label and detail are display-ready; show them verbatim.
struct NextAnswer: Decodable {
    struct Stop: Decodable { let code: String; let name: String }
    struct Dest: Decodable { let to: String; let label: String; let why: String }

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
    }

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
        places = try? c.decodeIfPresent([Place].self, forKey: .places)
        departsAt = try? c.decodeIfPresent(String.self, forKey: .departsAt)
        refreshAt = try? c.decodeIfPresent(String.self, forKey: .refreshAt)
        timing = try? c.decodeIfPresent(Timing.self, forKey: .timing)
        arrivals = try? c.decodeIfPresent([ArrivalLite].self, forKey: .arrivals)
        arrived = (try? c.decodeIfPresent(Bool.self, forKey: .arrived)) ?? false
        leave = try? c.decodeIfPresent(Leave.self, forKey: .leave)
        card = try? c.decodeIfPresent(Card.self, forKey: .card)
        walkSpeedMs = (try? c.decodeIfPresent(Double.self, forKey: .walkSpeedMs)).flatMap { $0 }
    }
    struct ArrivalLite: Decodable { let svc: String; let crowd: String? }

    var departure: Date? { departsAt.flatMap(parseISODate) }
    var planChanges: Date? { refreshAt.flatMap(parseISODate) }
    var service: String { label.components(separatedBy: " · ").first ?? label }
    var leaveAt: Date? { leave.flatMap { parseISODate($0.at) } }
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
    func leaveHeadline(now: Date = Date()) -> String? {
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
    func leaveText(now: Date = Date()) -> String? {
        guard let head = leaveHeadline(now: now) else { return nil }
        return card?.leaveVia.map { "\(head) · \($0)" } ?? head
    }

    var hasLiveTime: Bool { departure != nil && quality != "unknown" && quality != "ended" }
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
    f.timeZone = TimeZone(identifier: "Asia/Singapore")!
    f.setLocalizedDateFormatFromTemplate(usesHour12 ? "hmm" : "HHmm")
    // "下午 6:36", with the space the server's Chinese has.
    return f.string(from: d).replacingOccurrences(of: #"([上下]午)(\d)"#, with: "$1 $2", options: .regularExpression)
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

/// "1.0.10" is newer than "1.0.9".
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
}

struct NearbyStop: Decodable, Identifiable {
    struct Stop: Decodable { let code: String; let name: String }
    let stop: Stop
    let walkS: Int
    let available: Bool
    let board: [BoardRow]
    /// The stop across the road, when there is one (the nearest stop's is always in the list).
    var opposite: String? = nil
    var id: String { stop.code }
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
}

/// The destination search, same rules as the account page and Android: exact,
/// then starts with, then a word starts with, then contains; stops before
/// buildings before rooms, and rooms only once two characters say which.
func rankDestinations(_ all: [Destination], _ query: String, max: Int = 6) -> [Destination] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty else { return [] }
    let norm = { (s: String) in s.lowercased().filter { !" -_".contains($0) } }
    let nq = norm(q)
    let kinds = ["stop", "landmark", "building", "room"]
    func score(_ d: Destination) -> Int {
        let names = [d.code.lowercased(), d.label.lowercased()] + (d.aliases ?? [])
        if names.contains(q) || norm(d.code) == nq { return 0 }
        if names.contains(where: { $0.hasPrefix(q) }) || norm(d.code).hasPrefix(nq) { return 1 }
        let words = names.flatMap { $0.split(whereSeparator: { " ()·,/&-".contains($0) }) }
        if words.contains(where: { $0.hasPrefix(q) }) { return 2 }
        if names.contains(where: { $0.contains(q) }) { return 3 }
        return -1
    }
    return all
        .filter { $0.kind != "room" || q.count >= 2 }
        .map { ($0, score($0)) }
        .filter { $0.1 >= 0 }
        .sorted { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            let ka = kinds.firstIndex(of: a.0.kind) ?? 3, kb = kinds.firstIndex(of: b.0.kind) ?? 3
            if ka != kb { return ka < kb }
            return a.0.label.count < b.0.label.count
        }
        .prefix(max)
        .map { $0.0 }
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
    struct Residence: Decodable, Hashable { let code: String; let name: String; let stops: [String]; let walkM: Double? }
    let stops: [Stop]
    let residences: [Residence]

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        stops = try c.decode([Stop].self, forKey: .stops).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        residences = ((try? c.decodeIfPresent([Residence].self, forKey: .residences)) ?? []).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
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

        /// "Leave by 09:38 · D2 from PGP", "On the D2 · off at UTown · arrive 09:52", or nil.
        var sub: String? {
            if status == "skipped" { return L("Not going") }
            if status == "done" { return nil }
            if let b = onBus {
                return ([L("On the %@", b.svc), b.off.map { L("off at %@", $0) }, b.arrive.flatMap(parseISODate).map { L("arrive %@", campusTime($0)) }] as [String?]).compactMap { $0 }.joined(separator: " · ")
            }
            guard let l = leave, let at = parseISODate(l.at) else { return nil }
            let how = l.svc.map { L("%@ from %@", $0, l.stop ?? fromName ?? "") } ?? L("walk")
            return ([L("Leave by %@", l.estimated == true ? L("~%@", campusTime(at)) : campusTime(at)), how, timing?.status == "late" ? timing?.text : nil] as [String?]).compactMap { $0 }.joined(separator: " · ")
        }
        var title: String { kind == "home" ? L("Home, from %@", fromName ?? L("your last class")) : label }
    }
    var items: [Item]
    let note: String?
    /// The SGT day it's for (YYYY-MM-DD): a plan kept for offline is only used that day.
    let date: String?
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

/// After a 429, every request from this Mac waits out the server's
/// Retry-After, at most 5 minutes: asking again sooner only keeps the limit
/// tripped, and each refused request still costs the server one.
enum Quiet {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var untilDate = Date.distantPast

    static var until: Date { lock.withLock { untilDate } }

    static func after(_ retryAfter: String?) {
        let s = retryAfter.flatMap { Double($0.trimmingCharacters(in: .whitespaces)) }.flatMap { $0 > 0 ? $0 : nil } ?? 60
        lock.withLock { untilDate = Date().addingTimeInterval(min(s, 300)) }
    }
}

struct ApiError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
}

/// The API's errors are lowercase phrases for API users ("not a valid NUSMods
/// share link"); shown here as sentences, as on the web and Android.
func sentence(_ text: String) -> String {
    guard let first = text.first else { return text }
    let s = first.uppercased() + text.dropFirst()
    if ".!?。！？".contains(s.last!) { return s }
    // Chinese (phase 10) ends with a full-width stop.
    return s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? s + "。" : s + "."
}

struct Api {
    static let stableSite = "https://terminus.rcn.sh"
    /// The site this app belongs to: terminus.rcn.sh, or the beta's
    /// (TerminusSite in the beta build's Info.plist; see build.sh).
    static let site = Bundle.main.object(forInfoDictionaryKey: "TerminusSite") as? String ?? stableSite
    /// The site as people type it, for text.
    static var siteHost: String { site.replacingOccurrences(of: "https://", with: "") }
    static var isBeta: Bool { site != stableSite }
    /// Override with TERMINUS_API_BASE=http://localhost:8787 for a local wrangler dev.
    static let base = devOverride("TERMINUS_API_BASE") ?? site

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

    /// `x-terminus-client`: platform and version.
    static let client = "mac/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")"

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

    func next(_ target: Target, lat: Double?, lon: Double?) async throws -> NextAnswer {
        var q = coords(lat, lon)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        // The card's clock times, in this Mac's 12- or 24-hour style.
        if usesHour12 { q.append(URLQueryItem(name: "h12", value: "1")) }
        let data = try await send("GET", "/me/next", query: q)
        var answer = try JSONDecoder().decode(NextAnswer.self, from: data)
        answer.raw = data
        return answer
    }

    /// Something that happened on the trip; answers with the new planned answer.
    func signal(_ action: CardAction) async throws -> NextAnswer {
        let body: [String: Any] = ["kind": action.id, "trip": action.trip]
        let q = usesHour12 ? [URLQueryItem(name: "h12", value: "1")] : []
        let data = try await send("POST", "/me/signal", query: q, json: try JSONSerialization.data(withJSONObject: body))
        var answer = try JSONDecoder().decode(NextAnswer.self, from: data)
        answer.raw = data
        return answer
    }

    /// A suggestion accepted or turned down.
    func choice(id: String, accept: Bool) async throws {
        let body: [String: Any] = ["id": id, "choice": accept ? "accept" : "dismiss"]
        _ = try await send("POST", "/me/choice", json: try JSONSerialization.data(withJSONObject: body))
    }

    /// "Is this wrong?": the answer as it came from the server, and a note.
    func report(note: String, answer: Data?) async throws {
        var body: [String: Any] = ["kind": "wrong", "note": note, "platform": "mac"]
        if let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String { body["appVersion"] = v }
        if let answer, let obj = try? JSONSerialization.jsonObject(with: answer) { body["context"] = obj }
        _ = try await send("POST", "/me/feedback", json: try JSONSerialization.data(withJSONObject: body))
    }

    // MARK: setup and devices (phase 7): the account page's routes, from the app

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
    func day(lat: Double? = nil, lon: Double? = nil) async throws -> DayPlan {
        var q = coords(lat, lon)
        if usesHour12 { q.append(URLQueryItem(name: "h12", value: "1")) }
        return try JSONDecoder().decode(DayPlan.self, from: try await send("GET", "/me/day", query: q))
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

    /// A one-off trip later today (phase 8.3), planned like a class. Answers with the new plan.
    func once(_ target: Target, atMin: Int) async throws -> NextAnswer {
        var body: [String: Any] = ["atMin": atMin]
        switch target {
        case .plan: break
        case .place(let key): body["place"] = key
        case .code(let code, let label): body["to"] = code; body["label"] = label
        }
        let q = usesHour12 ? [URLQueryItem(name: "h12", value: "1")] : []
        let data = try await send("POST", "/me/once", query: q, json: try JSONSerialization.data(withJSONObject: body))
        var answer = try JSONDecoder().decode(NextAnswer.self, from: data)
        answer.raw = data
        return answer
    }

    /// Send feedback: a note about anything, emailed to the operator like "Is this wrong?".
    func feedback(note: String) async throws {
        var body: [String: Any] = ["kind": "other", "note": note, "platform": "mac"]
        if let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String { body["appVersion"] = v }
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

    private func coords(_ lat: Double?, _ lon: Double?) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        // Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and
        // no more precise than that in URLs that pass through logs.
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        return [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
    }

    private func request<T: Decodable>(
        _ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil
    ) async throws -> T {
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        return try JSONDecoder().decode(T.self, from: try await send(method, path, query: query, json: json))
    }

    /// The response body of a 2xx; anything else throws with the server's message.
    private func send(_ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil) async throws -> Data {
        // Asked to slow down: nothing goes out until Retry-After is up.
        if Date() < Quiet.until { throw ApiError(status: 429, message: L("terminus is busy. Try again in a minute.")) }
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
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 429 { Quiet.after((resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after")) }
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ApiError(status: status, message: msg.map(sentence) ?? "HTTP \(status)")
        }
        return data
    }
}
