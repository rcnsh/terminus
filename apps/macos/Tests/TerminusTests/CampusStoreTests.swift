import Foundation
import Testing

@testable import Terminus

/// `/api/campus` kept on the Mac: the kept copy first, whatever its age
/// (`MapFiles.CampusRead`, `CampusStore`).
private func scratch() throws -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("campus-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// A campus with one stop named `name`.
private func campus(_ name: String) -> Data {
    Data(#"{"stops":[{"code":"COM3","name":"\#(name)","lat":1.29,"lon":103.77}],"routes":{"D2":{"seq":["COM3"]}}}"#.utf8)
}

private func name(_ c: CampusCopy) -> String? { c.map.stops.first?.name }

/// A campus kept `age` seconds ago, with its ETag.
private func keep(_ data: Data, in dir: URL, age: TimeInterval, etag: String = "\"v1\"") throws {
    let file = MapFiles.campusFile(zh: false, in: dir)
    try data.write(to: file)
    try Data(etag.utf8).write(to: dir.appendingPathComponent("campus-en.etag"))
    try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-age)], ofItemAtPath: file.path)
}

private func savedAt(_ dir: URL) -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: MapFiles.campusFile(zh: false, in: dir).path))?[.modificationDate] as? Date
}

/// What the server was asked (the ETag sent each time), and an answer held until `open()`.
private actor Server {
    var asked: [String?] = []
    private var held: [CheckedContinuation<Void, Never>] = []
    private var opened: Bool

    init(holding: Bool = false) { opened = !holding }

    func ask(_ etag: String?) async {
        asked.append(etag)
        if !opened { await withCheckedContinuation { held.append($0) } }
    }

    func open() {
        opened = true
        held.forEach { $0.resume() }
        held = []
    }
}

private final class Reader {}

/// Waits a moment for `done`: the background check runs on its own.
@MainActor private func soon(_ done: () async -> Bool) async {
    for _ in 0..<200 {
        if await done() { return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

@MainActor private func store(_ dir: URL, fetch: @escaping CampusStore.Fetch) -> CampusStore {
    CampusStore(dir: { dir }, zh: { false }, fetch: fetch, refused: { _, _ in })
}

@Test func whatALookDoesByTheKeptCopysAge() {
    #expect(MapFiles.CampusRead.of(age: nil) == .wait)
    #expect(MapFiles.CampusRead.of(age: 0) == .kept)
    #expect(MapFiles.CampusRead.of(age: 3599) == .kept)
    #expect(MapFiles.CampusRead.of(age: 3600) == .keptThenCheck)
    #expect(MapFiles.CampusRead.of(age: 30 * 24 * 3600) == .keptThenCheck, "a copy of any age is still shown")
    #expect(MapFiles.CampusRead.of(age: -60) == .keptThenCheck, "a clock set back asks again")
}

@MainActor @Test func anOldCopyShowsAtOnceAndIsReplacedInPlace() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    let server = Server(holding: true)
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return (campus("COM 3"), "\"v2\"")
    }
    var changed: [String?] = []
    let reader = Reader()
    // The answer is held: the kept copy comes back without it.
    let first = try await s.load(reader, token: "t") { changed.append(name($0)) }
    #expect(name(first) == "COM3")
    #expect(changed.isEmpty)
    await server.open()
    await soon { !changed.isEmpty }
    #expect(changed == ["COM 3"])
    #expect(await server.asked == ["\"v1\""], "the ETag kept with the copy")
    #expect(MapFiles.readCampus(zh: false, in: dir)?.data == campus("COM 3"))
    #expect(MapFiles.readCampus(zh: false, in: dir)?.etag == "\"v2\"")
    // New now: not asked about again, and the new one is what a look gets.
    #expect(name(try await s.load(reader, token: "t") { _ in }) == "COM 3")
    #expect(await server.asked.count == 1)
}

@MainActor @Test func theKeptCopyIsReadOnceForEveryReader() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 60)
    let server = Server()
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return nil
    }
    #expect(name(try await s.load(Reader(), token: "t") { _ in }) == "COM3")
    // Gone from the disk: the next reader still gets it, from the one read.
    try FileManager.default.removeItem(at: MapFiles.campusFile(zh: false, in: dir))
    #expect(name(try await s.load(Reader(), token: "t") { _ in }) == "COM3")
    try await Task.sleep(for: .milliseconds(50))
    #expect(await server.asked.isEmpty, "under an hour old: not asked about")
}

@MainActor @Test func anUnchangedCampusCountsAsNewAgain() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    let server = Server()
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return nil
    }
    _ = try await s.load(Reader(), token: "t") { _ in }
    await soon { (savedAt(dir).map { Date().timeIntervalSince($0) } ?? .infinity) < 60 }
    #expect(MapFiles.CampusRead.of(age: savedAt(dir).map { Date().timeIntervalSince($0) }) == .kept)
    _ = try await s.load(Reader(), token: "t") { _ in }
    try await Task.sleep(for: .milliseconds(50))
    #expect(await server.asked.count == 1)
}

@MainActor @Test func aFailedCheckIsTriedAgainAtTheNextLook() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    let server = Server()
    let s = store(dir) { _, etag in
        await server.ask(etag)
        if await server.asked.count == 1 { throw URLError(.timedOut) }
        return nil
    }
    _ = try await s.load(Reader(), token: "t") { _ in }
    await soon { await server.asked.count == 1 }
    try await Task.sleep(for: .milliseconds(20))
    _ = try await s.load(Reader(), token: "t") { _ in }
    await soon { await server.asked.count == 2 }
    #expect(await server.asked.count == 2)
}

@MainActor @Test func oneCheckAtATime() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    let server = Server(holding: true)
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return nil
    }
    _ = try await s.load(Reader(), token: "t") { _ in }
    _ = try await s.load(Reader(), token: "t") { _ in }
    await soon { await server.asked.count == 1 }
    try await Task.sleep(for: .milliseconds(30))
    #expect(await server.asked.count == 1)
    await server.open()
}

@MainActor @Test func withNothingKeptTheLookWaits() async throws {
    let dir = try scratch()
    let server = Server()
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return (campus("COM3"), "\"v1\"")
    }
    #expect(name(try await s.load(Reader(), token: "t") { _ in }) == "COM3")
    #expect(await server.asked == [nil])
    #expect(MapFiles.readCampus(zh: false, in: dir)?.data == campus("COM3"))
}

@MainActor @Test func onlyACampusIsKept() async throws {
    let dir = try scratch()
    try keep(Data("<!DOCTYPE html><title>Sign in</title>".utf8), in: dir, age: 10)
    let server = Server()
    let s = store(dir) { _, etag in
        await server.ask(etag)
        return (Data("<!DOCTYPE html><title>Sign in</title>".utf8), nil)
    }
    // A sign-in page kept is no copy: the look waits, sends no ETag, and a sign-in page answering is no campus.
    await #expect(throws: DecodingError.self) { try await s.load(Reader(), token: "t") { _ in } }
    #expect(await server.asked == [nil])
}

@MainActor @Test func aRefusalFoundInTheBackgroundIsActedOn() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    var refused: [(Int, String?)] = []
    let s = CampusStore(
        dir: { dir }, zh: { false }, fetch: { _, _ in throw ApiError(status: 401, message: "signed out") },
        refused: { e, token in refused.append((e.status, token)) })
    #expect(name(try await s.load(Reader(), token: "t") { _ in }) == "COM3")
    await soon { !refused.isEmpty }
    #expect(refused.map(\.0) == [401])
    #expect(refused.map(\.1) == ["t"])
}

@MainActor @Test func theCopyKeptBeforeOnePerLanguageStillShowsOffline() async throws {
    let dir = try scratch()
    try campus("COM3").write(to: dir.appendingPathComponent("campus.json"))
    try Data("\"v1\"".utf8).write(to: dir.appendingPathComponent("campus.etag"))
    let server = Server()
    let s = CampusStore(
        dir: { dir }, zh: { true },
        fetch: { _, etag in
            await server.ask(etag)
            throw URLError(.notConnectedToInternet)
        }, refused: { _, _ in })
    #expect(name(try await s.load(Reader(), token: "t") { _ in }) == "COM3")
    #expect(MapFiles.readCampus(zh: true, in: dir)?.data == campus("COM3"))
    // Its language isn't known, however young it is: asked about at once, with its ETag.
    let age = MapFiles.readCampus(zh: true, in: dir)?.savedAt.map { Date().timeIntervalSince($0) }
    #expect(MapFiles.CampusRead.of(age: age) == .keptThenCheck)
    await soon { await server.asked.count == 1 }
    #expect(await server.asked == ["\"v1\""])
}

@MainActor @Test func aRefusalGoesWhereTheLookThatFoundItSays() async throws {
    let dir = try scratch()
    try keep(campus("COM3"), in: dir, age: 2 * 3600)
    var byDefault = 0
    var byTheMap: [Int] = []
    let s = CampusStore(
        dir: { dir }, zh: { false }, fetch: { _, _ in throw ApiError(status: 426, message: "update") }, refused: { _, _ in byDefault += 1 })
    _ = try await s.load(Reader(), token: "t", refused: { e, _ in byTheMap.append(e.status) }) { _ in }
    await soon { !byTheMap.isEmpty }
    #expect(byTheMap == [426])
    #expect(byDefault == 0)
}
