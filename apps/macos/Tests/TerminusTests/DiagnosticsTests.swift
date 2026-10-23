import Foundation
import Testing

@testable import Terminus

/// The developer menu's diagnostics: the same cases as the phone's DiagnosticsTest.

private let now = Date(timeIntervalSince1970: 1_792_300_000)

/// One log for the whole app: these two run one after the other.
@Suite(.serialized) struct RequestLogTests {
    @Test func theLogKeepsThePathNeverTheQuery() {
        RequestLog.clear()
        RequestLog.record(
            "GET", "/api/me/next?lat=1.29661&lon=103.77628", base: "https://terminus.run", status: 200, tookMs: 143, failure: nil, at: now)
        let e = RequestLog.entries[0]
        #expect(e.path == "/api/me/next")
        #expect(e.host == "terminus.run")
        #expect(!Diagnostics.entry(e).contains("lat"))
    }

    @Test func theLogKeepsTheNewestFifty() {
        RequestLog.clear()
        for i in 0..<(RequestLog.max + 5) {
            RequestLog.record("GET", "/api/campus/\(i)", base: "https://terminus.run", status: 200, tookMs: 1, failure: nil, at: now)
        }
        let all = RequestLog.entries
        #expect(all.count == RequestLog.max)
        #expect(all.first?.path == "/api/campus/\(RequestLog.max + 4)")
        #expect(all.last?.path == "/api/campus/5")
    }

    @Test func theMapsRequestsAreInTheLog() async throws {
        URLProtocol.registerClass(MapAnswers.self)
        defer { URLProtocol.unregisterClass(MapAnswers.self) }
        RequestLog.clear()
        _ = try await MapFiles.get("/api/buses?svc=A1", token: nil)
        let e = RequestLog.entries.first
        #expect(e?.method == "GET")
        #expect(e?.path == "/api/buses")
        #expect(e?.status == 200)
    }
}

/// Answers the map's poll for A1's buses with an empty list.
private final class MapAnswers: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { request.url?.query == "svc=A1" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let resp = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [:])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"buses":[]}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@Test func aRequestWithNoAnswerSaysWhy() {
    var failed = RequestLog.Entry(at: now, method: "GET", path: "/api/me/next", host: "terminus.run", status: nil, tookMs: 2000)
    #expect(Diagnostics.outcome(failed) == "no answer")
    failed.failure = RequestLog.describe(URLError(.cannotFindHost))
    #expect(Diagnostics.outcome(failed) == "URLError -1003")
}

@Test func timesAreSaidPlainly() {
    #expect(Diagnostics.skew(0) == "right")
    #expect(Diagnostics.skew(42.4) == "+42 s")
    #expect(Diagnostics.skew(-5.4) == "-5 s")
    #expect(Diagnostics.ago(now.addingTimeInterval(-12), now: now) == "12 s ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-200), now: now) == "3 min ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-5 * 3600), now: now) == "5 h ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-3 * 86_400), now: now) == "3 d ago")
    // Singapore's time, whatever the Mac's zone.
    #expect(Diagnostics.stamp(now) == "2026-10-18 13:06:40")
}

@Test func theReportCarriesTheStateAndTheRequests() {
    let facts = Diagnostics.Facts(
        version: "3.6.0", build: "100", channel: "stable", debug: false, macOS: "Version 27.0", language: "en",
        server: "https://terminus.run", skewS: 0, signedIn: true, anonymous: true, notifications: nil, leaveAlerts: true,
        nextReminder: nil, answerAt: now.addingTimeInterval(-30), quality: "live", lastError: nil)
    let req = RequestLog.Entry(at: now, method: "GET", path: "/api/me/next", host: "terminus.run", status: 200, tookMs: 143)
    let text = Diagnostics.report(facts, requests: [req], now: now)
    #expect(text.hasPrefix("terminus: 3.6.0 (100) stable\n"))
    #expect(text.contains("signed in: anonymous\n"))
    #expect(text.contains("notifications: -\n"))
    #expect(text.contains("answer: 30 s ago\n"))
    #expect(text.hasSuffix("13:06:40 GET /api/me/next terminus.run 200 143 ms\n"))
    #expect(Diagnostics.report(facts, requests: [], now: now).hasSuffix("requests (newest first):\nnone\n"))
}
