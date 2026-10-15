import Foundation
import Testing

@testable import Terminus

/// Setup and Settings after signing in from a guest (or signing out): the
/// window stays open with its SetupModel, so what it shows and would save
/// must be the account signed in now, not the one before.

@MainActor private final class Sessions {
    var now = 1
}

@MainActor private func model(_ sessions: Sessions) throws -> SetupModel {
    let campus = try JSONDecoder().decode(Campus.self, from: Data(#"{"stops":[],"residences":[]}"#.utf8))
    return SetupModel(profile: ["walkPace": "normal", "seen": [] as [String]], campus: campus, session: { sessions.now })
}

@MainActor @Test func anEditForTheAccountSignedOutOfIsRefused() throws {
    let sessions = Sessions()
    let setup = try model(sessions)
    #expect(!setup.stale)
    // Signed in with an email from the guest: the guest's setup is still on screen.
    sessions.now = 2
    #expect(setup.stale)
    setup.setPace("fast")
    #expect(setup.walkPace == "normal")
}

@MainActor @Test func resetDropsTheAccountsSetup() throws {
    let sessions = Sessions()
    let setup = try model(sessions)
    sessions.now = 2
    setup.reset()
    #expect(setup.profile == nil)
    #expect(setup.devices == nil && setup.me == nil && setup.choices == nil)
    #expect(!setup.stale)
    // Nothing to edit until the new account's setup has loaded.
    setup.setPace("fast")
    #expect(setup.profile == nil)
}
