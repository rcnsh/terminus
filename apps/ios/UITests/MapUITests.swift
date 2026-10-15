import XCTest

/// The Map tab against the dev stub: the street map, a service's pill and
/// its live buses, a stop's sheet and a bus's, light and dark, English and
/// Chinese. Screenshots go to $TERMINUS_SHOTS to look at.
@MainActor
final class MapUITests: XCTestCase {
    nonisolated override func setUp() {
        continueAfterFailure = false
    }

    /// The app on the Map tab, the street map drawn.
    private func openMap(lang: String = "en", theme: String = "light", extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme, extra: extra)
        app.launch()
        let tab = app.tabBars.buttons.element(boundBy: 2)
        XCTAssertTrue(tab.waitForExistence(timeout: 15))
        tab.tap()
        if !app.buttons["map.pill.A1"].waitForExistence(timeout: 20) {
            shot("map-failed-to-open", app)
            XCTFail("the pills come with the campus")
        }
        // The street map downloads the first time; then MapLibre draws it.
        let downloading = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '4 MB'")).firstMatch
        if downloading.exists { _ = waitGone(downloading, 30) }
        sleep(3)
        return app
    }

    @discardableResult
    private func waitGone(_ e: XCUIElement, _ timeout: TimeInterval) -> Bool {
        let p = NSPredicate(format: "exists == false")
        return XCTWaiter().wait(for: [expectation(for: p, evaluatedWith: e)], timeout: timeout) == .completed
    }

    func testTheCampusMap() {
        let app = openMap()
        XCTAssertTrue(app.buttons["map.recentre"].exists)
        XCTAssertTrue(app.buttons["map.locate"].exists)
        shot("map-light-en", app)
    }

    func testTheCampusMapDark() {
        let app = openMap(theme: "dark")
        shot("map-dark-en", app)
    }

    func testAPillShowsItsLineAndBuses() {
        let app = openMap()
        app.buttons["map.pill.A1"].tap()
        XCTAssertTrue(
            app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'buses on A1' OR label CONTAINS '1 bus on A1'")).firstMatch
                .waitForExistence(timeout: 15))
        sleep(7)
        shot("map-a1-light-en", app)
        // The same pill again: off.
        app.buttons["map.pill.A1"].tap()
        XCTAssertTrue(waitGone(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'on A1'")).firstMatch, 5))
    }

    func testAStopsSheet() {
        let app = openMap(extra: ["TERMINUS_MAP_STOP": "COM3"])
        let title = app.staticTexts["map.sheet.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 15))
        XCTAssertEqual(title.label, "COM 3")
        XCTAssertTrue(app.staticTexts["Buses here"].exists)
        XCTAssertTrue(app.buttons["map.sheet.go"].exists)
        // Its times come.
        let row = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'map.row.'")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        sleep(2)
        shot("map-stop-light-en", app)
        // A row shows its line on the map.
        row.tap()
        XCTAssertTrue(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS 'buses on' OR label CONTAINS 'Finding' OR label CONTAINS 'bus on'")
            ).firstMatch.waitForExistence(timeout: 10))
        sleep(6)
        shot("map-stop-picked-light-en", app)
    }

    func testTappingAStopOnTheMapOpensIt() {
        let app = openMap(extra: ["TERMINUS_MAP_STOP": "COM3"])
        let close = app.buttons["map.sheet.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 15))
        sleep(3)
        // The stop sits in the middle of what the pills and the sheet leave uncovered.
        let top = app.buttons["map.pill.A1"].frame.maxY + 4
        let sheetTop = close.frame.minY - 22
        let y = (top + sheetTop) / 2
        close.tap()
        XCTAssertTrue(waitGone(close, 5))
        sleep(1)
        let window = app.windows.firstMatch
        window.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: window.frame.width / 2, dy: y)).tap()
        let title = app.staticTexts["map.sheet.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 10))
        XCTAssertEqual(title.label, "COM 3")
        // Dragged down by its handle, it closes.
        title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(
            forDuration: 0.05, thenDragTo: window.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        XCTAssertTrue(waitGone(title, 5))
    }

    func testABusesSheet() {
        let app = openMap(extra: ["TERMINUS_MAP_SVC": "A1", "TERMINUS_MAP_BUS": "1"])
        let plate = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'PD'")).firstMatch
        XCTAssertTrue(plate.waitForExistence(timeout: 20), "its plate")
        XCTAssertTrue(app.staticTexts["map.sheet.title"].label.hasPrefix("Towards"))
        sleep(2)
        shot("map-bus-light-en", app)
        // Its stops ahead, opened.
        app.buttons["map.sheet.band"].tap()
        XCTAssertTrue(app.buttons["map.sheet.showStop"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["map.sheet.band"].value as? String, "Expanded")
        sleep(1)
        shot("map-bus-stops-light-en", app)
        // A stop of its, opened from here; back returns to the bus.
        app.buttons["map.sheet.showStop"].tap()
        XCTAssertTrue(app.staticTexts["Buses here"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["map.sheet.back"].exists)
        sleep(2)
        shot("map-bus-stop-light-en", app)
        app.buttons["map.sheet.back"].tap()
        // Back on the bus (the stub's buses move, so it may be at a stop by now), its stops still open.
        let plateAgain = app.staticTexts["map.sheet.plate"]
        XCTAssertTrue(plateAgain.waitForExistence(timeout: 5), "back on the bus")
        XCTAssertEqual(app.buttons["map.sheet.band"].value as? String, "Expanded", "its stops still open")
    }

    func testABusesSheetDark() {
        let app = openMap(theme: "dark", extra: ["TERMINUS_MAP_SVC": "A1", "TERMINUS_MAP_BUS": "1"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'PD'")).firstMatch.waitForExistence(timeout: 20))
        app.buttons["map.sheet.band"].tap()
        sleep(2)
        shot("map-bus-stops-dark-en", app)
    }

    func testInChinese() {
        let app = openMap(lang: "zh", extra: ["TERMINUS_MAP_STOP": "UTOWN"])
        XCTAssertTrue(app.staticTexts["本站巴士"].waitForExistence(timeout: 15))
        sleep(3)
        shot("map-stop-light-zh", app)
        app.buttons["map.sheet.close"].tap()
        app.buttons["map.pill.D2"].tap()
        sleep(7)
        shot("map-d2-light-zh", app)
    }

    func testInChineseDark() {
        let app = openMap(lang: "zh", theme: "dark", extra: ["TERMINUS_MAP_SVC": "D1", "TERMINUS_MAP_BUS": "1"])
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'PD'")).firstMatch.waitForExistence(timeout: 20))
        app.buttons["map.sheet.band"].tap()
        sleep(2)
        shot("map-bus-dark-zh", app)
    }

    func testBackToCampus() {
        let app = openMap(extra: ["TERMINUS_MAP_STOP": "COM3"])
        let close = app.buttons["map.sheet.close"]
        XCTAssertTrue(close.waitForExistence(timeout: 15))
        close.tap()
        XCTAssertTrue(app.buttons["map.recentre"].waitForExistence(timeout: 5))
        app.buttons["map.recentre"].tap()
        sleep(2)
        shot("map-recentred-light-en", app)
    }
}
