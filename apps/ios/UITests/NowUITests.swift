import XCTest

/// Now against the dev stub: the trip, its card styles, Nearby, the search,
/// a place's tab, Go later, Today's remove and undo, and "Is this wrong?".
/// Screenshots in light and dark, English and Chinese.
final class NowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        // A Wednesday at 09:30, with every service running; each launch puts the class 50 minutes on.
        stubPost("/__stub/reset")
        stubPost("/__stub/at?t=2026-10-07T01:30:00Z")
    }

    override func tearDown() {
        stubPost("/__stub/reset")
    }

    private func launch(lang: String = "en", theme: String = "light", sky: String? = nil, style: String? = nil) -> XCUIApplication {
        var extra: [String: String] = [:]
        if let sky { extra["TERMINUS_SKY"] = sky }
        if let style { extra["TERMINUS_CARD_STYLE"] = style }
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme, extra: extra)
        app.launch()
        let came = app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15)
        if !came { shot("failed-no-card-\(name)", app) }
        XCTAssertTrue(came, "no card")
        return app
    }

    /// Scrolls until `e` is on screen, clear of the tab bar.
    private func reveal(_ e: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(e.waitForExistence(timeout: 15), "\(e) never came")
        let bar = app.tabBars.firstMatch.frame
        for _ in 0..<8 where !(e.isHittable && e.frame.maxY < bar.minY) {
            app.swipeUp(velocity: .slow)
        }
    }

    func testTheTripInEveryStyleAndSky() {
        for (style, sky, theme) in [
            ("steps", "night", "light"), ("route", "day", "light"), ("ticket", "golden", "dark"), ("steps", "dawn", "dark"),
            ("route", "dusk", "light"),
        ] {
            let app = launch(theme: theme, sky: sky, style: style)
            shot("now-\(style)-\(sky)-\(theme)", app)
            app.swipeUp()
            shot("now-\(style)-\(sky)-\(theme)-down", app)
            app.terminate()
        }
    }

    func testChinese() {
        let app = launch(lang: "zh", theme: "light", sky: "day")
        shot("now-zh", app)
        app.swipeUp()
        shot("now-zh-down", app)
        app.buttons["chip.nearby"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch.waitForExistence(
                timeout: 15))
        shot("now-zh-nearby", app)
    }

    func testNearbyOpensAStopInBuses() {
        let app = launch(sky: "night")
        app.buttons["chip.nearby"].tap()
        let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        shot("now-nearby", app)
        app.swipeUp()
        shot("now-nearby-down", app)
        app.swipeDown()
        stop.tap()
        XCTAssertTrue(app.tabBars.buttons["Buses"].isSelected)
    }

    func testSearchAPlaceAndGoLater() {
        let app = launch(sky: "day")
        app.buttons["search"].tap()
        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("com3")
        let result = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'result.'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 10))
        shot("now-search", app)
        result.tap()
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15))
        shot("now-place", app)
        let later = app.buttons["goLater"]
        reveal(later, in: app)
        later.tap()
        shot("now-go-later", app)
        app.buttons["goLater.ok"].tap()
        // Back on Next, with the trip planned.
        XCTAssertTrue(app.buttons["chip.next"].waitForExistence(timeout: 10))
        shot("now-after-go-later", app)
        // A favourite's chip shows its own card.
        let chip = app.buttons["chip.KR MRT"]
        for _ in 0..<6 where !chip.isHittable { app.swipeDown() }
        chip.tap()
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15))
        shot("now-favourite", app)
    }

    func testRemoveFromTodayAndUndo() {
        let app = launch(sky: "day")
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'remove.'")).firstMatch
        reveal(remove, in: app)
        shot("now-today", app)
        remove.tap()
        let undo = app.buttons["undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        shot("now-removed", app)
        undo.tap()
        XCTAssertTrue(remove.waitForExistence(timeout: 10))
        shot("now-undone", app)
    }

    func testReportAWrongAnswer() {
        let app = launch(sky: "day")
        reveal(app.buttons["report"], in: app)
        app.buttons["report"].tap()
        let reason = app.buttons["reason.never-came"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        shot("now-report", app)
        reason.tap()
        app.buttons["report.send"].tap()
        XCTAssertTrue(app.buttons["report.done"].waitForExistence(timeout: 10))
        shot("now-report-sent", app)
        app.buttons["report.done"].tap()
    }

    /// Without an email the server takes no reports: "Add your email" opens
    /// Settings' email sign-in, though Settings hasn't been opened yet.
    func testReportWithoutAnEmailAsksForOne() {
        let app = XCUIApplication.terminus(signedIn: false, extra: ["TERMINUS_TOKEN": stubAnonToken(), "TERMINUS_SKY": "day"])
        app.launch()
        let report = app.buttons["report"]
        reveal(report, in: app)
        report.tap()
        let add = app.buttons["report.addEmail"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        shot("now-report-no-email", app)
        add.tap()
        XCTAssertTrue(app.textFields["signIn.email"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["Settings"].isSelected)
        shot("now-report-sign-in", app)
    }

    /// VoiceOver reads the card as sentences of the server's words, not a word at a time.
    func testTheCardIsReadAsSentences() {
        let app = launch(sky: "day")
        let card = app.descendants(matching: .any)["now.card"]
        let said = card.label
        print("card says: \(said)")
        XCTAssertTrue(said.contains(". "), said)
        XCTAssertFalse(said.contains("~"), said)
        XCTAssertFalse(said.contains(" · "), said)
    }

    func testLargeText() {
        let app = XCUIApplication.terminus(signedIn: true, extra: ["TERMINUS_SKY": "day"])
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
        app.launch()
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15))
        shot("now-large-text", app)
        app.swipeUp()
        shot("now-large-text-down", app)
    }
}
