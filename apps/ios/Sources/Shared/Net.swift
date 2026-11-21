import Foundation

enum ServerClock {
    static let ignoreS: TimeInterval = 3

    private static let offset = Mutex<TimeInterval>(0)

    static var skew: TimeInterval { offset.withLock { $0 } }

    static var now: Date { Date().addingTimeInterval(skew) }

    static func skew(server: Date, local: Date) -> TimeInterval {
        let s = server.timeIntervalSince(local)
        return abs(s) < ignoreS ? 0 : s
    }

    static func parseHTTPDate(_ s: String) -> Date? { httpDate.withLock { $0.date(from: s) } }

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
    static let campus = TimeZone(identifier: "Asia/Singapore")!
}

enum Clock {
    private static let key = "clock"
    static var pref: String {
        get { Shared.defaults.string(forKey: key) ?? "auto" }
        set { Shared.defaults.set(["12", "24"].contains(newValue) ? newValue : "auto", forKey: key) }
    }

    static var hour12: Bool {
        switch pref {
        case "12": true
        case "24": false
        default: (DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current) ?? "").contains("a")
        }
    }
}

func campusTime(_ d: Date) -> String { clockText(d, in: .campus) }

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

    static func wait(now: Date = Date()) -> TimeInterval {
        max(until(.app).timeIntervalSince(now), laterDate.withLock { $0 }.timeIntervalSince(now), 0)
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

    private static var at: Double {
        guard Shared.defaults.string(forKey: "outdated.version") == Api.version else { return 0 }
        return Shared.defaults.double(forKey: "outdated.at")
    }

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

func failureMessage(_ error: Error, otherwise: String? = nil) -> String {
    if let e = error as? ApiError { return e.message }
    if error is DecodingError { return L("terminus sent something this version can't read.") }
    return otherwise ?? L("Couldn't reach terminus. Check your connection and try again.")
}

func sentence(_ text: String) -> String {
    guard let first = text.first else { return text }
    let s = first.uppercased() + text.dropFirst()
    if ".!?。！？".contains(s.last!) { return s }
    return s.unicodeScalars.contains { (0x4E00...0x9FFF).contains($0.value) } ? s + "。" : s + "."
}
