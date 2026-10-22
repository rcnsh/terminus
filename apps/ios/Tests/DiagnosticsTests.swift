import Foundation
import Testing

@testable import Terminus

/// The developer menu's diagnostics: the same cases as Android's DiagnosticsTest and the Mac's.

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
}

@Test func aRequestWithNoAnswerSaysWhy() {
    var failed = RequestLog.Entry(at: now, method: "GET", path: "/api/me/next", host: "terminus.run", status: nil, tookMs: 2000)
    #expect(Diagnostics.outcome(failed) == "no answer")
    failed.failure = RequestLog.describe(URLError(.cannotFindHost))
    #expect(Diagnostics.outcome(failed) == "URLError -1003")
}

@Test func diagnosticTimesAreSaidPlainly() {
    #expect(Diagnostics.skew(0) == "right")
    #expect(Diagnostics.skew(42.4) == "+42 s")
    #expect(Diagnostics.skew(-5.4) == "-5 s")
    #expect(Diagnostics.ago(now.addingTimeInterval(-12), now: now) == "12 s ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-200), now: now) == "3 min ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-5 * 3600), now: now) == "5 h ago")
    #expect(Diagnostics.ago(now.addingTimeInterval(-3 * 86_400), now: now) == "3 d ago")
    // Singapore's time, whatever the phone's zone.
    #expect(Diagnostics.stamp(now) == "2026-10-18 13:06:40")
}

@Test func theReportCarriesTheStateAndTheRequests() {
    let facts = Diagnostics.Facts(
        version: "3.6.0", build: "66", channel: "stable", debug: false, ios: "iOS 26.5", device: "iPhone17,1", language: "en",
        server: "https://terminus.run", skewS: 0, signedIn: true, anonymous: true, notifications: nil, leaveAlerts: true,
        liveActivity: false, backgroundRefresh: true, pushToken: true, pushSentAt: nil, pushHeardAt: now.addingTimeInterval(-90),
        nextRefresh: nil, nextReminder: nil, answerAt: now.addingTimeInterval(-30), quality: "live", staleAt: nil, remindAt: nil,
        lastError: nil)
    let req = RequestLog.Entry(at: now, method: "GET", path: "/api/me/next", host: "terminus.run", status: 200, tookMs: 143)
    let text = Diagnostics.report(facts, requests: [req], now: now)
    #expect(text.hasPrefix("terminus: 3.6.0 (66) stable\n"))
    #expect(text.contains("signed in: anonymous\n"))
    #expect(text.contains("notifications: -\n"))
    #expect(text.contains("push heard: 1 min ago\n"))
    #expect(text.contains("answer: 30 s ago\n"))
    #expect(text.hasSuffix("13:06:40 GET /api/me/next terminus.run 200 143 ms\n"))
    #expect(Diagnostics.report(facts, requests: [], now: now).hasSuffix("requests (newest first):\nnone\n"))
}
