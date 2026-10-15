import Foundation
import Testing

@testable import Terminus

/// Saving a change to the profile (`Api.changeProfile`): only the change, on
/// the profile as the server has it, so another device's save isn't undone.

/// The server's profile and its version, as /api/me/profile keeps them:
/// a save with an If-Match that isn't the current version gets 412.
private final class Server {
    var profile: [String: Any]
    var version = 1
    /// Saved by another device just before each of the next saves arrives.
    var elsewhere: [([String: Any]) -> [String: Any]] = []
    var ifMatches: [String?] = []

    init(_ profile: [String: Any]) { self.profile = profile }

    func read() throws -> (Data, String?) {
        (try JSONSerialization.data(withJSONObject: profile), "\"\(version)\"")
    }

    func save(_ body: Data, _ tag: String?) throws -> Data {
        ifMatches.append(tag)
        if !elsewhere.isEmpty {
            profile = elsewhere.removeFirst()(profile)
            version += 1
        }
        guard tag == "\"\(version)\"" else { throw ApiError(status: 412, message: "changed on another device") }
        profile = try JSONSerialization.jsonObject(with: body) as? [String: Any] ?? [:]
        version += 1
        return body
    }

    func change(_ change: (inout [String: Any]) -> Void) async throws -> [String: Any] {
        try await Api.changeProfile(read: { try read() }, save: { try save($0, $1) }, change: change)
    }
}

@Test func aChangeIsSavedWithTheVersionItWasMadeOn() async throws {
    let server = Server(["walkPace": "normal", "clock": "24"])
    let saved = try await server.change { $0["walkPace"] = "fast" }
    #expect(server.ifMatches == ["\"1\""])
    #expect(saved["walkPace"] as? String == "fast")
    #expect(server.profile["clock"] as? String == "24")
}

@Test func anotherDevicesSaveMeanwhileStaysAndTheChangeIsMadeAgain() async throws {
    let server = Server(["walkPace": "normal", "places": [] as [Any]])
    // A favourite added on the phone between this Mac's read and its save.
    server.elsewhere = [
        { p in
            var p = p
            p["places"] = [["key": "com3", "label": "COM3", "to": "COM3"]]
            return p
        }
    ]
    let saved = try await server.change { $0["walkPace"] = "slow" }
    // The first save was refused (412); the second was made on the phone's profile.
    #expect(server.ifMatches == ["\"1\"", "\"2\""])
    #expect(saved["walkPace"] as? String == "slow")
    #expect((saved["places"] as? [[String: Any]])?.first?["key"] as? String == "com3")
    #expect((server.profile["places"] as? [[String: Any]])?.count == 1)
}

@Test func aProfileThatKeepsChangingGivesUpAfterThreeTries() async throws {
    let server = Server(["walkPace": "normal"])
    server.elsewhere = Array(repeating: { $0 }, count: 5)
    await #expect(throws: ApiError.self) { _ = try await server.change { $0["walkPace"] = "fast" } }
    #expect(server.ifMatches.count == 3)
    #expect(server.profile["walkPace"] as? String == "normal")
}
