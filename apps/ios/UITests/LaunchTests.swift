import XCTest

final class LaunchTests: XCTestCase {
    func testSignedInShowsTheTabs() {
        let app = XCUIApplication.terminus(signedIn: true)
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Now"].waitForExistence(timeout: 10))
        shot("launch-signed-in", app)
    }
}
