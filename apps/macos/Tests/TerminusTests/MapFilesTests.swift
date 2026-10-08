import Foundation
import Testing
@testable import Terminus

/// The map file kept on the Mac: `MapFiles.keepTiles(in:now:fetch:)`.
private let day: TimeInterval = 24 * 3600
private let now: TimeInterval = 1_790_000_000

private func scratch() throws -> URL {
    let d = FileManager.default.temporaryDirectory.appendingPathComponent("map-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
    return d
}

/// A server answering `code` with `body`; `length` is its Content-Length. Notes what it was asked.
private final class Server: @unchecked Sendable {
    let code: Int, body: String, etag: String?, length: Int?
    var asked: [URLRequest] = []
    init(_ code: Int, _ body: String = "", etag: String? = "\"v2\"", length: Int? = nil) {
        self.code = code; self.body = body; self.etag = etag; self.length = length ?? body.utf8.count
    }
    func fetch(_ req: URLRequest) throws -> (URL, URLResponse) {
        asked.append(req)
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try Data(body.utf8).write(to: tmp)
        var headers: [String: String] = [:]
        if let etag { headers["ETag"] = etag }
        if code == 200, let length { headers["Content-Length"] = "\(length)" }
        return (tmp, HTTPURLResponse(url: req.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!)
    }
}

private func keep(_ dir: URL, _ s: Server, at t: TimeInterval = now) async throws -> Bool {
    try await MapFiles.keepTiles(in: dir, now: t) { try s.fetch($0) }
}

private func kept(_ dir: URL, checked: TimeInterval, etag: String = "\"v1\"") throws {
    try Data("old map".utf8).write(to: dir.appendingPathComponent("campus.pmtiles"))
    try JSONSerialization.data(withJSONObject: ["etag": etag, "checked": checked]).write(to: dir.appendingPathComponent("campus.pmtiles.json"))
}

private func read(_ dir: URL) -> String? { (try? String(contentsOf: dir.appendingPathComponent("campus.pmtiles"), encoding: .utf8)) }
private func meta(_ dir: URL) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("campus.pmtiles.json")))) as? [String: Any] ?? [:]
}

@Test func theFirstMapIsDownloaded() async throws {
    let dir = try scratch()
    let s = Server(200, "new map")
    #expect(try await keep(dir, s))
    #expect(s.asked.first?.value(forHTTPHeaderField: "if-none-match") == nil)
    #expect(read(dir) == "new map")
    #expect(meta(dir)["etag"] as? String == "\"v2\"")
    #expect(meta(dir)["checked"] as? Double == now)
}

@Test func aMapCheckedThisWeekIsNotAskedAbout() async throws {
    let dir = try scratch()
    try kept(dir, checked: now - 6 * day)
    let s = Server(200, "new map")
    #expect(try await !keep(dir, s))
    #expect(s.asked.isEmpty)
    #expect(read(dir) == "old map")
}

@Test func anUnchangedMapIsKeptAndCheckedAgainInAWeek() async throws {
    let dir = try scratch()
    try kept(dir, checked: now - 8 * day)
    let s = Server(304, etag: nil)
    #expect(try await !keep(dir, s))
    #expect(s.asked.first?.value(forHTTPHeaderField: "if-none-match") == "\"v1\"")
    #expect(read(dir) == "old map")
    #expect(meta(dir)["checked"] as? Double == now)
    #expect(meta(dir)["etag"] as? String == "\"v1\"")
}

@Test func aCutOffDownloadLeavesTheOldMap() async throws {
    let dir = try scratch()
    try kept(dir, checked: now - 8 * day)
    await #expect(throws: ApiError.self) { try await keep(dir, Server(200, "new m", length: 7)) }
    #expect(read(dir) == "old map")
    #expect(meta(dir)["checked"] as? Double == now - 8 * day)
}

@Test func anErrorKeepsTheOldMap() async throws {
    let dir = try scratch()
    try kept(dir, checked: now - 8 * day)
    await #expect(throws: ApiError.self) { try await keep(dir, Server(503)) }
    #expect(read(dir) == "old map")
}
