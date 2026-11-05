import Foundation

/// `/api/campus` for everything that reads it: the map, the setup's home
/// picker, the places to go. The copy kept
/// on the Mac is used at once whatever its age, so stop names are there
/// before the network answers. It is read and parsed once, off the main
/// thread, and every reader gets that same parse. One over an hour old is
/// asked about in the background with its ETag, one check at a time; a
/// check that fails is tried again at the next look. A changed one reaches
/// each reader in place (`load`'s `changed`). With none kept, the look waits
/// for the network, one request for all readers. The phone's CampusStore.swift does the same.
@MainActor
final class CampusStore {
    static let shared = CampusStore()

    typealias Fetch = @Sendable (_ token: String?, _ etag: String?) async throws -> (Data, String?)?
    typealias Refused = @MainActor (ApiError, String?) -> Void

    private let dir: () -> URL
    private let zh: () -> Bool
    private let fetch: Fetch
    private let refused: Refused
    /// By folder and language: the copy in memory, the read of it under way, the first download.
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

    /// The campus in the app's language. While `owner` lives, a newer one
    /// found in the background goes to its `changed`. Throws only with
    /// nothing kept: a refusal, no connection, or a body that isn't the
    /// campus. A refusal the background check meets goes to `refused`, as
    /// this look's own would (by default the popover checks at once: it
    /// signs out, or offers the update).
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
            // With nothing kept no ETag goes, so the answer is a body.
            guard let (data, tag) = try await fetch(token, nil) else { throw ApiError(status: 304, message: "HTTP 304") }
            return Kept(copy: try await Self.keep(data, etag: tag, zh: zh, in: dir), savedAt: Date(), etag: tag)
        }
        waiting[key] = w
        defer { waiting[key] = nil }
        let k = try await w.value
        kept[key] = k
        return k.copy
    }

    /// The copy in memory, else the one on disk, read once however many ask at a time.
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

    /// The kept copy is over an hour old: asked about without holding anyone up.
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
                // Worded in a language no longer shown: the next look in it has it.
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

    /// A body kept once it reads as the campus: a Wi-Fi sign-in page answers 200 too.
    @concurrent nonisolated private static func keep(_ data: Data, etag: String?, zh: Bool, in dir: URL) async throws -> CampusCopy {
        guard let copy = CampusCopy.parse(data) else { throw CampusCopy.unreadable }
        MapFiles.saveCampus(data, etag: etag, zh: zh, in: dir)
        return copy
    }

    @concurrent nonisolated private static func touch(zh: Bool, in dir: URL) async { MapFiles.touchCampus(zh: zh, in: dir) }
}

/// `/api/campus` read once, in each form its readers use: the map's, the setup's, the places to go.
struct CampusCopy: Sendable {
    let map: CampusMap
    let campus: Campus?
    let destinations: [Destination]?

    static let unreadable = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not the campus"))

    /// Nil unless `data` reads as the campus.
    static func parse(_ data: Data) -> CampusCopy? {
        guard let map = CampusMap.parse(data) else { return nil }
        return CampusCopy(map: map, campus: try? JSONDecoder().decode(Campus.self, from: data), destinations: Destination.list(data))
    }
}
