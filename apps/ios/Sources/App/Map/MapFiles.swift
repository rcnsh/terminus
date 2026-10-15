import Foundation

/// What the Map tab keeps on the phone so the campus map works offline after
/// the first look: the stops and routes (`/api/campus`), the map's style in
/// each theme and language used, and the whole campus map file (about 4 MB).
/// MapLibre doesn't cache PMTiles it streams, so the file is downloaded once,
/// checked weekly for a newer one, and read from storage
/// (`pmtiles://file://…`); until then the map is plain. Fonts and icons go
/// through MapLibre's own cache. The same as Android's MapFiles.kt and the
/// Mac's MapFiles.swift.
///
/// Each download is a file of its own name (`campus-<id>.pmtiles`), named in
/// `campus.pmtiles.json`: MapLibre keeps a file's header and directories
/// once read, so a new map written over the old one, under the same URL,
/// could be read with the old file's. The old one goes once a style naming
/// the new one has loaded (`styleLoaded`).
enum MapFiles {
    private static let tiles = "campus.pmtiles"
    private static let checkS: TimeInterval = 7 * 24 * 3600
    /// `/api/campus` and the style say `max-age=3600`: a copy that young isn't asked about again.
    private static let freshS: TimeInterval = 3600
    /// The campus map is about 4 MB; anything this small is an error page or cut off.
    static let minTilesBytes = 64 * 1024

    /// One folder per server, so the dev stub's style (which names
    /// localhost) never ends up in the real app's, and the other way round.
    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("map").appendingPathComponent(folder(for: Api.base))
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            // It all comes back from the server: not worth a backup.
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            var url = base.appendingPathComponent("map")
            try? url.setResourceValues(rv)
        }
        return d
    }

    /// "terminus.rcn.sh", "localhost-8789": a server's folder name.
    static func folder(for base: String) -> String {
        guard let u = URL(string: base), let host = u.host else { return "default" }
        let name = u.port.map { "\(host)-\($0)" } ?? host
        return name.replacingOccurrences(of: #"[^A-Za-z0-9.\-]"#, with: "-", options: .regularExpression)
    }

    // MARK: the stops and routes

    /// `/api/campus`: the kept copy while it's fresh; then from the network,
    /// sent with the kept copy's ETag so an unchanged one costs no download;
    /// the kept copy without a connection. A refusal (signed out, or this
    /// version too old) isn't hidden by the kept copy.
    static func campus(token: String?) async throws -> CampusMap? {
        let file = dir.appendingPathComponent("campus.json")
        let tagFile = dir.appendingPathComponent("campus.etag")
        let kept = (try? Data(contentsOf: file)).flatMap { CampusMap.parse($0) == nil ? nil : $0 }
        if let kept, fresh(file) { return CampusMap.parse(kept) }
        do {
            let etag = kept == nil ? nil : (try? String(contentsOf: tagFile, encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
            guard let (data, tag) = try await Api(token: token).campusJSON(etag: etag) else {
                // Unchanged: the kept copy is current for another hour.
                try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
                return kept.flatMap(CampusMap.parse)
            }
            if let map = CampusMap.parse(data) {
                try? data.write(to: file, options: .atomic)
                if let tag {
                    try? Data(tag.utf8).write(to: tagFile, options: .atomic)
                } else {
                    try? FileManager.default.removeItem(at: tagFile)
                }
                return map
            }
        } catch let e as ApiError where e.status == 401 || e.status == 426 {
            throw e
        } catch {}
        return kept.flatMap(CampusMap.parse)
    }

    private static func fresh(_ file: URL) -> Bool {
        guard let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { return false }
        let age = Date().timeIntervalSince(at)
        return age >= 0 && age < freshS
    }

    // MARK: the style

    /// The style for `dark` and `zh`, as a file for MapLibre: the street map
    /// from the downloaded file, or, until it's downloaded, the routes and
    /// stops on a plain map. Never streamed: MapLibre Native fails the whole
    /// style when one fetch of a streamed map file fails, which would blank
    /// the routes too. Nil with no connection and nothing kept.
    static func style(dark: Bool, zh: Bool) async -> URL? {
        let theme = dark ? "dark" : "light"
        let lang = zh ? "zh" : "en"
        let kept = dir.appendingPathComponent("style-\(theme)-\(lang).json")
        var json = fresh(kept) ? (try? Data(contentsOf: kept)).flatMap(styleJSON) : nil
        if json == nil {
            // Kept only once it reads as a style: a Wi-Fi sign-in page answers
            // 200 too, and must not replace the copy the map falls back on.
            let fetched = try? await get("/map/style.json?theme=\(theme)&lang=\(lang)")
            json = fetched.flatMap(styleJSON)
            if let fetched, json != nil { try? fetched.write(to: kept, options: .atomic) }
        }
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

    static func styleJSON(_ data: Data) -> [String: Any]? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], o["version"] != nil, o["layers"] is [Any] else {
            return nil
        }
        return o
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

    // MARK: the map file

    /// What's kept about the map file: its name, ETag and when it was last checked.
    private static func meta(in dir: URL) -> URL { dir.appendingPathComponent("\(tiles).json") }
    private static func readMeta(in dir: URL) -> [String: Any]? {
        (try? Data(contentsOf: meta(in: dir))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    /// The map file in use, when there is one.
    static var current: URL? { currentTiles(in: dir) }

    /// The map file in use in `dir`.
    static func currentTiles(in dir: URL) -> URL? {
        let name = readMeta(in: dir)?["file"] as? String ?? tiles
        let file = dir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    /// Whether the map file is on this phone.
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

    /// Whether `style` reads a map file from storage (not the plain map).
    static func readsTiles(_ style: URL) -> Bool {
        (try? String(contentsOf: style, encoding: .utf8))?.contains(".pmtiles") == true
    }

    /// Downloads the map file if it isn't here or wasn't checked this week
    /// (only when it changed: by its ETag). True when a new file arrived.
    /// Quiet on failure; the next look tries again.
    @discardableResult
    static func keepTiles() async throws -> Bool {
        try await keepTiles(in: dir, now: Date().timeIntervalSince1970) { try await URLSession.shared.download(for: $0) }
    }

    /// `keepTiles()` in `dir` at `now` (seconds since 1970); `fetch` downloads
    /// a request to a file, as URLSession's `download(for:)` does.
    static func keepTiles(in dir: URL, now: TimeInterval, fetch: (URLRequest) async throws -> (URL, URLResponse)) async throws -> Bool {
        let fm = FileManager.default
        let kept = readMeta(in: dir)
        let file = currentTiles(in: dir)
        if file != nil, let checked = kept?["checked"] as? Double, now - checked < checkS, now >= checked { return false }
        let etag = kept?["etag"] as? String ?? ""
        // The chosen address, then the site's other one if it can't be reached (Servers.reach).
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
            // One that isn't a map goes, and the next look asks for it whole.
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
            try fm.moveItem(at: tmp, to: dir.appendingPathComponent(name))
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

    /// The style, with the app's headers; the body of a 200.
    private static func get(_ path: String) async throws -> Data {
        // The chosen address, then the site's other one if it can't be reached (Servers.reach).
        let (data, resp) = try await Servers.reach(method: "GET") { base in
            var req = URLRequest(url: URL(string: base + path)!, timeoutInterval: 10)
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            return try await URLSession.shared.data(for: req)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ApiError(status: status, message: "HTTP \(status)") }
        return data
    }
}
