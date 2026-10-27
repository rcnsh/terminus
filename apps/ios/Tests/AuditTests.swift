import CoreLocation
import Foundation
import Security
import Testing

@testable import Terminus

/// The small decisions behind sideloading, the keychain, the clock, push
/// and sign-in, each on its own.

// MARK: the app group

@Test func theBuiltGroupWinsWhenItOpens() {
    let g = Shared.chooseGroup(built: "group.sh.rcn.terminus.sideload", renamed: ["group.sh.rcn.terminus.sideload.ABCDE12345"]) { _ in true
    }
    #expect(g == "group.sh.rcn.terminus.sideload")
}

@Test func altStoresRenamedGroupIsUsedWhenTheBuiltOneWont() {
    let renamed = "group.sh.rcn.terminus.sideload.ABCDE12345"
    let g = Shared.chooseGroup(built: "group.sh.rcn.terminus.sideload", renamed: ["group.other.app", renamed]) { $0 == renamed }
    #expect(g == renamed)
}

@Test func onlyAGroupRenamedFromOursIsTaken() {
    // Another app's group that happens to open isn't ours to write to.
    let g = Shared.chooseGroup(built: "group.sh.rcn.terminus", renamed: ["group.other.app"]) { $0 == "group.other.app" }
    #expect(g == "group.sh.rcn.terminus")
}

// MARK: the keychain

@Test func aLockedKeychainSaysNothingAboutTheGroup() {
    #expect(TokenStore.probeAnswer(errSecInteractionNotAllowed) == nil)
    #expect(TokenStore.probeAnswer(errSecSuccess) == true)
    #expect(TokenStore.probeAnswer(errSecDuplicateItem) == true)
    #expect(TokenStore.probeAnswer(errSecMissingEntitlement) == false)
}

// MARK: location

@Test func anOldFixIsNotFresh() {
    let now = Date()
    #expect(Locator.fresh(now.addingTimeInterval(-30), maxAge: 60, now: now))
    #expect(!Locator.fresh(now.addingTimeInterval(-3 * 3600), maxAge: 60, now: now))
}

private func fix(_ lat: Double, _ lon: Double = 103.776, acc: Double = 10, at: Date) -> CLLocation {
    CLLocation(
        coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon), altitude: 0, horizontalAccuracy: acc,
        verticalAccuracy: -1, timestamp: at)
}

@Test func withoutANewFixTheLastStandsInForTenMinutes() {
    let now = Date()
    let new = fix(1.2966, at: now)
    let fiveMin = fix(1.2970, at: now.addingTimeInterval(-5 * 60))
    let hour = fix(1.2970, at: now.addingTimeInterval(-3600))
    #expect(Locator.toSend(new, last: fiveMin, now: now) === new)
    #expect(Locator.toSend(nil, last: fiveMin, now: now) === fiveMin)
    #expect(Locator.toSend(nil, last: hour, now: now) == nil)
    #expect(Locator.toSend(nil, last: nil, now: now) == nil)
}

@Test func theNewFixAsksAgainOnlyWhenItMovesYou() {
    let now = Date()
    let sent = fix(1.2966, at: now.addingTimeInterval(-30))
    // 0.0003° of latitude is about 33 m; 0.0009° about 100 m.
    #expect(!Locator.refreshAgain(sent: sent, new: fix(1.2969, at: now)))
    #expect(Locator.refreshAgain(sent: sent, new: fix(1.2975, at: now)))
    #expect(Locator.refreshAgain(sent: nil, new: fix(1.2966, at: now)))
    #expect(!Locator.refreshAgain(sent: sent, new: nil))
    // A new fix the server would drop too brings nothing.
    #expect(!Locator.refreshAgain(sent: nil, new: fix(1.2966, acc: 500, at: now)))
    // A fallback five minutes old is one the server drops: any new fix brings the card again.
    let old = fix(1.2966, at: now.addingTimeInterval(-300))
    #expect(Locator.refreshAgain(sent: old, new: fix(1.2969, at: now), sentAt: now))
    #expect(!Locator.refreshAgain(sent: nil, new: nil))
}

@Test func anOldFixSaysHowFarYouMayHaveWalked() throws {
    let now = Date()
    #expect(fix(1.2966, acc: 12, at: now).accAt(now) == 12)
    // Five minutes at 1.3 m/s: past the server's 200 m, so it plans without it.
    let five = try #require(fix(1.2966, acc: 12, at: now.addingTimeInterval(-300)).accAt(now))
    #expect(abs(five - 402) < 0.001)
    #expect(fix(1.2966, acc: -1, at: now).accAt(now) == nil)
}

// MARK: the server's clock

private func response(date: String) -> HTTPURLResponse {
    HTTPURLResponse(
        url: URL(string: "https://terminus.run/api/me/next")!, statusCode: 200, httpVersion: nil,
        headerFields: ["date": date, "cache-control": "no-store"])!
}

@Test func theClockIsReadAtTheMiddleOfTheRequest() throws {
    let server = try #require(ServerClock.parseHTTPDate("Wed, 07 Oct 2026 01:14:02 GMT"))
    // Sent 10 s before the server's second began, answered 10 s after: the
    // middle is the server's moment, give or take its dropped half second.
    let s = try #require(
        ServerClock.skew(
            from: response(date: "Wed, 07 Oct 2026 01:14:02 GMT"),
            sent: server.addingTimeInterval(-10 - 5), received: server.addingTimeInterval(10 - 5)))
    #expect(abs(s - 5.5) < 0.001)
}

@Test func aSlowAnswerAloneIsNoWrongClock() throws {
    let server = try #require(ServerClock.parseHTTPDate("Wed, 07 Oct 2026 01:14:02 GMT"))
    // Four seconds there and back with the phone right: once, measuring at
    // the end, this read as a clock 2 s out; from the middle it's nothing.
    let s = try #require(
        ServerClock.skew(
            from: response(date: "Wed, 07 Oct 2026 01:14:02 GMT"),
            sent: server.addingTimeInterval(-1.5), received: server.addingTimeInterval(2.5)))
    #expect(s == 0)
}

// MARK: push

@Test func theProfileSaysWhichPushGateway() {
    func profile(_ env: String?) -> Data {
        let ent = env.map { "<key>aps-environment</key><string>\($0)</string>" } ?? ""
        let plist =
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><plist version=\"1.0\"><dict><key>Entitlements</key><dict>\(ent)</dict></dict></plist>"
        // A profile is the plist inside a signature: bytes either side.
        return Data([0x30, 0x80, 0x06]) + Data(plist.utf8) + Data([0xa0, 0x00])
    }
    #expect(Api.apsEnvironment(profile: profile("development")) == "development")
    #expect(Api.apsEnvironment(profile: profile("production")) == "production")
    #expect(Api.apsEnvironment(profile: profile(nil)) == nil)
    #expect(Api.apsEnvironment(profile: Data("nothing".utf8)) == nil)
}

// MARK: signing in

@Test func aRefusedPollStopsButAWaitDoesNot() {
    #expect(SignInModel.givesUp(400))
    #expect(SignInModel.givesUp(426))
    #expect(!SignInModel.givesUp(429))
    #expect(!SignInModel.givesUp(503))
}
