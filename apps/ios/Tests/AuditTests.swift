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

// MARK: the server's clock

private func response(date: String) -> HTTPURLResponse {
    HTTPURLResponse(
        url: URL(string: "https://terminus.rcn.sh/api/me/next")!, statusCode: 200, httpVersion: nil,
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
