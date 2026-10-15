import Foundation
import Testing

@testable import Terminus

/// The developer menu's servers: the same cases as Android's ServersTest and the Mac's.

private let site = ["https://terminus.run", "https://terminus.rcn.sh"]

@Test func theSitesOwnAddressIsTheDefaultAndTheStubOnlyInDebug() {
    #expect(Servers.all(default: "https://terminus.run", backup: "https://terminus.rcn.sh", debug: false) == site)
    #expect(
        Servers.all(default: "https://terminus.run", backup: "https://terminus.rcn.sh", debug: true) == site + ["http://localhost:8787"])
}

@Test func aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
    #expect(Servers.pick("https://terminus.rcn.sh", from: site) == "https://terminus.rcn.sh")
    #expect(Servers.pick(nil, from: site) == "https://terminus.run")
    // Dropped from a later version, or written by another app (defaults write).
    #expect(Servers.pick("https://terminus.rcn.sh", from: ["https://terminus.run"]) == "https://terminus.run")
    #expect(Servers.pick("https://evil.example", from: site) == "https://terminus.run")
    #expect(Servers.pick("http://localhost:8787", from: site) == "https://terminus.run")
}

@Test func eachSiteAddressIsTheOthersBackupAndTheStubHasNone() {
    let debug = site + ["http://localhost:8787"]
    #expect(Servers.backup(of: "https://terminus.run", in: debug) == "https://terminus.rcn.sh")
    #expect(Servers.backup(of: "https://terminus.rcn.sh", in: debug) == "https://terminus.run")
    #expect(Servers.backup(of: "http://localhost:8787", in: debug) == nil)
    #expect(Servers.order("https://terminus.run", in: debug, detour: nil) == site)
    // The backup answered a moment ago: it goes first until the detour ends.
    #expect(Servers.order("https://terminus.run", in: debug, detour: "https://terminus.rcn.sh") == site.reversed())
    #expect(Servers.order("http://localhost:8787", in: debug, detour: "https://terminus.rcn.sh") == ["http://localhost:8787"])
}

@Test func onlyAServerNeverReachedIsTriedAgainElsewhere() {
    // A firewall's reset during the TLS handshake, no DNS, refused: the request never arrived.
    for method in ["GET", "POST"] {
        #expect(Servers.unreached(URLError(.secureConnectionFailed), method: method))
        #expect(Servers.unreached(URLError(.cannotFindHost), method: method))
        #expect(Servers.unreached(URLError(.cannotConnectToHost), method: method))
    }
    // Lost later: a GET can be asked again, a POST may have arrived.
    #expect(Servers.unreached(URLError(.networkConnectionLost), method: "GET"))
    #expect(!Servers.unreached(URLError(.networkConnectionLost), method: "POST"))
    // A timeout, no network at all, or anything else is never sent elsewhere.
    #expect(!Servers.unreached(URLError(.timedOut), method: "GET"))
    #expect(!Servers.unreached(URLError(.notConnectedToInternet), method: "GET"))
    #expect(!Servers.unreached(ApiError(status: 502, message: "x"), method: "GET"))
}

@Test func onlyPlainHttpToThisMacIsTheStub() {
    #expect(Servers.isLocal("http://localhost:8787"))
    #expect(Servers.isLocal("http://127.0.0.1:8787"))
    #expect(!Servers.isLocal("https://localhost:8787"))
    #expect(!Servers.isLocal("https://terminus.rcn.sh"))
    #expect(!Servers.isLocal("http://localhost.evil.example"))
}

@Test func theMenuIsAlwaysThereInDebugAndBetaBuilds() {
    #expect(Servers.menuAlways(debug: true, beta: false))
    #expect(Servers.menuAlways(debug: false, beta: true))
    #expect(!Servers.menuAlways(debug: false, beta: false))
}

@Test func theStableSiteDefaultsToItsOwnAddressWithTheOldOneAsBackup() {
    // The tests run in the Debug app, built with the stable site's addresses.
    #expect(Servers.defaultBase == "https://terminus.run")
    #expect(Servers.backupBase == "https://terminus.rcn.sh")
    #expect(Api.site == "https://terminus.run")
    #expect(Api.linkBase == "https://terminus.run")
}

@Test func theSitesTwoAddressesShareOneTokenAndTheStubKeepsItsOwn() {
    #expect(TokenStore.account(for: "https://terminus.run") == TokenStore.account(for: "https://terminus.rcn.sh"))
    #expect(TokenStore.account(for: "https://beta.terminus.run") == TokenStore.account(for: "https://beta.terminus.rcn.sh"))
    #expect(TokenStore.account(for: "http://localhost:8787") != TokenStore.account(for: "https://terminus.run"))
}

/// What every request does with [Servers.tries] (the API's and the map's): the next address only when the last was never reached.
@Test func aRequestGoesToTheBackupOnlyWhenTheFirstWasNeverReached() async throws {
    actor Asked {
        var list: [String] = []
        func add(_ s: String) { list.append(s) }
    }
    // Refused by a firewall: the backup answers, and is named as the one that did.
    var asked = Asked()
    let r = try await Servers.first(site, method: "GET") { base in
        await asked.add(base)
        if base == site[0] { throw URLError(.secureConnectionFailed) }
        return "ok"
    }
    #expect(r.at == site[1] && r.result == "ok")
    #expect(await asked.list == site)
    // Reached, but slow: never sent elsewhere.
    asked = Asked()
    await #expect(throws: URLError.self) {
        try await Servers.first(site, method: "GET") { base -> String in
            await asked.add(base)
            throw URLError(.timedOut)
        }
    }
    #expect(await asked.list == [site[0]])
    // A POST whose connection was lost may have arrived: not sent twice.
    asked = Asked()
    await #expect(throws: URLError.self) {
        try await Servers.first(site, method: "POST") { base -> String in
            await asked.add(base)
            throw URLError(.networkConnectionLost)
        }
    }
    #expect(await asked.list == [site[0]])
    // Neither reached: the last error.
    await #expect(throws: URLError(.cannotFindHost)) {
        try await Servers.first(site, method: "GET") { _ -> String in throw URLError(.cannotFindHost) }
    }
}
