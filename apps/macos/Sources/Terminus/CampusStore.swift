import Foundation

@MainActor
final class CampusStore {
    static let shared = CampusStore()

    typealias Fetch = @Sendable (_ token: String?, _ etag: String?) async throws -> (Data, String?)?
    typealias Refused = @MainActor (ApiError, String?) -> Void

    private let dir: () -> URL
    private let zh: () -> Bool
    private let fetch: Fetch
    private let refused: Refused
    private var kept: [String: Kept] = [:]
    private var reading: [String: Task<Kept?, Never>] = [:]
    private var waiting: [String: Task<Kept, Error>] = [:]
    private var checking: Set<String> = []
    private var readers: [Reader] = []

    private struct Kept {
        let copy: CampusCopy
        var savedAt: Date?
        let etag: String?
    }

    private struct Reader {
        weak var owner: AnyObject?
        let changed: @MainActor (CampusCopy) -> Void
    }

    init(
        dir: @escaping () -> URL = { MapFiles.dir }, zh: @escaping () -> Bool = { Lang.zh },
        fetch: @escaping Fetch = { try await Api(token: $0).campusJSON(etag: $1) },
        refused: @escaping Refused = { _, _ in AppModel.shared.mapRefused() }
    ) {
        self.dir = dir
        self.zh = zh
        self.fetch = fetch
        self.refused = refused
    }

    func load(_ owner: AnyObject, token: String?, refused: Refused? = nil, changed: @escaping @MainActor (CampusCopy) -> Void)
        async throws -> CampusCopy
    {
        let refused = refused ?? self.refused
        readers.removeAll { $0.owner == nil || $0.owner === owner }
        readers.append(Reader(owner: owner, changed: changed))
        let zh = zh()
        let dir = dir()
        let key = "\(dir.path)|\(zh)"
        if let k = await keptCopy(key, zh: zh, in: dir) {
            if MapFiles.CampusRead.of(age: k.savedAt.map { Date().timeIntervalSince($0) }) == .keptThenCheck {
                check(key, zh: zh, in: dir, token: token, etag: k.etag, refused: refused)
            }
            return k.copy
        }
        if let w = waiting[key] { return try await w.value.copy }
        let fetch = fetch
        let w = Task { () throws -> Kept in
            guard let (data, tag) = try await fetch(token, nil) else { throw ApiError(status: 304, message: "HTTP 304") }
            return Kept(copy: try await Self.keep(data, etag: tag, zh: zh, in: dir), savedAt: Date(), etag: tag)
        }
        waiting[key] = w
        defer { waiting[key] = nil }
        let k = try await w.value
        kept[key] = k
        return k.copy
    }

    private func keptCopy(_ key: String, zh: Bool, in dir: URL) async -> Kept? {
        if let k = kept[key] { return k }
        if let r = reading[key] { return await r.value }
        let r = Task { await Self.read(zh: zh, in: dir) }
        reading[key] = r
        defer { reading[key] = nil }
        guard let k = await r.value else { return nil }
        if kept[key] == nil { kept[key] = k }
        return kept[key]
    }

    private func check(_ key: String, zh: Bool, in dir: URL, token: String?, etag: String?, refused: @escaping Refused) {
        guard !checking.contains(key) else { return }
        checking.insert(key)
        let fetch = fetch
        Task {
            defer { checking.remove(key) }
            do {
                guard let (data, tag) = try await fetch(token, etag) else {
                    await Self.touch(zh: zh, in: dir)
                    kept[key]?.savedAt = Date()
                    return
                }
                let copy = try await Self.keep(data, etag: tag, zh: zh, in: dir)
                kept[key] = Kept(copy: copy, savedAt: Date(), etag: tag)
                guard self.zh() == zh else { return }
                readers.removeAll { $0.owner == nil }
                for r in readers { r.changed(copy) }
            } catch let e as ApiError where e.status == 401 || e.status == 426 {
                refused(e, token)
            } catch {}
        }
    }

    @concurrent nonisolated private static func read(zh: Bool, in dir: URL) async -> Kept? {
        guard let r = MapFiles.readCampus(zh: zh, in: dir), let copy = CampusCopy.parse(r.data) else { return nil }
        return Kept(copy: copy, savedAt: r.savedAt, etag: r.etag)
    }

    @concurrent nonisolated private static func keep(_ data: Data, etag: String?, zh: Bool, in dir: URL) async throws -> CampusCopy {
        guard let copy = CampusCopy.parse(data) else { throw CampusCopy.unreadable }
        MapFiles.saveCampus(data, etag: etag, zh: zh, in: dir)
        return copy
    }

    @concurrent nonisolated private static func touch(zh: Bool, in dir: URL) async { MapFiles.touchCampus(zh: zh, in: dir) }
}

struct CampusCopy: Sendable {
    let map: CampusMap
    let campus: Campus?
    let destinations: [Destination]?

    static let unreadable = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not the campus"))

    static func parse(_ data: Data) -> CampusCopy? {
        guard let map = CampusMap.parse(data) else { return nil }
        return CampusCopy(map: map, campus: try? JSONDecoder().decode(Campus.self, from: data), destinations: Destination.list(data))
    }
}
