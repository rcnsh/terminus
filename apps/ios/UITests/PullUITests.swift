import XCTest

/// Pull to refresh, the sky stretching: pulled far enough, Now and the
/// Buses tab ask again and the pill says how it went; pulled a little, nothing.
@MainActor
final class PullUITests: XCTestCase {
    nonisolated override func setUp() {
        continueAfterFailure = false
        // A Wednesday at 09:30, with every service running.
        stubPost("/__stub/reset")
        stubPost("/__stub/at?t=2026-10-07T01:30:00Z")
    }

    nonisolated override func tearDown() {
        stubPost("/__stub/reset")
    }

    /// Drags down `by` points from a third of the way down the screen, and holds before letting go.
    private func pull(_ app: XCUIApplication, by: CGFloat) {
        let start = app.windows.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: by)), withVelocity: 600, thenHoldForDuration: 0.5)
    }

    /// The pill's words, as soon as they're `want`, within `timeout` seconds.
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
        // Just answered: nothing to ask for yet.
        pull(app, by: 320)
        _ = pillSays(app) { $0.hasPrefix("Up to date") }
        shot("pull-now-up-to-date", app)
        // A little, and it closes again without asking.
        let pill = app.descendants(matching: .any)["pull.pill"]
        XCTAssertTrue(pill.waitForNonExistence(timeout: 6))
        pull(app, by: 40)
        XCTAssertTrue(pill.waitForNonExistence(timeout: 4))
        // Once the answer is old enough, asked again.
        sleep(15)
        pull(app, by: 320)
        _ = pillSays(app) { $0 == "Updated just now" }
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].exists)
    }

    func testTheBusesSkyStretchesAndAsksAgain() {
        let app = XCUIApplication.terminus(signedIn: true, extra: ["TERMINUS_SKY": "day"])
        app.launch()
        app.tabBars.buttons["Buses"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'board-row-'")).firstMatch.waitForExistence(
                timeout: 15))
        pull(app, by: 320)
        _ = pillSays(app) { $0.hasPrefix("Up to date") || $0 == "Updated just now" }
        shot("pull-buses", app)
    }
}
