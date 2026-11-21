import XCTest

@MainActor
final class PullUITests: XCTestCase {
    nonisolated override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
        stubPost("/__stub/at?t=2026-10-07T01:30:00Z")
    }

    nonisolated override func tearDown() {
        stubPost("/__stub/reset")
    }

    private func pull(_ app: XCUIApplication, by: CGFloat) {
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: by)), withVelocity: 600, thenHoldForDuration: 0.5)
    }

    private func pillSays(_ app: XCUIApplication, _ want: (String) -> Bool, timeout: TimeInterval = 8) -> String? {
        let pill = app.descendants(matching: .any)["pull.pill"]
        let end = Date().addingTimeInterval(timeout)
        var seen: String?
        while Date() < end {
            if pill.exists {
                seen = pill.label
                if want(pill.label) { return pill.label }
            }
            usleep(100_000)
        }
        XCTFail("the pill said \(seen ?? "nothing")")
        return nil
    }

    func testNowsSkyStretchesAndAsksAgain() {
        let app = XCUIApplication.terminus(signedIn: true, extra: ["TERMINUS_SKY": "night"])
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15))
        pull(app, by: 320)
        _ = pillSays(app) { $0.hasPrefix("Up to date") }
        shot("pull-now-up-to-date", app)
        let pill = app.descendants(matching: .any)["pull.pill"]
        XCTAssertTrue(pill.waitForNonExistence(timeout: 6))
        pull(app, by: 40)
        XCTAssertTrue(pill.waitForNonExistence(timeout: 4))
        sleep(15)
        pull(app, by: 320)
        _ = pillSays(app) { $0 == "Updated just now" }
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].exists)
    }

    func testTheBusesSkyStretchesAndAsksAgain() {
        setProfile { $0["pinnedStops"] = ["COM3"] }
        defer { resetProfile() }
        let app = XCUIApplication.terminus(signedIn: true, extra: ["TERMINUS_SKY": "day"])
        app.launch()
        app.tabBars.buttons["Stops"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.COM3.'")).firstMatch
                .waitForExistence(timeout: 15))
        pull(app, by: 320)
        _ = pillSays(app) { $0.hasPrefix("Up to date") || $0 == "Updated just now" }
        shot("pull-buses", app)
    }
}
