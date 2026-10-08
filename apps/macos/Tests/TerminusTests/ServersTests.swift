import Testing
@testable import Terminus

/// The developer menu's servers: the same cases as the phone's ServersTest.

private let site = ["https://terminus.rcn.sh", "https://terminus.run"]

@Test func theOldAddressIsTheDefaultAndTheStubOnlyInDebug() {
    #expect(Servers.all(default: "https://terminus.rcn.sh", site: "https://terminus.run", debug: false) == site)
    #expect(Servers.all(default: "https://terminus.rcn.sh", site: "https://terminus.run", debug: true) == site + ["http://localhost:8787"])
}

@Test func aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
    #expect(Servers.pick("https://terminus.run", from: site) == "https://terminus.run")
    #expect(Servers.pick(nil, from: site) == "https://terminus.rcn.sh")
    // Dropped from a later version, or written by another app (defaults write).
    #expect(Servers.pick("https://terminus.run", from: ["https://terminus.rcn.sh"]) == "https://terminus.rcn.sh")
    #expect(Servers.pick("https://evil.example", from: site) == "https://terminus.rcn.sh")
    #expect(Servers.pick("http://localhost:8787", from: site) == "https://terminus.rcn.sh")
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

@Test func theStableSiteDefaultsToTheAddressKeptForGood() {
    // No TerminusAPI in a test bundle: the stable site's.
    #expect(Servers.defaultBase == "https://terminus.rcn.sh")
    #expect(Api.site == "https://terminus.run")
}
