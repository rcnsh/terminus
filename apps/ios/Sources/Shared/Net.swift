import Foundation

/// The server's clock, as near as this phone can tell. Times in answers
/// (departures, leave-bys, staleAt) are the server's; a phone clock a minute
/// out would count them down a minute out. The error is learned from the
/// HTTP `Date` header of uncached API responses.
enum ServerClock {
    /// `Date` has one-second resolution, and the answer takes a moment to
    /// arrive: anything under this is noise, not a wrong clock.
    static let ignoreS: TimeInterval = 3

    private static let offset = Mutex<TimeInterval>(0)

    /// Seconds to add to this phone's clock to get the server's.
    static var skew: TimeInterval { offset.withLock { $0 } }

    /// Now, on the server's clock: use it wherever a server time is compared with now.
    static var now: Date { Date().addingTimeInterval(skew) }

    /// The server's `Date` minus this phone's at the response; 0 when it's within `ignoreS`.
    static func skew(server: Date, local: Date) -> TimeInterval {
        let s = server.timeIntervalSince(local)
        return abs(s) < ignoreS ? 0 : s
    }

    /// "Wed, 07 Oct 2026 01:14:02 GMT" (RFC 9110's IMF-fixdate).
    static func parseHTTPDate(_ s: String) -> Date? { httpDate.withLock { $0.date(from: s) } }

    /// The skew a response says, if it came from the server just now: a
    /// cached one (anything but `no-store`) carries the time it was first sent.
    /// The server stamped it somewhere between `sent` and `received` on this
    /// phone, so it's compared with the middle; and `Date` drops the
    /// fraction of its second, so on average the stamp is half a second early.
    static func skew(from resp: HTTPURLResponse, sent: Date, received: Date) -> TimeInterval? {
        guard (resp.value(forHTTPHeaderField: "cache-control") ?? "").contains("no-store"),
            let server = resp.value(forHTTPHeaderField: "date").flatMap(parseHTTPDate)
        else { return nil }
        let middle = sent.addingTimeInterval(received.timeIntervalSince(sent) / 2)
        return skew(server: server.addingTimeInterval(0.5), local: middle)
    }

    static func observe(_ resp: HTTPURLResponse, sent: Date, received: Date = Date()) {
        guard let s = skew(from: resp, sent: sent, received: received) else { return }
        offset.withLock { $0 = s }
    }

    private static let httpDate = Mutex<DateFormatter>(
        {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "GMT")
            f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            return f
        }())
}

/// The API's times may or may not carry milliseconds ("…:02Z" or "…:02.000Z").
func parseISODate(_ s: String) -> Date? {
    ISOFormats.parse(s)
}

private enum ISOFormats {
    private static let both = Mutex<(ISO8601DateFormatter, ISO8601DateFormatter)>(
        {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return (ISO8601DateFormatter(), f)
        }())
    static func parse(_ s: String) -> Date? { both.withLock { $0.0.date(from: s) ?? $0.1.date(from: s) } }
}

extension TimeZone {
    /// Singapore's, where the campus is: times are shown in it whatever zone this phone is set to.
    static let campus = TimeZone(identifier: "Asia/Singapore")!
}

/// The account's 12- or 24-hour choice (its profile's `clock`): "auto"
/// follows this phone. Kept here so the widgets have it without the profile.
enum Clock {
    private static let key = "clock"
    static var pref: String {
        get { Shared.defaults.string(forKey: key) ?? "auto" }
        set { Shared.defaults.set(["12", "24"].contains(newValue) ? newValue : "auto", forKey: key) }
    }

    /// Whether to show 12-hour times: the account's choice, else this phone's.
    static var hour12: Bool {
        switch pref {
        case "12": true
        case "24": false
        default: (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
        }
    }
}

/// A clock time in campus time, in the account's 12- or 24-hour style, as the server writes the card.
func campusTime(_ d: Date) -> String { clockText(d, in: .campus) }

/// "18:36", or "6:36 PM" (下午 6:36) in 12-hour style: the server's
/// `clockMin`, so a time the app writes matches the card's beside it rather
/// than the phone's region ("6:36 pm" in British English).
func clockText(_ d: Date, in zone: TimeZone) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = zone
    let c = cal.dateComponents([.hour, .minute], from: d)
    let h = c.hour ?? 0
    let mm = String(format: "%02d", c.minute ?? 0)
    guard Clock.hour12 else { return String(format: "%02d", h) + ":" + mm }
    let hm = "\(h % 12 == 0 ? 12 : h % 12):\(mm)"
    if Lang.zh { return "\(h >= 12 ? "下午" : "上午")\u{00A0}\(hm)" }
    return "\(hm)\u{00A0}\(h >= 12 ? "PM" : "AM")"
}

/// "1.0.10" > "1.0.9", and a release is newer than its own pre-release.
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

/// After a 429, every request of the same kind from this phone (the app, its
/// widgets, a push) waits out the server's Retry-After, at most 5 minutes:
/// asking again sooner only keeps the limit tripped. Signing in is limited
/// apart from the answers, so it waits apart. A 503's Retry-After isn't a
/// gate: only the polling loops wait it out (`later`). Kept in the app group
/// by the wall clock, so a widget's process honours a wait the app was told.
enum Quiet {
    enum Scope: String { case signIn, app }

    static let maxS: TimeInterval = 300

    private static let laterDate = Mutex(Date.distantPast)

    static func scope(_ path: String) -> Scope {
        path.hasPrefix("/api/pair") || path == "/api/me/pair-code" || path.hasPrefix("/api/auth/") ? .signIn : .app
    }

    static func until(_ scope: Scope) -> Date {
        Date(timeIntervalSince1970: Shared.defaults.double(forKey: "quiet.\(scope.rawValue)"))
    }

    static func after(_ retryAfter: String?, scope: Scope, now: Date = Date()) {
        let s = retryAfterS(retryAfter, now: now) ?? 60
        Shared.defaults.set(now.addingTimeInterval(cap(s)).timeIntervalSince1970, forKey: "quiet.\(scope.rawValue)")
    }

    static func later(_ retryAfter: String?, now: Date = Date()) {
        guard let s = retryAfterS(retryAfter, now: now) else { return }
        laterDate.withLock { $0 = now.addingTimeInterval(cap(s)) }
    }

    /// How long a polling loop waits before asking again, at least (0: now).
    static func wait(now: Date = Date()) -> TimeInterval {
        max(until(.app).timeIntervalSince(now), laterDate.withLock { $0 }.timeIntervalSince(now), 0)
    }

    static func cap(_ s: TimeInterval) -> TimeInterval { min(max(s, 1), maxS) }
}

/// Retry-After in seconds, from either form HTTP allows ("120", or a date).
func retryAfterS(_ header: String?, now: Date = Date()) -> TimeInterval? {
    guard let h = header?.trimmingCharacters(in: .whitespaces), !h.isEmpty else { return nil }
    if let s = Double(h) { return s > 0 ? s : nil }
    return ServerClock.parseHTTPDate(h).map { $0.timeIntervalSince(now) }.flatMap { $0 > 0 ? $0 : nil }
}

/// A 426: this version is older than the server still serves. Every request
/// with a token would be refused the same way until it's updated, so none
/// goes out for half an hour; then one asks again, in case the minimum came
/// down. Kept in the app group with the version it was for.
enum Outdated {
    static let holdS: TimeInterval = 30 * 60

    private static var at: Double {
        guard Shared.defaults.string(forKey: "outdated.version") == Api.version else { return 0 }
        return Shared.defaults.double(forKey: "outdated.at")
    }

    /// Refused lately: what the app shows is the update, not an error.
    static var required: Bool { at != 0 }

    static var active: Bool { at != 0 && Date().timeIntervalSince1970 - at < holdS }

    static func mark() {
        Shared.defaults.set(Date().timeIntervalSince1970, forKey: "outdated.at")
        Shared.defaults.set(Api.version, forKey: "outdated.version")
    }

    static func served() {
        guard at != 0 else { return }
        Shared.defaults.removeObject(forKey: "outdated.at")
    }

    /// Whether the server refuses this request to an outdated app (KEYED in
    /// apps/api/src/index.ts): an account's routes and the answers asked with
    /// its token; not signing in or out, nor leaving.
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
    /// The reply's own `status`, when it has one ("denied" for a sign-in code tried too often).
    var state: String? = nil
    var errorDescription: String? { message }
    var updateRequired: Bool { status == 426 }
}

/// What to show for a failed request: the server's message when it answered,
/// "can't read" when it answered with something this version doesn't
/// understand, else `otherwise` (it couldn't be reached, by default).
func failureMessage(_ error: Error, otherwise: String? = nil) -> String {
    if let e = error as? ApiError { return e.message }
    if error is DecodingError { return L("terminus sent something this version can't read.") }
    return otherwise ?? L("Couldn't reach terminus. Check your connection and try again.")
}

/// The API's errors are lowercase phrases for API users ("not a valid NUSMods
/// share link"); shown here as sentences, as on the web and Android.
func sentence(_ text: String) -> String {
    guard let first = text.first else { return text }
    let s = first.uppercased() + text.dropFirst()
    if ".!?。！？".contains(s.last!) { return s }
    return s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? s + "。" : s + "."
}
