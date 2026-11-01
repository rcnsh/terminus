import XCTest

/// Now against the dev stub: the trip, its card styles, Nearby, the search,
/// a place's tab, Go later, Today's remove and undo, and "Is this wrong?".
/// Screenshots in light and dark, English and Chinese.
@MainActor
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
        let came = e.waitForExistence(timeout: 15)
        if !came { shot("failed-reveal-\(name)", app) }
        XCTAssertTrue(came, "\(e) never came")
        let bar = app.tabBars.firstMatch.frame
        for _ in 0..<8 where !(e.isHittable && e.frame.maxY < bar.minY) {
            app.swipeUp(velocity: .slow)
        }
    }

    func testTheTripInEveryStyleAndSky() {
        for (style, sky, theme) in [
            ("steps", "night", "light"), ("route", "day", "light"), ("route", "golden", "dark"), ("steps", "dawn", "dark"),
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

    func testNearbyOpensAStopOnTheMap() {
        let app = launch(sky: "night")
        app.buttons["chip.nearby"].tap()
        let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        shot("now-nearby", app)
        app.swipeUp()
        shot("now-nearby-down", app)
        app.swipeDown()
        stop.tap()
        XCTAssertTrue(app.tabBars.buttons["Map"].isSelected)
        // The map glides onto the stop.
        sleep(3)
        shot("now-nearby-map", app)
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
        // Taken off today again, so the trip planned here isn't the card the
        // tests after this one find (/__stub/reset keeps the accounts).
        let card = app.descendants(matching: .any)["now.card"]
        for _ in 0..<20 where !card.label.contains("COM 3") { usleep(500_000) }
        XCTAssertTrue(card.label.contains("COM 3"), "the planned trip is Next")
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'remove.' AND label CONTAINS 'COM 3'")).firstMatch
        reveal(remove, in: app)
        remove.tap()
        // A card that isn't COM 3, not one that says nothing while it's updating:
        // the server's answer, so the trip is off before the app is closed.
        let off = { !card.label.isEmpty && !card.label.contains("COM 3") }
        for _ in 0..<30 where !off() { usleep(500_000) }
        XCTAssertTrue(off(), "the planned trip was taken off")
        app.swipeDown()
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

    /// A Today row goes on where it's heading when let go: a short slow drag
    /// springs back, a flick over the same short distance takes it off, with Undo.
    func testAFlickTakesARowOffAndASlowDragDoesNot() {
        let app = launch(sky: "day")
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'remove.'")).firstMatch
        reveal(remove, in: app)
        let key = remove.identifier
        // On the row, left of its ×, and 80 pt to the left: short of the bin (140 pt).
        let start = remove.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).withOffset(CGVector(dx: -120, dy: 0))
        let short = start.withOffset(CGVector(dx: -80, dy: 0))
        start.press(forDuration: 0.05, thenDragTo: short, withVelocity: XCUIGestureVelocity(150), thenHoldForDuration: 0.4)
        sleep(1)
        XCTAssertTrue(app.buttons[key].exists, "a slow short drag left the row in place")
        XCTAssertFalse(app.buttons["undo"].exists)
        start.press(forDuration: 0.05, thenDragTo: short, withVelocity: XCUIGestureVelocity(2_500), thenHoldForDuration: 0)
        XCTAssertTrue(app.buttons["undo"].waitForExistence(timeout: 5), "a flick took the row off, with Undo")
        XCTAssertFalse(app.buttons[key].exists)
        shot("now-flicked", app)
        app.buttons["undo"].tap()
        XCTAssertTrue(app.buttons[key].waitForExistence(timeout: 10), "Undo put it back")
    }

    /// "Later bus" moves the card to the next bus, and "Best bus" comes
    /// between the two to go back; back on the best one it goes again.
    func testStepToALaterBusAndBack() {
        // Held still: the fake times go round every 12 minutes, and whether
        // there's a bus to step to depends on where in that the test lands.
        stubPost("/__stub/freeze")
        let app = launch(sky: "day")
        let later = app.buttons["step.later"]
        reveal(later, in: app)
        XCTAssertTrue(app.buttons["step.earlier"].exists)
        XCTAssertFalse(app.buttons["step.best"].exists)
        shot("now-step", app)
        later.tap()
        let best = app.buttons["step.best"]
        XCTAssertTrue(best.waitForExistence(timeout: 10), "no Best bus after a step")
        shot("now-step-later", app)
        best.tap()
        XCTAssertTrue(best.waitForNonExistence(timeout: 10), "Best bus stayed after going back")
        shot("now-step-best", app)
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
    /// the email sign-in over Now, which stays where it was.
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
        shot("now-report-sign-in", app)
        app.buttons["Cancel"].firstMatch.tap()
        XCTAssertTrue(app.tabBars.buttons["Now"].isSelected)
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
