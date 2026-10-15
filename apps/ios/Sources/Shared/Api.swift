import Foundation

/// Which server the app talks to. Only ever one built in: the site's own two
/// addresses, and in a debug build the local dev stub. The developer menu
/// (Settings, About) picks one; nothing can add one, so it can't send the
/// token anywhere but our own servers.
///
/// The default is terminus.rcn.sh, not the address people see
/// (terminus.run): it's the one kept for good, so a phone that's never
/// updated keeps working whichever address the site moves to.
enum Servers {
    /// The default: TerminusAPI in the build's Info.plist (the Beta configuration's own).
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

    /// The saved choice if it's still one of [all], else the default.
    static func pick(_ saved: String?, from all: [String]) -> String {
        if let saved, all.contains(saved) { return saved }
        return all[0]
    }

    /// Plain HTTP to this Mac: the dev stub (apps/api/scripts/dev-stub.mjs), from the simulator.
    static func isLocal(_ base: String) -> Bool {
        guard let u = URL(string: base), u.scheme == "http", let host = u.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1"
    }

    /// The menu shows in debug and beta builds; in a stable release, once the
    /// version in About is tapped [unlockTaps] times.
    static func menuAlways(debug: Bool, beta: Bool) -> Bool { debug || beta }
    static let unlockTaps = 7

    static var isDebug: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    static var choices: [String] { all(default: defaultBase, site: Api.site, debug: isDebug) }
    static var current: String { pick(Shared.defaults.string(forKey: key), from: choices) }
    static var menuShown: Bool { menuAlways(debug: isDebug, beta: Api.isBeta) || Shared.defaults.bool(forKey: menuKey) }
    static func unlockMenu() { Shared.defaults.set(true, forKey: menuKey) }

    /// Saves [base]: the app starts again on it, with that server's own sign-in.
    static func choose(_ base: String) {
        guard choices.contains(base) else { return }
        Shared.defaults.set(base, forKey: key)
    }
}

struct Api: Sendable {
    static let stableSite = "https://terminus.run"
    /// The site this app belongs to, as people see it (TerminusSite in the build's Info.plist).
    static let site = Bundle.main.object(forInfoDictionaryKey: "TerminusSite") as? String ?? stableSite
    static var siteHost: String { site.replacingOccurrences(of: "https://", with: "") }
    /// Where links open (the account page, privacy, pairing): the address kept
    /// for good, as the other apps do, because NUS Wi-Fi refuses terminus.run for now.
    static let linkBase = Servers.defaultBase
    static var isBeta: Bool { site != stableSite }
    /// Where requests go: the server chosen, or TERMINUS_API_BASE for the dev stub in a debug build.
    static var base: String { devOverride("TERMINUS_API_BASE") ?? Servers.current }

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
    /// Widgets and the notification service have a few seconds, not ten.
    var fast = false

    init(token: String?, fast: Bool = false) {
        self.token = token
        self.fast = fast
    }

    /// The token this phone keeps for the current server.
    static var stored: Api { Api(token: TokenStore.read()) }

    /// This build's version ("3.0.0").
    static let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    /// `x-terminus-client`: platform and version.
    static var client: String { "ios/\(version)" }

    // MARK: signing in

    func anon(name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/auth/anon", body: ["name": name, "platform": "ios"])
        return r.token
    }

    func pair(code: String, name: String) async throws -> String {
        struct R: Decodable { let token: String }
        let r: R = try await request("POST", "/api/pair", body: ["code": code, "name": name])
        return r.token
    }

    /// Whose account a pairing code belongs to (masked), without spending it.
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

    /// After a "choose" outcome: keep the account's setup, or this phone's.
    func merge(anon: String, keepDevice: Bool) async throws {
        _ = try await send(
            "POST", "/api/auth/app/merge",
            json: JSONSerialization.data(withJSONObject: ["anon": anon, "keep": keepDevice ? "device" : "account"]))
    }

    func logout() async throws {
        _ = try await send("POST", "/api/auth/logout", json: Data("{}".utf8))
    }

    // MARK: answers

    func next(_ target: Target, lat: Double?, lon: Double?, acc: Double? = nil) async throws -> NextAnswer {
        var q = Self.coords(lat, lon, acc)
        switch target {
        case .plan: break
        case .place(let key): q.append(URLQueryItem(name: "place", value: key))
        case .code(let code, _): q.append(URLQueryItem(name: "to", value: code))
        }
        return try NextAnswer.decode(try await send("GET", "/api/me/next", query: q + Self.h12))
    }

    /// Something that happened on the trip; answers with the new planned answer.
    func signal(_ action: CardAction) async throws -> NextAnswer {
        try await signal(kind: action.id, trip: action.trip)
    }

    func signal(kind: String, trip: String?) async throws -> NextAnswer {
        var body: [String: Any] = ["kind": kind]
        if let trip { body["trip"] = trip }
        return try NextAnswer.decode(
            try await send("POST", "/api/me/signal", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body)))
    }

    /// A suggestion accepted or turned down.
    func choice(id: String, accept: Bool) async throws {
        _ = try await send(
            "POST", "/api/me/choice", json: try JSONSerialization.data(withJSONObject: ["id": id, "choice": accept ? "accept" : "dismiss"]))
    }

    /// A class's "one bus earlier" or "no reminders" undone.
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

    /// A one-off trip later today, planned like a class. Answers with the new plan.
    func once(_ target: Target, atMin: Int) async throws -> NextAnswer {
        var body: [String: Any] = ["atMin": atMin]
        switch target {
        case .plan: break
        case .place(let key): body["place"] = key
        case .code(let code, let label):
            body["to"] = code
            body["label"] = label
        }
        return try NextAnswer.decode(
            try await send("POST", "/api/me/once", query: Self.h12, json: try JSONSerialization.data(withJSONObject: body)))
    }

    /// Today: each class with its leave-by, and the trips home. The JSON too, kept for offline.
    func day(lat: Double? = nil, lon: Double? = nil, acc: Double? = nil) async throws -> (DayPlan, Data) {
        let data = try await send("GET", "/api/me/day", query: Self.coords(lat, lon, acc) + Self.h12)
        return (try JSONDecoder().decode(DayPlan.self, from: data), data)
    }

    /// /me/nearby's stops, nearest first, and the JSON for the widget. With
    /// `stopped`, the services not running now too (the Buses tab greys them).
    func nearby(lat: Double?, lon: Double?, acc: Double? = nil, stopped: Bool = false) async throws -> ([NearbyStop], Data) {
        struct R: Decodable { let stops: [NearbyStop] }
        let data = try await send(
            "GET", "/api/me/nearby", query: Self.coords(lat, lon, acc) + (stopped ? [URLQueryItem(name: "stopped", value: "1")] : []))
        return (try JSONDecoder().decode(R.self, from: data).stops, data)
    }

    /// What's coming at one stop: every row, and the services not running now.
    func board(stop: String, publicBuses: Bool = false) async throws -> Board {
        var q = [URLQueryItem(name: "stop", value: stop), URLQueryItem(name: "stopped", value: "1")]
        if publicBuses { q.append(URLQueryItem(name: "public", value: "1")) }
        var b = try JSONDecoder().decode(Board.self, from: await send("GET", "/api/arrivals", query: q))
        b.got = ServerClock.now
        return b
    }

    /// One service's whole line; with `stop`, that stop's board row for it too.
    func line(svc: String, stop: String? = nil) async throws -> Line {
        var q = [URLQueryItem(name: "svc", value: svc)]
        if let stop { q.append(URLQueryItem(name: "stop", value: stop)) }
        var l = try JSONDecoder().decode(Line.self, from: await send("GET", "/api/line", query: q))
        l.got = ServerClock.now
        return l
    }

    /// One service's live buses, for the map (BusList).
    func buses(svc: String) async throws -> Data {
        try await send("GET", "/api/buses", query: [URLQueryItem(name: "svc", value: svc)])
    }

    /// `/api/campus` as it came, with its ETag; nil when `etag` says the kept copy is current.
    func campusJSON(etag: String? = nil) async throws -> (Data, String?)? {
        var tag: String?
        do {
            let data = try await send("GET", "/api/campus", ifNoneMatch: etag) { tag = $0.value(forHTTPHeaderField: "etag") }
            return (data, tag)
        } catch let e as ApiError where e.status == 304 {
            return nil
        }
    }

    func campus() async throws -> Campus {
        try JSONDecoder().decode(Campus.self, from: await send("GET", "/api/campus"))
    }

    // MARK: the account

    func me() async throws -> Me {
        try JSONDecoder().decode(Me.self, from: await send("GET", "/api/me"))
    }

    /// The profile as the server keeps it, as JSON so fields this version doesn't know survive a save.
    func profile() async throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: await send("GET", "/api/me/profile")) as? [String: Any] ?? [:]
    }

    /// Saves the whole profile; answers with it as saved.
    func saveProfile(_ profile: [String: Any]) async throws -> [String: Any] {
        let data = try await send("PUT", "/api/me/profile", json: JSONSerialization.data(withJSONObject: profile))
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    /// Imports a NUSMods share link; the server replaces the imported classes only if it all worked.
    func importTimetable(_ share: String) async throws -> ImportResult {
        let data = try await send("POST", "/api/me/import", json: JSONSerialization.data(withJSONObject: ["share": share]))
        return ImportResult(try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:])
    }

    /// A pairing code for another device (accounts with an email only).
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

    /// An account without an email: everything goes.
    func deleteAccount() async throws {
        _ = try await send("DELETE", "/api/me")
    }

    func export() async throws -> Data {
        try await send("GET", "/api/me/export")
    }

    /// This phone's push token, so the server can say when the card changes:
    /// `apns:` and the token in hex, with `sandbox` for a development build.
    func registerPush(_ token: String) async throws {
        _ = try await send("POST", "/api/me/push", json: JSONSerialization.data(withJSONObject: ["token": token]))
    }

    func unregisterPush() async throws {
        _ = try await send("DELETE", "/api/me/push")
    }

    /// The new semester's reminder, worded on the server, for a push that says only `kind: term`.
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

    /// "Is this wrong?": the answer as it came, with a reason, a note, or both.
    func report(reason: String?, note: String, answer: Data?) async throws {
        try await feedback(
            kind: "wrong", note: note, reason: reason, context: answer.flatMap { try? JSONSerialization.jsonObject(with: $0) })
    }

    /// Send feedback: a note about anything, emailed to the operator.
    func feedback(note: String) async throws {
        try await feedback(kind: "other", note: note)
    }

    private func feedback(kind: String, note: String, reason: String? = nil, context: Any? = nil) async throws {
        var body: [String: Any] = ["kind": kind, "note": note, "platform": "ios", "appVersion": Api.version]
        if let reason { body["reason"] = reason }
        if let context { body["context"] = context }
        _ = try await send("POST", "/api/me/feedback", json: try JSONSerialization.data(withJSONObject: body))
    }

    /// The released version, from /download/latest.json.
    func latestVersion() async throws -> String {
        struct R: Decodable { let version: String }
        let r: R = try await request("GET", "/download/latest.json")
        return r.version
    }

    /// Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and no
    /// more precise than that in URLs that pass through logs. `acc` is how far
    /// out the fix may be: the server treats one past 200 m as no location.
    static func coords(_ lat: Double?, _ lon: Double?, _ acc: Double? = nil) -> [URLQueryItem] {
        guard let lat, let lon else { return [] }
        let f = { (v: Double) in String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), v) }
        var q = [URLQueryItem(name: "lat", value: f(lat)), URLQueryItem(name: "lon", value: f(lon))]
        if let acc, acc.isFinite { q.append(URLQueryItem(name: "acc", value: String(Int(acc.rounded())))) }
        return q
    }

    /// The card's clock times in this phone's 12- or 24-hour style.
    static var h12: [URLQueryItem] { Clock.hour12 ? [URLQueryItem(name: "h12", value: "1")] : [] }

    private func request<T: Decodable>(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil)
        async throws -> T
    {
        let json = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        return try JSONDecoder().decode(T.self, from: try await send(method, path, query: query, json: json))
    }

    /// The response body of a 2xx; anything else throws with the server's message.
    func send(
        _ method: String, _ path: String, query: [URLQueryItem] = [], json: Data? = nil, ifNoneMatch: String? = nil,
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
        var comps = URLComponents(string: Api.base + path)!
        if !query.isEmpty { comps.queryItems = query }
        var req = URLRequest(url: comps.url!, timeoutInterval: fast ? 8 : 15)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")
        req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
        req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let ifNoneMatch { req.setValue(ifNoneMatch, forHTTPHeaderField: "if-none-match") }
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = json
        }
        let (data, resp) = try await Self.session.data(for: req)
        let http = resp as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        if let http {
            ServerClock.observe(http)
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

    /// No cache of its own: every answer is fresh, and the edge caches what can be.
    private static let session: URLSession = {
        let c = URLSessionConfiguration.default
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.waitsForConnectivity = false
        return URLSession(configuration: c)
    }()
}
