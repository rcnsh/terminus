import Foundation

enum MapFiles {
    private static let tiles = "campus.pmtiles"
    private static let checkS: TimeInterval = 7 * 24 * 3600
    static let freshS: TimeInterval = 3600
    static let minTilesBytes = 64 * 1024

    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("map").appendingPathComponent(folder(for: Api.base))
        if !FileManager.default.fileExists(atPath: d.path) {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            var rv = URLResourceValues()
            rv.isExcludedFromBackup = true
            var url = base.appendingPathComponent("map")
            try? url.setResourceValues(rv)
        }
        return d
    }

    static func folder(for base: String) -> String {
        guard let u = URL(string: base), let host = u.host else { return "default" }
        let name = u.port.map { "\(host)-\($0)" } ?? host
        return name.replacingOccurrences(of: #"[^A-Za-z0-9.\-]"#, with: "-", options: .regularExpression)
    }

    enum CampusRead: Equatable {
        case kept, keptThenCheck, wait

        static func of(age: TimeInterval?) -> CampusRead {
            guard let age else { return .wait }
            return age >= 0 && age < freshS ? .kept : .keptThenCheck
        }
    }

    static func campusFile(zh: Bool, in dir: URL) -> URL { dir.appendingPathComponent("campus-\(zh ? "zh" : "en").json") }
    private static func campusTag(zh: Bool, in dir: URL) -> URL { dir.appendingPathComponent("campus-\(zh ? "zh" : "en").etag") }

    static func readCampus(zh: Bool, in dir: URL) -> (data: Data, savedAt: Date?, etag: String?)? {
        let file = campusFile(zh: zh, in: dir)
        guard let data = try? Data(contentsOf: file) else { return nil }
        let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date
        let etag = (try? String(contentsOf: campusTag(zh: zh, in: dir), encoding: .utf8)).flatMap { $0.isEmpty ? nil : $0 }
        return (data, at, etag)
    }

    static func saveCampus(_ data: Data, etag: String?, zh: Bool, in dir: URL) {
        try? data.write(to: campusFile(zh: zh, in: dir), options: .atomic)
        let tagFile = campusTag(zh: zh, in: dir)
        if let etag { try? Data(etag.utf8).write(to: tagFile, options: .atomic) } else { try? FileManager.default.removeItem(at: tagFile) }
    }

    static func touchCampus(zh: Bool, in dir: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: campusFile(zh: zh, in: dir).path)
    }

    private static func fresh(_ file: URL) -> Bool {
        guard let at = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.modificationDate] as? Date else { return false }
        let age = Date().timeIntervalSince(at)
        return age >= 0 && age < freshS
    }

    static func style(dark: Bool, zh: Bool) async -> URL? {
        let theme = dark ? "dark" : "light"
        let lang = zh ? "zh" : "en"
        let kept = dir.appendingPathComponent("style-\(theme)-\(lang).json")
        var json = fresh(kept) ? (try? Data(contentsOf: kept)).flatMap(styleJSON) : nil
        if json == nil {
            let fetched = try? await get("/map/style.json?theme=\(theme)&lang=\(lang)")
            json = fetched.flatMap(styleJSON)
            if let fetched, json != nil { try? fetched.write(to: kept, options: .atomic) }
        }
        if json == nil { json = (try? Data(contentsOf: kept)).flatMap(styleJSON) }
        guard var json else { return nil }
        json = current.map { localTiles(json, path: $0.path) } ?? withoutBaseMap(json)
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

    static func withoutBaseMap(_ style: [String: Any]) -> [String: Any] {
        var s = style
        s["sources"] = [String: Any]()
        s["layers"] = (style["layers"] as? [[String: Any]] ?? []).filter { $0["type"] as? String == "background" }
        return s
    }

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

    private static func meta(in dir: URL) -> URL { dir.appendingPathComponent("\(tiles).json") }
    private static func readMeta(in dir: URL) -> [String: Any]? {
        (try? Data(contentsOf: meta(in: dir))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    static var current: URL? { currentTiles(in: dir) }

    static func currentTiles(in dir: URL) -> URL? {
        let name = readMeta(in: dir)?["file"] as? String ?? tiles
        let file = dir.appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    static var hasTiles: Bool { current != nil }

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

    static func dropTiles(in dir: URL = MapFiles.dir) {
        if let file = currentTiles(in: dir) { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: meta(in: dir))
    }

    static func styleLoaded(_ style: URL) {
        guard let file = current, let text = try? String(contentsOf: style, encoding: .utf8),
            text.contains(file.lastPathComponent)
        else { return }
        for old in (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        where old.hasPrefix("campus") && old.hasSuffix(".pmtiles") && old != file.lastPathComponent {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(old))
        }
    }

    static func readsTiles(_ style: URL) -> Bool {
        (try? String(contentsOf: style, encoding: .utf8))?.contains(".pmtiles") == true
    }

    @discardableResult
    static func keepTiles() async throws -> Bool {
        try await keepTiles(in: dir, now: Date().timeIntervalSince1970) { try await URLSession.shared.download(for: $0) }
    }

    static func keepTiles(in dir: URL, now: TimeInterval, fetch: (URLRequest) async throws -> (URL, URLResponse)) async throws -> Bool {
        let fm = FileManager.default
        let kept = readMeta(in: dir)
        let file = currentTiles(in: dir)
        if file != nil, let checked = kept?["checked"] as? Double, now - checked < checkS, now >= checked { return false }
        let etag = kept?["etag"] as? String ?? ""
        let (tmp, resp) = try await Servers.reach(method: "GET") { base in
            var req = URLRequest(url: URL(string: "\(base)/map/\(tiles)")!, timeoutInterval: 30)
            req.setValue(Api.client, forHTTPHeaderField: "x-terminus-client")
            if file != nil, !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "if-none-match") }
            return try await fetch(req)
        }
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

    private static func get(_ path: String) async throws -> Data {
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
