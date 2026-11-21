import Foundation

enum Servers {
    static let defaultBase = Bundle.main.object(forInfoDictionaryKey: "TerminusAPI") as? String ?? "https://terminus.run"
    static let backupBase = (Bundle.main.object(forInfoDictionaryKey: "TerminusBackup") as? String).flatMap { $0.isEmpty ? nil : $0 }
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
        let base = Api.base
        let (at, result) = try await first(tries(base), method: method, attempt)
        answered(at, base: base)
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
    static let unlockTaps = 7

    static var isDebug: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    static var choices: [String] { all(default: defaultBase, backup: backupBase, debug: isDebug) }
    static var current: String { pick(Shared.defaults.string(forKey: key), from: choices) }
    static var menuShown: Bool { menuAlways(debug: isDebug, beta: Api.isBeta) || Shared.defaults.bool(forKey: menuKey) }
    static func unlockMenu() { Shared.defaults.set(true, forKey: menuKey) }

    static func choose(_ base: String) {
        guard choices.contains(base) else { return }
        Shared.defaults.set(base, forKey: key)
    }
}

struct Api: Sendable {
    static let stableSite = "https://terminus.run"
    static let site = Bundle.main.object(forInfoDictionaryKey: "TerminusSite") as? String ?? stableSite
    static var siteHost: String { site.replacingOccurrences(of: "https://", with: "") }
    static let linkBase = site
    static var isBeta: Bool { site != stableSite }
    static var base: String { devOverride("TERMINUS_API_BASE") ?? Servers.current }

    static func devOverride(_ name: String) -> String? {
        #if DEBUG
            let shared = "dev." + name
            if Bundle.main.bundlePath.hasSuffix(".appex") { return Shared.defaults.string(forKey: shared) }
            let value = ProcessInfo.processInfo.environment[name].flatMap { $0.isEmpty ? nil : $0 }
            if Shared.defaults.string(forKey: shared) != value { Shared.defaults.set(value, forKey: shared) }
            return value
        #else
            return nil
        #endif
    }

    let token: String?
    var fast = false

    init(token: String?, fast: Bool = false) {
        self.token = token
        self.fast = fast
    }

    static var stored: Api { Api(token: TokenStore.read()) }

    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    static var client: String {
        #if os(watchOS)
            "ios-watch/\(version)"
        #else
            "ios/\(version)"
        #endif
    }

    func anon(name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/auth/anon", body: ["name": name, "platform": "ios"])
        return r.token
    }

    func pair(code: String, name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/pair", body: ["code": code, "name": name, "platform": "ios"])
        return r.token
    }

    func pairCheck(code: String) async throws -> String {
        struct R: Decodable { let account: String }
        let r: R = try await request("POST", "/api/pair/check", body: ["code": code])
        return r.account
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

    func merge(anon: String, keepDevice: Bool) async throws {
        _ = try await send(
            "POST", "/api/auth/app/merge",
            json: JSONSerialization.data(withJSONObject: ["anon": anon, "keep": keepDevice ? "device" : "account"]))
    }

    func logout() async throws {
        _ = try await send("POST", "/api/auth/logout", json: Data("{}".utf8))
    }

    func next(
        _ target: Target, lat: Double?, lon: Double?, acc: Double? = nil, seen: ((HTTPURLResponse) -> Void)? = nil
    ) async throws -> NextAnswer {
        var q = Self.coords(lat, lon, acc)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        return try NextAnswer.decode(try await send("GET", "/api/me/next", query: q + Self.h12, seen: seen))
    }

    func signal(_ action: CardAction) async throws -> NextAnswer {
        try await signal(kind: action.id, trip: action.trip)
    }

    func signal(kind: String, trip: String?) async throws -> NextAnswer {
        var body: [String: Any] = ["kind": kind]
        if let trip { body["trip"] = trip }
        return try NextAnswer.decode(
            try await send("POST", "/api/me/signal", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body)))
    }

    func step(trip: String, to: StepTarget?, dir: String?, lat: Double?, lon: Double?) async throws -> NextAnswer {
        var body: [String: Any] = ["trip": trip, "to": to?.fields ?? NSNull()]
        if let dir { body["dir"] = dir }
        if let lat, let lon {
            body["lat"] = lat
            body["lon"] = lon
        }
        return try NextAnswer.decode(
            try await send("POST", "/api/me/step", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body)))
    }

    func choice(id: String, accept: Bool) async throws {
        _ = try await send(
            "POST", "/api/me/choice", json: try JSONSerialization.data(withJSONObject: ["id": id, "choice": accept ? "accept" : "dismiss"]))
    }

    func undoChoice(trip: String, pref: String) async throws {
        _ = try await send(
            "POST", "/api/me/choice", json: JSONSerialization.data(withJSONObject: ["choice": "undo", "trip": trip, "pref": pref]))
    }

    func choices() async throws -> Choices {
        try JSONDecoder().decode(Choices.self, from: await send("GET", "/api/me/choices"))
    }

    func clearHistory() async throws {
        _ = try await send("DELETE", "/api/me/history")
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
        return try NextAnswer.decode(
            try await send(
                "POST", "/api/me/once", query: Self.coords(lat, lon, acc) + Self.h12, json: try JSONSerialization.data(withJSONObject: body)
            ))
    }

    func day(lat: Double? = nil, lon: Double? = nil, acc: Double? = nil) async throws -> (DayPlan, Data, lang: String) {
        let written = Mutex<String?>(nil)
        let data = try await send("GET", "/api/me/day", query: Self.coords(lat, lon, acc) + Self.h12) { r in
            written.withLock { $0 = r.value(forHTTPHeaderField: "content-language") }
        }
        let lang = written.withLock { $0 }?.hasPrefix("zh") == true ? "zh-Hans" : "en"
        return (try JSONDecoder().decode(DayPlan.self, from: data), data, lang)
    }

    func nearby(lat: Double?, lon: Double?, acc: Double? = nil, stopped: Bool = false) async throws -> ([NearbyStop], Data) {
        struct R: Decodable { let stops: [NearbyStop] }
        let data = try await send(
            "GET", "/api/me/nearby", query: Self.coords(lat, lon, acc) + (stopped ? [URLQueryItem(name: "stopped", value: "1")] : []))
        return (try JSONDecoder().decode(R.self, from: data).stops, data)
    }

    func board(stop: String, publicBuses: Bool = false) async throws -> Board {
        var q = [URLQueryItem(name: "stop", value: stop), URLQueryItem(name: "stopped", value: "1")]
        if publicBuses { q.append(URLQueryItem(name: "public", value: "1")) }
        var b = try JSONDecoder().decode(Board.self, from: await send("GET", "/api/arrivals", query: q))
        b.got = ServerClock.now
        return b
    }

    func line(svc: String, stop: String? = nil) async throws -> Line {
        var q = [URLQueryItem(name: "svc", value: svc)]
        if let stop { q.append(URLQueryItem(name: "stop", value: stop)) }
        var l = try JSONDecoder().decode(Line.self, from: await send("GET", "/api/line", query: q))
        l.got = ServerClock.now
        return l
    }

    func buses(svc: String) async throws -> Data {
        try await send("GET", "/api/buses", query: [URLQueryItem(name: "svc", value: svc)])
    }

    func campusJSON(etag: String? = nil) async throws -> (Data, String?)? {
        var tag: String?
        do {
            let data = try await send("GET", "/api/campus", ifNoneMatch: etag) { tag = $0.value(forHTTPHeaderField: "etag") }
            return (data, tag)
        } catch let e as ApiError where e.status == 304 {
            return nil
        }
    }

    func me() async throws -> Me {
        try JSONDecoder().decode(Me.self, from: await send("GET", "/api/me"))
    }

    func profile() async throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: await send("GET", "/api/me/profile")) as? [String: Any] ?? [:]
    }

    func saveProfile(_ profile: [String: Any]) async throws -> [String: Any] {
        let data = try await send("PUT", "/api/me/profile", json: JSONSerialization.data(withJSONObject: profile))
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    func changeProfile(_ change: @Sendable (inout [String: Any]) -> Void) async throws -> [String: Any] {
        var attempt = 0
        while true {
            attempt += 1
            let (data, tag) = try await tagged("GET", "/api/me/profile")
            var p = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
            change(&p)
            do {
                let saved = try await send("PUT", "/api/me/profile", json: JSONSerialization.data(withJSONObject: p), ifMatch: tag)
                return try JSONSerialization.jsonObject(with: saved) as? [String: Any] ?? [:]
            } catch let e as ApiError where e.status == 412 && attempt < 3 {
                continue
            }
        }
    }

    func tagged(_ method: String, _ path: String, json: Data? = nil, ifMatch: String? = nil) async throws -> (Data, String?) {
        let tag = Mutex<String?>(nil)
        let data = try await send(method, path, json: json, ifMatch: ifMatch) { http in
            let t = http.value(forHTTPHeaderField: "etag")
            tag.withLock { $0 = t }
        }
        return (data, tag.withLock { $0 })
    }

    func importTimetable(_ share: String) async throws -> ImportResult {
        let data = try await send("POST", "/api/me/import", json: JSONSerialization.data(withJSONObject: ["share": share]))
        return ImportResult(try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:])
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

    func deleteAccount() async throws {
        _ = try await send("DELETE", "/api/me")
    }

    func export() async throws -> Data {
        try await send("GET", "/api/me/export")
    }

    func registerPush(_ token: String) async throws {
        _ = try await send("POST", "/api/me/push", json: JSONSerialization.data(withJSONObject: ["token": token]))
    }

    func unregisterPush() async throws {
        _ = try await send("DELETE", "/api/me/push")
    }

    func notice() async throws -> (title: String, body: String)? {
        struct N: Decodable {
            let title: String?
            let body: String?
        }
        struct R: Decodable { let notice: N? }
        let r = try JSONDecoder().decode(R.self, from: await send("GET", "/api/me/notice"))
        guard let t = r.notice?.title, let b = r.notice?.body else { return nil }
        return (t, b)
    }

    func report(reason: String?, note: String, answer: Data?) async throws {
        try await feedback(
            kind: "wrong", note: note, reason: reason, context: answer.flatMap { try? JSONSerialization.jsonObject(with: $0) })
    }

    func feedback(note: String) async throws {
        try await feedback(kind: "other", note: note)
    }

    private func feedback(kind: String, note: String, reason: String? = nil, context: Any? = nil) async throws {
        var body: [String: Any] = ["kind": kind, "note": note, "platform": "ios", "appVersion": Api.version]
        if let reason { body["reason"] = reason }
        if let context { body["context"] = context }
        _ = try await send("POST", "/api/me/feedback", json: try JSONSerialization.data(withJSONObject: body))
    }

    func latestVersion() async throws -> String {
        struct R: Decodable { let version: String }
        let r: R = try await request("GET", "/download/latest.json")
        return r.version
    }

    static func coords(_ lat: Double?, _ lon: Double?, _ acc: Double? = nil) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        var q = [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
        if let acc, acc.isFinite { q.append(URLQueryItem(name: "acc", value: String(Int(acc.rounded())))) }
        return q
    }

    static var h12: [URLQueryItem] { Clock.hour12 ? [URLQueryItem(name: "h12", value: "1")] : [] }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil)
        async throws -> T
    {
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        return try JSONDecoder().decode(T.self, from: try await send(method, path, query: query, json: json))
    }

    func send(
        _ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil, ifNoneMatch: String? = nil, ifMatch: String? = nil,
        seen: ((HTTPURLResponse) -> Void)? = nil
    ) async throws -> Data {
        let scope = Quiet.scope(path)
        if token != nil, Outdated.gated(method, path), Outdated.active {
            throw ApiError(status: 426, message: L("Update terminus to keep using it."))
        }
        let quietUntil = Quiet.until(scope)
        if Date() < quietUntil {
            throw ApiError(status: 429, message: L("terminus is busy. Try again in a minute."), retryAfter: quietUntil.timeIntervalSinceNow)
        }
        func urlRequest(_ base: String, timeout: TimeInterval) -> URLRequest {
            var comps = URLComponents(string: base + path)!
            if !query.isEmpty { comps.queryItems = query }
            var req = URLRequest(url: comps.url!, timeoutInterval: timeout)
            req.httpMethod = method
            req.setValue("application/json", forHTTPHeaderField: "accept")
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            if let ifNoneMatch { req.setValue(ifNoneMatch, forHTTPHeaderField: "if-none-match") }
            if let ifMatch { req.setValue(ifMatch, forHTTPHeaderField: "if-match") }
            if let json {
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = json
            }
            return req
        }
        let started = Date()
        let deadline = started.addingTimeInterval(fast ? 8 : 15)
        var sent = started
        func logged(_ status: Int?, _ error: Error?) {
            RequestLog.record(
                method, path, base: Api.base, status: status, tookMs: Int(Date().timeIntervalSince(started) * 1000), failure: error)
        }
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await Servers.reach(method: method) { base in
                sent = Date()
                guard sent < deadline else { throw URLError(.timedOut) }
                return try await Self.session.data(for: urlRequest(base, timeout: max(1, deadline.timeIntervalSince(sent))))
            }
        } catch {
            logged(nil, error)
            throw error
        }
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        logged(http?.statusCode, nil)
        if let http {
            ServerClock.observe(http, sent: sent)
            seen?(http)
        }
        let retryAfter = http?.value(forHTTPHeaderField: "retry-after")
        if status == 429 { Quiet.after(retryAfter, scope: scope) }
        if status == 503 { Quiet.later(retryAfter) }
        if status == 426 { Outdated.mark() }
        if status == 304 { throw ApiError(status: 304, message: "") }
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
        if token != nil, Outdated.gated(method, path) { Outdated.served() }
        return data
    }

    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()
}
