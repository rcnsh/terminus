import CoreLocation
import XCTest

@MainActor
final class NowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
        stubPost("/__stub/at?t=2026-10-07T01:30:00Z")
        MainActor.assumeIsolated {
            XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 1.2927, longitude: 103.7803))
        }
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

    private func reveal(_ e: XCUIElement, in app: XCUIApplication) {
        let came = e.waitForExistence(timeout: 15)
        if !came { shot("failed-reveal-\(name)", app) }
        XCTAssertTrue(came, "\(e) never came")
        let bar = app.tabBars.firstMatch.frame
        for _ in 0..<8 where !(e.isHittable && e.frame.maxY < bar.minY) {
            app.swipeUp(velocity: .slow)
        }
    }

    private func lastNearbyRow(_ app: XCUIApplication) -> XCUIElement {
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.'"))
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 15))
        return rows.allElementsBoundByIndex.max { $0.frame.maxY < $1.frame.maxY } ?? rows.firstMatch
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
        XCTAssertFalse(app.buttons["chip.nearby"].exists, "Nearby is a tab, not a chip")
        app.tabBars.buttons["附近"].tap()
        allowLocationIfAsked()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch.waitForExistence(
                timeout: 15))
        shot("now-zh-nearby", app)
    }

    func testNearbyOpensAStopsBoardAndLine() {
        resetProfile()
        defer { resetProfile() }
        let app = launch(sky: "night")
        app.tabBars.buttons["Nearby"].tap()
        allowLocationIfAsked()
        let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        let code = String(stop.identifier.dropFirst("nearby.".count))
        let star = app.buttons["star-\(code)"]
        XCTAssertTrue(star.label.hasPrefix("Pin "), star.label)
        star.tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier == %@ AND label BEGINSWITH 'Unpin '", "star-\(code)")).firstMatch
                .waitForExistence(timeout: 5))
        shot("now-nearby", app)
        reveal(lastNearbyRow(app), in: app)
        shot("now-nearby-down", app)
        app.swipeDown()
        app.swipeDown()
        stop.tap()
        XCTAssertTrue(app.tabBars.buttons["Stops"].isSelected)
        XCTAssertTrue(app.staticTexts["stop-name"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Unpin this stop"].exists)
        shot("now-nearby-stop", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["pinned-\(code)"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Nearby"].tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "nearbyRow.\(code).")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.tabBars.buttons["Stops"].isSelected)
        XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Your stop"].waitForExistence(timeout: 10))
        shot("now-nearby-line", app)
    }

    func testNearbyDark() {
        setProfile { $0["pinnedStops"] = ["PGP"] }
        defer { resetProfile() }
        let app = launch(theme: "dark", sky: "night")
        app.tabBars.buttons["Nearby"].tap()
        allowLocationIfAsked()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).firstMatch.waitForExistence(timeout: 15))
        sleep(1)
        shot("now-nearby-dark", app)
        reveal(lastNearbyRow(app), in: app)
        shot("now-nearby-down-dark", app)
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
        XCTAssertTrue(app.buttons["chip.next"].waitForExistence(timeout: 10))
        shot("now-after-go-later", app)
        let card = app.descendants(matching: .any)["now.card"]
        for _ in 0..<20 where !card.label.contains("COM 3") { usleep(500_000) }
        XCTAssertTrue(card.label.contains("COM 3"), "the planned trip is Next")
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'remove.' AND label CONTAINS 'COM 3'")).firstMatch
        reveal(remove, in: app)
        remove.tap()
        let off = { !card.label.isEmpty && !card.label.contains("COM 3") }
        for _ in 0..<30 where !off() { usleep(500_000) }
        XCTAssertTrue(off(), "the planned trip was taken off")
        app.swipeDown()
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

    func testAFlickTakesARowOffAndASlowDragDoesNot() {
        let app = launch(sky: "day")
        let remove = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'remove.'")).firstMatch
        reveal(remove, in: app)
        let key = remove.identifier
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

    func testStepToALaterBusAndBack() {
        stubPost("/__stub/freeze")
        let app = launch(sky: "day")
        let later = app.buttons["step.later"]
        for _ in 0..<4 where !later.waitForExistence(timeout: 16) {
            app.swipeDown(velocity: .fast)
        }
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

    func testReportSaysLiveTimesAreNUSs() {
        stubPost("/__stub/freeze")
        stubPost("/__stub/at?t=2026-10-09T01:26:00Z")
        defer { stubPost("/__stub/reset") }
        let app = launch(sky: "day")
        reveal(app.buttons["report"], in: app)
        app.buttons["report"].tap()
        let reason = app.buttons["reason.never-came"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        reason.tap()
        XCTAssertTrue(app.descendants(matching: .any)["report.nus"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["report.send"].label, "Send anyway")
        shot("now-report-nus", app)
        app.buttons["reason.wrong-stop"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["report.nus"].exists)
        XCTAssertEqual(app.buttons["report.send"].label, "Send")
    }

    func testReportOnAnEstimateSaysNothingOfNUS() {
        stubPost("/__stub/freeze")
        stubPost("/__stub/at?t=2026-10-07T02:00:00Z")
        defer { stubPost("/__stub/reset") }
        let app = launch(sky: "day")
        reveal(app.buttons["report"], in: app)
        app.buttons["report"].tap()
        let reason = app.buttons["reason.never-came"]
        XCTAssertTrue(reason.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '~'")).firstMatch.exists, "not an estimate")
        reason.tap()
        XCTAssertFalse(app.descendants(matching: .any)["report.nus"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["report.send"].label, "Send")
    }

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
