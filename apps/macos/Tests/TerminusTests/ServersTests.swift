import Foundation
import Testing

@testable import Terminus

private let site = ["https://terminus.run", "https://terminus.rcn.sh"]

@Test func theSitesOwnAddressIsTheDefaultAndTheStubOnlyInDebug() {
    #expect(Servers.all(default: "https://terminus.run", backup: "https://terminus.rcn.sh", debug: false) == site)
    #expect(
        Servers.all(default: "https://terminus.run", backup: "https://terminus.rcn.sh", debug: true) == site + ["http://localhost:8787"])
}

@Test func aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
    #expect(Servers.pick("https://terminus.rcn.sh", from: site) == "https://terminus.rcn.sh")
    #expect(Servers.pick(nil, from: site) == "https://terminus.run")
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
    #expect(Servers.order("https://terminus.run", in: debug, detour: "https://terminus.rcn.sh") == site.reversed())
    #expect(Servers.order("http://localhost:8787", in: debug, detour: "https://terminus.rcn.sh") == ["http://localhost:8787"])
}

@Test func onlyAServerNeverReachedIsTriedAgainElsewhere() {
    for method in ["GET", "POST"] {
        #expect(Servers.unreached(URLError(.secureConnectionFailed), method: method))
        #expect(Servers.unreached(URLError(.cannotFindHost), method: method))
        #expect(Servers.unreached(URLError(.cannotConnectToHost), method: method))
    }
    #expect(Servers.unreached(URLError(.networkConnectionLost), method: "GET"))
    #expect(!Servers.unreached(URLError(.networkConnectionLost), method: "POST"))
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

@Test func theStableSiteDefaultsToItsOwnAddressWithNoBackup() {
    #expect(Servers.defaultBase == "https://terminus.run")
    #expect(Servers.backupBase == nil)
    #expect(Servers.all(default: Servers.defaultBase, backup: nil, debug: false) == ["https://terminus.run"])
    #expect(Servers.order("https://terminus.run", in: ["https://terminus.run"], detour: nil) == ["https://terminus.run"])
    #expect(Api.site == "https://terminus.run")
    #expect(Api.linkBase == "https://terminus.run")
}

@Test func aRequestGoesToTheBackupOnlyWhenTheFirstWasNeverReached() async throws {
    actor Asked {
        var list: [String] = []
        func add(_ s: String) { list.append(s) }
    }
    var asked = Asked()
    let r = try await Servers.first(site, method: "GET") { base in
        await asked.add(base)
        if base == site[0] { throw URLError(.secureConnectionFailed) }
        return "ok"
    }
    #expect(r.at == site[1] && r.result == "ok")
    #expect(await asked.list == site)
    asked = Asked()
    await #expect(throws: URLError.self) {
        try await Servers.first(site, method: "GET") { base -> String in
            await asked.add(base)
            throw URLError(.timedOut)
        }
    }
    #expect(await asked.list == [site[0]])
    asked = Asked()
    await #expect(throws: URLError.self) {
        try await Servers.first(site, method: "POST") { base -> String in
            await asked.add(base)
            throw URLError(.networkConnectionLost)
        }
    }
    #expect(await asked.list == [site[0]])
    await #expect(throws: URLError(.cannotFindHost)) {
        try await Servers.first(site, method: "GET") { _ -> String in throw URLError(.cannotFindHost) }
    }
}
