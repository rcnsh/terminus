import Foundation

/// What the map keeps on the Mac so it works offline after the first look:
/// the stops and routes (`/api/campus`, which the pickers read too, through
/// CampusStore), the map's style in each theme and
/// language used, and the whole campus map file (about 4 MB). MapLibre
/// doesn't cache PMTiles it streams, so the file is downloaded once, checked
/// weekly for a newer one, and read from disk (`pmtiles://file://…`); until
/// then the map is plain. Fonts and icons go through MapLibre's own cache.
/// The same as the phone's MapFiles.kt.
///
/// Each download is a file of its own name (`campus-<id>.pmtiles`), named in
/// `campus.pmtiles.json`: MapLibre keeps a file's header and directories
/// once read, so a new map written over the old one, under the same URL,
/// could be read with the old file's. The old one goes once a style naming
/// the new one has loaded (`styleLoaded`).
enum MapFiles {
    private static let tiles = "campus.pmtiles"
    private static let checkS: TimeInterval = 7 * 24 * 3600
    /// `/api/campus` says `max-age=3600`: a copy that young isn't asked about again.
    static let freshS: TimeInterval = 3600
    /// The campus map is about 4 MB; anything this small is an error page or cut off.
    static let minTilesBytes = 64 * 1024

    /// Beside the app's token: the beta and a build pointed at a local API
    /// keep their own, so a local style never ends up in the real app's.
    static var dir: URL {
        let d = TokenStore.fileURL.deletingLastPathComponent().appendingPathComponent("map")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// What a look at `/api/campus` does, by the age of the copy kept: a
    /// copy of any age shows at once, and one over an hour old is asked
    /// about in the background (CampusStore); with none, it waits for the
    /// network.
    enum CampusRead: Equatable {
        case kept, keptThenCheck, wait

        static func of(age: TimeInterval?) -> CampusRead {
            guard let age else { return .wait }
            return age >= 0 && age < freshS ? .kept : .keptThenCheck
        }
    }

    /// A copy per language: the server words the stops and lines in the one asked in.
    static func campusFile(zh: Bool, in dir: URL) -> URL { dir.appendingPathComponent("campus-\(zh ? "zh" : "en").json") }
    private static func campusTag(zh: Bool, in dir: URL) -> URL { dir.appendingPathComponent("campus-\(zh ? "zh" : "en").etag") }

    /// The copy kept in `dir` as saved: its body, when it was saved or last
    /// found current, and its ETag. Read as the campus by CampusStore, once.
    static func readCampus(zh: Bool, in dir: URL) -> (data: Data, savedAt: Date?, etag: String?)? {
        let file = campusFile(zh: zh, in: dir)
        // The one copy kept before there was one per language becomes this
        // language's, so an update opened offline still has it. Its language
        // isn't known, so it's due a check at once: worded in the other one,
        // its ETag doesn't match and it's replaced.
        let old = dir.appendingPathComponent("campus.json")
        if !FileManager.default.fileExists(atPath: file.path), FileManager.default.fileExists(atPath: old.path) {
            try? FileManager.default.moveItem(at: old, to: file)
            try? FileManager.default.moveItem(at: dir.appendingPathComponent("campus.etag"), to: campusTag(zh: zh, in: dir))
            try? FileManager.default.setAttributes([.modificationDate: Date.distantPast], ofItemAtPath: file.path)
        }
        guard let data = try? Data(contentsOf: file) else { return nil }
        let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
        let etag = (try? String(contentsOf: campusTag(zh: zh, in: dir), encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
        return (data, at, etag)
    }

    /// Keeps a body that read as the campus, with its ETag.
    static func saveCampus(_ data: Data, etag: String?, zh: Bool, in dir: URL) {
        try? data.write(to: campusFile(zh: zh, in: dir), options: .atomic)
        let tagFile = campusTag(zh: zh, in: dir)
        if let etag { try? Data(etag.utf8).write(to: tagFile, options: .atomic) } else { try? FileManager.default.removeItem(at: tagFile) }
    }

    /// The server said the kept copy is current: it counts as new for another hour.
    static func touchCampus(zh: Bool, in dir: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: campusFile(zh: zh, in: dir).path)
    }

    /// The style for `dark` and `zh`, as a file for MapLibre: the street map
    /// from the downloaded file, or, until it's downloaded, the routes and
    /// stops on a plain map. Never streamed: MapLibre Native fails the whole
    /// style when one fetch of a streamed map file fails, which would blank
    /// the routes too. Nil with no connection and nothing kept.
    static func style(dark: Bool, zh: Bool) async -> URL? {
        let theme = dark ? "dark" : "light"
        let lang = zh ? "zh" : "en"
        let kept = dir.appendingPathComponent("style-\(theme)-\(lang).json")
        // Kept only once it reads as a style: a Wi-Fi sign-in page answers
        // 200 too, and must not replace the copy the map falls back on.
        let fetched = try? await get("/map/style.json?theme=\(theme)&lang=\(lang)", token: nil)
        var json = fetched.flatMap(styleJSON)
        if let fetched, json != nil { try? fetched.write(to: kept, options: .atomic) }
        if json == nil { json = (try? Data(contentsOf: kept)).flatMap(styleJSON) }
        guard var json else { return nil }
        json = current.map { localTiles(json, path: $0.path) } ?? withoutBaseMap(json)
        // A new name each time: MapLibre doesn't reload a style URL it already shows.
        let out = dir.appendingPathComponent("shown-\(theme)-\(lang)-\(UUID().uuidString).json")
        for old in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where old.hasPrefix("shown-") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(old))
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: json), (try? bytes.write(to: out)) != nil else { return nil }
        return out
    }

    private static func styleJSON(_ data: Data) -> [String: Any]? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["version"] != nil, o["layers"] is [Any] else {
            return nil
        }
        return o
    }

    /// What's kept about the map file: its name, ETag and when it was last checked.
    private static func meta(in dir: URL) -> URL { dir.appendingPathComponent("\(tiles).json") }
    private static func readMeta(in dir: URL) -> [String: Any]? {
        (try? Data(contentsOf: meta(in: dir))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    /// The map file in use, when there is one.
    static var current: URL? { currentTiles(in: dir) }

    /// The map file in use in `dir`. Before files were named by download it
    /// was `campus.pmtiles`, and that name still counts.
    static func currentTiles(in dir: URL) -> URL? {
        let name = readMeta(in: dir)?["file"] as? String ?? tiles
        let file = dir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    static var hasTiles: Bool { current != nil }

    /// Whether `head` (the file's first bytes) starts a PMTiles version 3
    /// archive, and the file is big enough to be the campus map.
    static func isPMTiles(_ head: Data, size: Int) -> Bool {
        size >= minTilesBytes && head.count >= 8 && head.prefix(7) == Data("PMTiles".utf8) && head[head.startIndex + 7] == 3
    }

    static func looksLikeTiles(_ file: URL) -> Bool {
        guard let h = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? h.close() }
        let head = (try? h.read(upToCount: 8)) ?? Data()
        let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int) ?? 0
        return isPMTiles(head, size: size)
    }

    /// The map file and what's kept about it, gone: MapLibre couldn't read
    /// it. The map is plain until the next look downloads it again.
    static func dropTiles(in dir: URL = MapFiles.dir) {
        if let file = currentTiles(in: dir) { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: meta(in: dir))
    }

    /// A style has loaded: once it's one reading the current map file, the
    /// older files are no longer read and go.
    static func styleLoaded(_ style: URL) {
        guard let file = current, let text = try? String(contentsOf: style, encoding: .utf8),
            text.contains(file.lastPathComponent)
        else { return }
        for old in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        where old.hasPrefix("campus") && old.hasSuffix(".pmtiles") && old != file.lastPathComponent {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(old))
        }
    }

    /// Whether `style` reads a map file from disk (not the plain map).
    static func readsTiles(_ style: URL) -> Bool {
        (try? String(contentsOf: style, encoding: .utf8))?.contains(".pmtiles") == true
    }

    /// The style with only its background: no map file, no street layers.
    static func withoutBaseMap(_ style: [String: Any]) -> [String: Any] {
        var s = style
        s["sources"] = [String: Any]()
        s["layers"] = (style["layers"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "background" }
        return s
    }

    /// The style with its map file read from `path` instead of the network,
    /// as a proper file URL: Application Support has a space in it.
    static func localTiles(_ style: [String: Any], path: String) -> [String: Any] {
        var s = style
        guard var sources = style["sources"] as? [String: Any] else { return style }
        for (key, value) in sources {
            guard var src = value as? [String: Any], (src["url"] as? String)?.hasPrefix("pmtiles://http") == true else { continue }
            src["url"] = "pmtiles://" + URL(fileURLWithPath: path).absoluteString
            sources[key] = src
        }
        s["sources"] = sources
        return s
    }

    /// Downloads the map file if it isn't here or wasn't checked this week
    /// (only when it changed: by its ETag). True when a new file arrived.
    /// Quiet on failure; the next look tries again.
    @discardableResult
    static func keepTiles() async throws -> Bool {
        try await keepTiles(in: dir, now: Date().timeIntervalSince1970) { req in
            try await logged(req) { try await URLSession.shared.download(for: req) }
        }
    }

    /// `keepTiles()` in `dir` at `now` (seconds since 1970); `fetch` downloads
    /// a request to a file, as URLSession's `download(for:)` does.
    static func keepTiles(in dir: URL, now: TimeInterval, fetch: (URLRequest) async throws -> (URL, URLResponse)) async throws -> Bool {
        let fm = FileManager.default
        let kept = readMeta(in: dir)
        let file = currentTiles(in: dir)
        if file != nil, let checked = kept?["checked"] as? Double, now - checked < checkS { return false }
        let etag = kept?["etag"] as? String ?? ""
        let (tmp, resp) = try await Servers.reach(method: "GET") { base in
            var req = URLRequest(url: URL(string: "\(base)/map/\(tiles)")!, timeoutInterval: 30)
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            if file != nil, !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "if-none-match") }
            return try await fetch(req)
        }
        // Whatever isn't moved into place below goes: the system leaves it otherwise.
        defer { try? fm.removeItem(at: tmp) }
        let http = resp as? HTTPURLResponse
        var name = file?.lastPathComponent ?? tiles
        var fresh = false
        switch http?.statusCode {
        case 304:
            if let file, !looksLikeTiles(file) {
                dropTiles(in: dir)
                throw ApiError(status: 0, message: "not a map file")
            }
        case 200:
            // A cut-off download, or a page that isn't the map (a Wi-Fi
            // sign-in page answers 200 too), must not replace a good file.
            let size = (try? fm.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? -1
            if http?.expectedContentLength ?? -1 > 0, Int64(size) != http?.expectedContentLength {
                throw ApiError(status: 0, message: "short download")
            }
            guard looksLikeTiles(tmp) else { throw ApiError(status: 0, message: "not a map file") }
            name = "campus-\(UUID().uuidString).pmtiles"
            var dest = dir.appendingPathComponent(name)
            try fm.moveItem(at: tmp, to: dest)
            // 4 MB that comes back from the server: not worth a backup.
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            try? dest.setResourceValues(rv)
            fresh = true
        default:
            throw ApiError(status: http?.statusCode ?? 0, message: "HTTP \(http?.statusCode ?? 0)")
        }
        let tag = http?.value(forHTTPHeaderField: "etag") ?? etag
        if let bytes = try? JSONSerialization.data(withJSONObject: ["file": name, "etag": tag, "checked": now]) {
            try? bytes.write(to: meta(in: dir), options: .atomic)
        }
        return fresh
    }

    /// `fetch`, noted in the developer menu's recent requests (RequestLog) as the app's other requests are.
    private static func logged<T>(_ req: URLRequest, _ fetch: () async throws -> (T, URLResponse)) async throws -> (T, URLResponse) {
        let started = Date()
        func note(_ status: Int?, _ error: Error?) {
            RequestLog.record(
                req.httpMethod ?? "GET", req.url?.path ?? "", base: req.url?.absoluteString ?? "", status: status,
                tookMs: Int(Date().timeIntervalSince(started) * 1000), failure: error)
        }
        do {
            let (body, resp) = try await fetch()
            note((resp as? HTTPURLResponse)?.statusCode, nil)
            return (body, resp)
        } catch {
            note(nil, error)
            throw error
        }
    }

    /// A GET to the API with the app's headers; the body of a 200. It keeps
    /// to the same Retry-After as the answers (Quiet) and stops with them on
    /// a 426 (Outdated): the map polls every few seconds, and asking through
    /// a 429 only keeps it tripped. A 503's Retry-After is noted for the map's
    /// polling loops (`Quiet.later`).
    static func get(_ path: String, token: String?) async throws -> Data {
        if token != nil, Outdated.gated("GET", path), Outdated.active { throw ApiError(status: 426, message: "HTTP 426") }
        if Date() < Quiet.until(.app) { throw ApiError(status: 429, message: "HTTP 429") }
        let (data, resp) = try await Servers.reach(method: "GET") { base in
            var req = URLRequest(url: URL(string: base + path)!, timeoutInterval: 10)
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
            if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
            return try await logged(req) { try await URLSession.shared.data(for: req) }
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let retryAfter = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after")
        if status == 429 { Quiet.after(retryAfter, scope: .app) }
        if status == 503 { Quiet.later(retryAfter) }
        if status == 426 { Outdated.mark() }
        guard status == 200 else { throw ApiError(status: status, message: "HTTP \(status)") }
        return data
    }
}
