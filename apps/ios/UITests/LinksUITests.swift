import XCTest

/// The terminus:// links widgets, notifications and the Live Activity open,
/// each landing where it says: a tab, the plan, Nearby or a favourite on Now.
@MainActor
final class LinksUITests: XCTestCase {
    nonisolated override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
    }

    func testEachLinkLandsWhereItSays() {
        // A system prompt left by a link opened from outside (simctl openurl) would cover the app.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for _ in 0..<6 where springboard.buttons["Cancel"].exists { springboard.buttons["Cancel"].tap() }
        let app = XCUIApplication.terminus(signedIn: true, extra: ["TERMINUS_SKY": "day"])
        app.launch()
        let came = app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15)
        if !came { shot("links-no-card", app) }
        XCTAssertTrue(came, "no card")
        let tabs = app.tabBars.buttons
        for (link, tab) in [("map", "Map"), ("buses", "Buses"), ("settings", "Settings")] {
            app.open(URL(string: "terminus://\(link)")!)
            XCTAssertTrue(selected(tabs[tab]), "terminus://\(link) didn't open \(tab)")
        }
        // A favourite's link: Now, on its chip.
        app.open(URL(string: "terminus://place/mrt")!)
        XCTAssertTrue(selected(app.buttons["chip.KR MRT"]))
        XCTAssertTrue(tabs["Now"].isSelected)
        shot("link-place", app)
        // Nearby, then back to the plan.
        app.open(URL(string: "terminus://nearby")!)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch.waitForExistence(timeout: 15))
        shot("link-nearby", app)
        app.open(URL(string: "terminus://plan")!)
        XCTAssertTrue(selected(app.buttons["chip.next"]))
        // A stop link without this phone's widget key is refused: nothing changes.
        app.open(URL(string: "terminus://to/COM3?label=Somewhere")!)
        sleep(2)
        XCTAssertFalse(app.buttons["chip.Somewhere"].exists)
    }

    /// Whether `e` is selected within `timeout` seconds.
    private func selected(_ e: XCUIElement, timeout: TimeInterval = 10) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if e.exists && e.isSelected { return true }
            usleep(200_000)
        }
        return false
    }
}
