import Foundation

/// What the map keeps on the Mac so it works offline after the first look:
/// the stops and routes (`/campus`), the map's style in each theme and
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
    /// The campus map is about 4 MB; anything this small is an error page or cut off.
    static let minTilesBytes = 64 * 1024

    /// Beside the app's token: the beta and a build pointed at a local API
    /// keep their own, so a local style never ends up in the real app's.
    static var dir: URL {
        let d = TokenStore.fileURL.deletingLastPathComponent().appendingPathComponent("map")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// `/campus`: from the network, kept; the kept copy without a connection.
    /// A refusal (signed out, or this version too old) isn't hidden by the kept copy.
    static func campus(token: String?) async throws -> CampusMap? {
        let file = dir.appendingPathComponent("campus.json")
        do {
            let data = try await get("/campus", token: token)
            if let map = CampusMap.parse(data) {
                try? data.write(to: file)
                return map
            }
        } catch let e as ApiError where e.status == 401 || e.status == 426 {
            throw e
        } catch {}
        return (try? Data(contentsOf: file)).flatMap(CampusMap.parse)
    }

    /// The style for `dark` and `zh`, as a file for MapLibre: the street map
    /// from the downloaded file, or, until it's downloaded, the routes and
    /// stops on a plain map. Never streamed: MapLibre Native fails the whole
    /// style when one fetch of a streamed map file fails, which would blank
    /// the routes too. Nil with no connection and nothing kept.
    static func style(dark: Bool, zh: Bool) async -> URL? {
        let theme = dark ? "dark" : "light", lang = zh ? "zh" : "en"
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
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["version"] != nil, o["layers"] is [Any] else { return nil }
        return o
    }

    /// What's kept about the map file: its name, ETag and when it was last checked.
    private static var meta: URL { dir.appendingPathComponent("\(tiles).json") }
    private static func readMeta() -> [String: Any]? {
        (try? Data(contentsOf: meta)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    /// The map file in use, when there is one. Before files were named by
    /// download it was `campus.pmtiles`, and that name still counts.
    static var current: URL? {
        let name = readMeta()?["file"] as? String ?? tiles
        let file = dir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// Whether the map file is on this Mac.
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
    static func dropTiles() {
        if let file = current { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: meta)
    }

    /// A style has loaded: once it's one reading the current map file, the
    /// older files are no longer read and go.
    static func styleLoaded(_ style: URL) {
        guard let file = current, let text = try? String(contentsOf: style, encoding: .utf8),
              text.contains(file.lastPathComponent) else { return }
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
        let fm = FileManager.default
        let kept = readMeta()
        let file = current
        let now = Date().timeIntervalSince1970
        if file != nil, let checked = kept?["checked"] as? Double, now - checked < checkS { return false }
        var req = URLRequest(url: URL(string: "\(Api.base)/map/\(tiles)")!, timeoutInterval: 30)
        req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
        let etag = kept?["etag"] as? String ?? ""
        if file != nil, !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "if-none-match") }
        let (tmp, resp) = try await URLSession.shared.download(for: req)
        // Whatever isn't moved into place below goes: the system leaves it otherwise.
        defer { try? fm.removeItem(at: tmp) }
        let http = resp as? HTTPURLResponse
        var name = file?.lastPathComponent ?? tiles
        var fresh = false
        switch http?.statusCode {
        case 304:
            // Kept from before files were checked: one that isn't a map goes.
            if let file, !looksLikeTiles(file) {
                dropTiles()
                throw ApiError(status: 0, message: "not a map file")
            }
        case 200:
            // A cut-off download, or a page that isn't the map (a Wi-Fi
            // sign-in page answers 200 too), must not replace a good file.
            let size = (try? fm.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? -1
            if http?.expectedContentLength ?? -1 > 0, Int64(size) != http?.expectedContentLength { throw ApiError(status: 0, message: "short download") }
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
        if let bytes = try? JSONSerialization.data(withJSONObject: ["file": name, "etag": tag, "checked": now]) { try? bytes.write(to: meta, options: .atomic) }
        return fresh
    }

    /// A GET to the API with the app's headers; the body of a 200. It keeps
    /// to the same Retry-After as the answers (Quiet) and stops with them on
    /// a 426 (Outdated): the map polls every few seconds, and asking through
    /// a 429 only keeps it tripped.
    static func get(_ path: String, token: String?) async throws -> Data {
        if token != nil, Outdated.gated("GET", path), Outdated.active { throw ApiError(status: 426, message: "HTTP 426") }
        if Date() < Quiet.until(.app) { throw ApiError(status: 429, message: "HTTP 429") }
        var req = URLRequest(url: URL(string: Api.base + path)!, timeoutInterval: 10)
        req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
        req.setValue(Lang.header, forHTTPHeaderField: "accept-language")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 429 { Quiet.after((resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "retry-after"), scope: .app) }
        if status == 426 { Outdated.mark() }
        guard status == 200 else { throw ApiError(status: status, message: "HTTP \(status)") }
        return data
    }
}
