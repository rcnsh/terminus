import Foundation
import Security
import Testing
@testable import Terminus

/// The device token, in a temporary folder and under a keychain name of its
/// own, never the app's. One at a time: they share TokenStore's settings.
@Suite(.serialized) struct TokenStoreTests {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("terminus-test-\(UUID().uuidString)")

    init() {
        TokenStore.folder = dir
        TokenStore.service = "sh.rcn.terminus.test-\(UUID().uuidString)"
    }

    private func cleanUp() {
        _ = TokenStore.write(nil)
        TokenStore.folder = nil
        TokenStore.service = "sh.rcn.terminus"
        try? FileManager.default.removeItem(at: dir)
    }

    @Test func theFileIsPrivateAndReplacedWhole() throws {
        defer { cleanUp() }
        #expect(TokenStore.read() == nil)
        #expect(!TokenStore.exists)

        #expect(TokenStore.write("first-token"))
        #expect(TokenStore.read() == "first-token")
        let file = try FileManager.default.attributesOfItem(atPath: TokenStore.fileURL.path)
        #expect((file[.posixPermissions] as? NSNumber)?.intValue == 0o600, "only this user can read it")
        let folder = try FileManager.default.attributesOfItem(atPath: dir.path)
        #expect((folder[.posixPermissions] as? NSNumber)?.intValue == 0o700)

        #expect(TokenStore.write("second-token"))
        #expect(TokenStore.read() == "second-token")
        let left = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(left == ["device-token"], "no temporary files left behind")

        #expect(TokenStore.write(nil))
        #expect(TokenStore.read() == nil)
    }

    /// Kept in the keychain by 1.3.8 to 2.0.0-beta.4: moved to the file once, and the keychain item goes.
    @Test func aKeychainTokenMovesToTheFileOnce() throws {
        defer { cleanUp() }
        let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: TokenStore.service, kSecAttrAccount as String: "device-token"]
        var add = item
        add[kSecValueData as String] = Data("kept-in-keychain".utf8)
        #expect(SecItemAdd(add as CFDictionary, nil) == errSecSuccess)

        #expect(TokenStore.read() == "kept-in-keychain")
        let moved = try String(contentsOf: TokenStore.fileURL, encoding: .utf8)
        #expect(moved == "kept-in-keychain")
        #expect(SecItemCopyMatching(item as CFDictionary, nil) == errSecItemNotFound, "the keychain item is gone")
    }
}
