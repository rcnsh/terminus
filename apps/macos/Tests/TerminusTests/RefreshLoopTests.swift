import Foundation
import Testing
@testable import Terminus

/// How long the Mac's refresh loop waits: `AppModel.nextDelay`.
private let now = Date(timeIntervalSince1970: 1_790_000_000)

private func answer(departsIn: TimeInterval? = nil, changesIn: TimeInterval? = nil, mode: String = "trip") throws -> NextAnswer {
    let iso = { (s: TimeInterval) in "\"\(ISO8601DateFormatter().string(from: now.addingTimeInterval(s)))\"" }
    let json = """
    {"label":"D2 · 4 min","quality":"live","mode":"\(mode)","departsAt":\(departsIn.map(iso) ?? "null"),
     "card":{"kind":"trip","nextChangeAt":\(changesIn.map(iso) ?? "null")}}
    """
    return try JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
}

@Test func failuresRetrySoonThenBackOff() {
    let delays = (1...4).map { AppModel.nextDelay(failures: $0, popoverOpen: false, resting: false, plan: nil, now: now) }
    #expect(delays == [5, 15, 45, 300])
}

@Test func theUsualWaits() {
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: true, resting: false, plan: nil, now: now) == 30)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: nil, now: now) == 300)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: true, plan: nil, now: now) == 600)
}

@Test func aBusLeavingSoonIsCheckedJustAfterButNeverUnder30s() throws {
    // Half a minute after it leaves: 10 + 31 s.
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(departsIn: 10), now: now) == 41)
    // The card changing in 10 s still waits 30 s.
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: 10), now: now) == 30)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: 120), now: now) == 120)
    // A time already past doesn't count.
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: -5), now: now) == 300)
}
