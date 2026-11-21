import Foundation
import Testing

@testable import Terminus

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

@Test func failuresWaitOutTheServersRetryAfter() {
    #expect(AppModel.nextDelay(failures: 1, popoverOpen: true, resting: false, plan: nil, now: now, serverWait: 30) == 30)
    #expect(AppModel.nextDelay(failures: 1, popoverOpen: true, resting: false, plan: nil, now: now, serverWait: 7200) == Quiet.maxS)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: true, resting: false, plan: nil, now: now, serverWait: 120) == 30)
}

@Test func theMapsPollsBackOff() {
    let buses = (0...5).map { MapModel.pollDelay(base: 5, failures: $0, quiet: 0) }
    #expect(buses == [5, 10, 20, 40, 60, 60])
    #expect(MapModel.pollDelay(base: 5, failures: 100, quiet: 0) == 60)
    #expect(MapModel.pollDelay(base: 15, failures: 0, quiet: 0) == 15)
    #expect(MapModel.pollDelay(base: 15, failures: 3, quiet: 0) == 60)
    #expect(MapModel.pollDelay(base: 5, failures: 0, quiet: 30) == 30)
}

@Test func theUsualWaits() {
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: true, resting: false, plan: nil, now: now) == 30)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: nil, now: now) == 300)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: true, plan: nil, now: now) == 600)
}

@Test func aBusLeavingSoonIsCheckedJustAfterButNeverUnder30s() throws {
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(departsIn: 10), now: now) == 41)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: 10), now: now) == 30)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: 120), now: now) == 120)
    #expect(AppModel.nextDelay(failures: 0, popoverOpen: false, resting: false, plan: try answer(changesIn: -5), now: now) == 300)
}

@Test func theUpdateCheckIsDailyAndOnlyOffersNewer() {
    let t = now.timeIntervalSince1970
    #expect(AppModel.updateCheck(cached: "2.1.0", checkedAt: t - 3_600, current: "2.0.0", now: t) == ("2.1.0", false))
    #expect(AppModel.updateCheck(cached: "2.1.0", checkedAt: t - 86_401, current: "2.0.0", now: t).fetch)
    #expect(AppModel.updateCheck(cached: nil, checkedAt: 0, current: "2.0.0", now: t) == (nil, true))
    #expect(AppModel.updateCheck(cached: "2.0.0", checkedAt: t - 60, current: "2.0.0", now: t).update == nil)
    #expect(AppModel.updateCheck(cached: "1.9.9", checkedAt: t - 60, current: "2.0.0", now: t).update == nil)
    #expect(isNewer("2.1.0-beta.10", than: "2.1.0-beta.9"))
    #expect(!isNewer("2.1.0-beta.9", than: "2.1.0-beta.10"))
}

@Test func goLaterStartsHalfAnHourOnToday() {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    let at = { (h: Int, m: Int) in cal.date(from: DateComponents(year: 2026, month: 8, day: 27, hour: h, minute: m))! }
    #expect(GoLater.soon(now: at(9, 2)) == at(9, 35))
    #expect(GoLater.soon(now: at(9, 0)) == at(9, 30))
    #expect(GoLater.soon(now: at(23, 20)) == at(23, 50))
    #expect(GoLater.soon(now: at(23, 27)) == at(23, 55))
    #expect(GoLater.soon(now: at(23, 40)) == at(23, 55))
}
