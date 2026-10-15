import XCTest

@testable import Terminus

final class TokenStoreTests: XCTestCase {
    func testSavesReadsAndClears() {
        let before = TokenStore.read()
        TokenStore.save("test-token")
        XCTAssertEqual(TokenStore.read(), "test-token")
        TokenStore.save("other")
        XCTAssertEqual(TokenStore.read(), "other")
        TokenStore.clear()
        XCTAssertNil(TokenStore.read())
        if let before { TokenStore.save(before) }
    }

    func testGroupDefaults() {
        print("GROUP", Shared.group, FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Shared.group) as Any)
        XCTAssertNotNil(UserDefaults(suiteName: Shared.group))
    }
}
