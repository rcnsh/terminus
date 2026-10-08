import Foundation

/// What the map keeps on the Mac so it works offline after the first look:
/// the stops and routes (`/campus`), the map's style in each theme and
/// language used, and the whole campus map file (about 4 MB). MapLibre
/// doesn't cache PMTiles it streams, so the file is downloaded once, checked
/// weekly for a newer one, and read from disk (`pmtiles://file://…`); until
/// then the map is plain. Fonts and icons go through MapLibre's own cache.
/// The same as the phone's MapFiles.kt.
enum MapFiles {
    private static let tiles = "campus.pmtiles"
    private static let checkS: TimeInterval = 7 * 24 * 3600

    /// Beside the app's token: the beta and a build pointed at a local API
    /// keep their own, so a local style never ends up in the real app's.
    static var dir: URL {
        let d = TokenStore.fileURL.deletingLastPathComponent().appendingPathComponent("map")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    /// `/campus`: from the network, kept; the kept copy without a connection.
    /// A refusal (signed out) isn't hidden by the kept copy.
    static func campus(token: String?) async throws -> CampusMap? {
        let file = dir.appendingPathComponent("campus.json")
        do {
            let data = try await get("/campus", token: token)
            if let map = CampusMap.parse(data) {
                try? data.write(to: file)
                return map
            }
        } catch let e as ApiError where e.status == 401 {
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
        var data = try? await get("/map/style.json?theme=\(theme)&lang=\(lang)", token: nil)
        if let data { try? data.write(to: kept) } else { data = try? Data(contentsOf: kept) }
        guard let data, var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let file = dir.appendingPathComponent(tiles)
        json = FileManager.default.fileExists(atPath: file.path) ? localTiles(json, path: file.path) : withoutBaseMap(json)
        // A new name each time: MapLibre doesn't reload a style URL it already shows.
        let out = dir.appendingPathComponent("shown-\(theme)-\(lang)-\(Int(Date().timeIntervalSince1970)).json")
        for old in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [] where old.hasPrefix("shown-") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(old))
        }
        guard let bytes = try? JSONSerialization.data(withJSONObject: json), (try? bytes.write(to: out)) != nil else { return nil }
        return out
    }

    /// Whether the map file is on this Mac.
    static var hasTiles: Bool { FileManager.default.fileExists(atPath: dir.appendingPathComponent(tiles).path) }

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
        let file = dir.appendingPathComponent(tiles)
        let meta = dir.appendingPathComponent("\(tiles).json")
        let kept = (try? Data(contentsOf: meta)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let now = Date().timeIntervalSince1970
        let has = FileManager.default.fileExists(atPath: file.path)
        if has, let checked = kept?["checked"] as? Double, now - checked < checkS { return false }
        var req = URLRequest(url: URL(string: "\(Api.base)/map/\(tiles)")!, timeoutInterval: 30)
        req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
        let etag = kept?["etag"] as? String ?? ""
        if has, !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "if-none-match") }
        let (tmp, resp) = try await URLSession.shared.download(for: req)
        let http = resp as? HTTPURLResponse
        var fresh = false
        switch http?.statusCode {
        case 304: break
        case 200:
            // A cut-off download must not replace a good file.
            let size = (try? FileManager.default.attributesOfItem(atPath: tmp.path)[.size] as? Int) ?? -1
            if http?.expectedContentLength ?? -1 > 0, Int64(size) != http?.expectedContentLength { throw ApiError(status: 0, message: "short download") }
            _ = try FileManager.default.replaceItemAt(file, withItemAt: tmp)
            fresh = true
        default:
            throw ApiError(status: http?.statusCode ?? 0, message: "HTTP \(http?.statusCode ?? 0)")
        }
        let tag = http?.value(forHTTPHeaderField: "etag") ?? etag
        if let bytes = try? JSONSerialization.data(withJSONObject: ["etag": tag, "checked": now]) { try? bytes.write(to: meta) }
        return fresh
    }

    /// A GET to the API with the app's headers; the body of a 200. It keeps
    /// to the same Retry-After as the answers (Quiet) and stops with them on
    /// a 426 (Outdated): the map polls every few seconds, and asking through
    /// a 429 only keeps it tripped.
    static func get(_ path: String, token: String?) async throws -> Data {
        if token != nil, Outdated.active { throw ApiError(status: 426, message: "HTTP 426") }
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
