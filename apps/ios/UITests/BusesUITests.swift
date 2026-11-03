import CoreLocation
import XCTest

/// The Stops tab, called Stops, against the dev stub, tapped through: the
/// home with nothing pinned and with pinned stops (a page each, chosen by
/// name or swiped), the lines with their buses out, a stop's page and across
/// the road, the search, a service's line, a service not running, the public
/// buses, and no connection; with screenshots in light and dark, English and
/// Chinese. Each test puts the stub on real hours on a Wednesday at 21:30,
/// when R1 and R2 have stopped and P has too, so a board has services
/// running and not.
@MainActor
final class BusesUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        resetProfile()
        // The stub's own world, whatever the other suites left: real hours, a Wednesday at 21:30, held still.
        stubPost("/__stub/reset")
        stubPost("/__stub/hours?real=1")
        stubPost("/__stub/at?t=2026-10-07T13:30:00Z")
        stubPost("/__stub/freeze")
        // Prince George's Park. XCTest calls setUp on the main thread.
        MainActor.assumeIsolated {
            XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 1.2913, longitude: 103.7805))
        }
    }

    override func tearDown() {
        resetProfile()
        stubPost("/__stub/reset")
    }

    // MARK: helpers

    private func launch(lang: String = "en", theme: String = "light", extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme, extra: extra)
        app.launch()
        allowLocation()
        return app
    }

    /// Answers the location prompt, if it shows.
    private func allowLocation() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow While Using App", "使用 App 时允许"] {
            let b = springboard.buttons[label]
            if b.waitForExistence(timeout: 2) {
                b.tap()
                return
            }
        }
    }

    private func openBuses(_ app: XCUIApplication, lang: String = "en") {
        let tab = app.tabBars.buttons[lang == "zh" ? "车站" : "Stops"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    /// A pinned stop's page on the home, with `svc`'s row on it (Nearby's sign).
    @discardableResult
    private func waitForSign(_ app: XCUIApplication, _ code: String, svc: String? = nil) -> XCUIElement {
        let id = svc.map { "nearbyRow.\(code).\($0)" } ?? "nearbyRow.\(code)."
        let row = app.buttons.matching(NSPredicate(format: svc == nil ? "identifier BEGINSWITH %@" : "identifier == %@", id)).firstMatch
        let ok = row.waitForExistence(timeout: 15)
        if !ok { shot("failed-sign-\(code)", app) }
        XCTAssertTrue(ok, "no \(svc ?? "") row on \(code)'s sign")
        return row
    }

    private func waitForBoard(_ app: XCUIApplication, svc: String = "K") {
        let ok = app.buttons["board-row-\(svc)"].firstMatch.waitForExistence(timeout: 15)
        if !ok { shot("failed-board-\(svc)", app) }
        XCTAssertTrue(ok, "no \(svc) row on the board")
    }

    // MARK: tests

    func testHomeWithNothingPinned() {
        let app = launch()
        openBuses(app)
        XCTAssertTrue(app.descendants(matching: .any)["pinned-none"].firstMatch.waitForExistence(timeout: 10))
        // Every service, read as one: its name, the stops it passes and its buses out, as the server words them.
        let k = app.buttons["service-K"]
        XCTAssertTrue(k.waitForExistence(timeout: 10))
        XCTAssertTrue(k.label.hasPrefix("Bus K, PGP to PGP Foyer, via KR MRT, CLB, Kent Vale"), k.label)
        XCTAssertTrue(app.buttons["service-D1"].label.hasPrefix("Bus D1, Loop from COM 3, via UTown, CLB, AS 5"))
        // The buses out come once the list is on screen.
        let out = NSPredicate(format: "label ENDSWITH ', 3 out'")
        expectation(for: out, evaluatedWith: app.buttons["service-A1"])
        waitForExpectations(timeout: 10)
        shot("buses-home-empty-en-light", app)
        app.swipeUp()
        shot("buses-home-empty-services-en-light", app)
        // A service opens its whole line, with no stop of yours on it.
        app.buttons["service-K"].tap()
        XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Your stop"].exists)
        XCTAssertEqual(app.navigationBars.buttons.element(boundBy: 0).label, "Stops")
    }

    func testPinnedBoardsAndAcrossTheRoad() {
        setProfile { $0["pinnedStops"] = ["PGPR", "COM3"] }
        let app = launch()
        openBuses(app)
        waitForSign(app, "PGPR", svc: "K")
        // The names over the card, by their plates, the first chosen.
        XCTAssertEqual(app.buttons["pinned-PGPR"].label, "PGP Foyer")
        XCTAssertTrue(app.buttons["pinned-PGPR"].isSelected)
        XCTAssertEqual(app.buttons["pinned-COM3"].label, "COM 3")
        XCTAssertEqual(app.buttons["star-PGPR"].label, "Unpin PGP Foyer")
        shot("buses-home-pinned-en-light", app)
        // The plate opens the stop's page. PGP Foyer and PGP are near each other, not across a road: their names.
        app.buttons["nearby.PGPR"].tap()
        XCTAssertEqual(app.staticTexts["stop-name"].label, "Prince George's Park Foyer")
        let other = app.buttons["side-1"]
        XCTAssertTrue(other.waitForExistence(timeout: 10))
        XCTAssertEqual(other.label, "Prince George's Park")
        other.tap()
        XCTAssertTrue(app.staticTexts["Prince George's Park"].waitForExistence(timeout: 10))
        waitForBoard(app, svc: "A1")
        // R1 has stopped for the night: greyed, with when it's back.
        XCTAssertTrue(app.staticTexts["Stopped for today"].firstMatch.waitForExistence(timeout: 5))
        shot("buses-across-en-light", app)
        app.swipeUp()
        shot("buses-across-foot-en-light", app)
    }

    func testSearchPinAndHome() {
        let app = launch()
        openBuses(app)
        let field = app.textFields["buses-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        // Nothing typed: every service.
        XCTAssertTrue(app.buttons["hit-service:A1"].waitForExistence(timeout: 5))
        shot("buses-search-suggestions-en-light", app)
        field.typeText("com")
        XCTAssertTrue(app.buttons["hit-stop:COM3"].waitForExistence(timeout: 5))
        shot("buses-search-com-en-light", app)
        app.buttons["hit-stop:COM3"].tap()
        XCTAssertTrue(app.staticTexts["stop-name"].waitForExistence(timeout: 10))
        XCTAssertEqual(app.staticTexts["stop-name"].label, "COM 3")
        waitForBoard(app, svc: "D1")
        let pin = app.buttons["buses-pin"]
        XCTAssertEqual(pin.label, "Pin this stop")
        pin.tap()
        XCTAssertTrue(app.buttons["Unpin this stop"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pinned"].waitForExistence(timeout: 5))
        shot("buses-stop-pinned-en-light", app)
        XCTAssertEqual(app.navigationBars.buttons.element(boundBy: 0).label, "Stops")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // Home has it now, with its buses.
        XCTAssertTrue(app.buttons["pinned-COM3"].waitForExistence(timeout: 10))
        waitForSign(app, "COM3", svc: "D1")
        shot("buses-home-pinned-one-en-light", app)
        // Unpinned there, it goes.
        app.buttons["star-COM3"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["pinned-none"].firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["pinned-COM3"].exists)
    }

    func testNoSuchStop() {
        let app = launch()
        openBuses(app)
        let field = app.textFields["buses-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("zzqx")
        XCTAssertTrue(app.staticTexts["No stop or service by that name"].waitForExistence(timeout: 5))
        shot("buses-search-none-en-light", app)
        app.buttons["buses-search-close"].tap()
        XCTAssertTrue(app.buttons["service-A1"].waitForExistence(timeout: 10))
    }

    func testLineFromTheBoard() {
        setProfile { $0["pinnedStops"] = ["PGPR"] }
        let app = launch()
        openBuses(app)
        waitForSign(app, "PGPR", svc: "A2").tap()
        XCTAssertTrue(
            app.otherElements["line-running"].firstMatch.waitForExistence(timeout: 10)
                || app.staticTexts["3 buses running"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Your stop"].waitForExistence(timeout: 10))
        // Its buses, on the way between two stops or at one.
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'On the way' OR label CONTAINS 'At stop'"))
                .firstMatch.exists)
        shot("buses-line-en-light", app)
        app.swipeUp()
        shot("buses-line-scrolled-en-light", app)
        // A stop on the line opens its board, Back comes back to the line.
        let stop = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'line-stop-' AND label BEGINSWITH 'TCOMS'")).firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()
        let name = app.staticTexts["stop-name"]
        XCTAssertTrue(name.waitForExistence(timeout: 10))
        XCTAssertEqual(name.label, "TCOMS")
        waitForBoard(app, svc: "A2")
        shot("buses-line-stop-en-light", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 5))
        app.buttons["line-show-on-map"].tap()
        XCTAssertTrue(app.tabBars.buttons["Map"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Map"].isSelected)
        sleep(2)
        shot("buses-show-on-map-en-light", app)
    }

    func testPinnedPages() {
        // Three stops with different numbers of buses running: the card is the tallest's height throughout.
        setProfile { $0["pinnedStops"] = ["UTOWN", "KR-MRT", "COM3"] }
        let app = launch()
        openBuses(app)
        waitForSign(app, "UTOWN", svc: "D2")
        let utown = app.buttons["pinned-UTOWN"]
        XCTAssertTrue(utown.isSelected)
        let services = app.buttons["service-A1"]
        let below = services.frame.minY
        // A name moves the card to its stop.
        app.buttons["pinned-COM3"].tap()
        let com3 = waitForSign(app, "COM3", svc: "D1")
        XCTAssertTrue(app.buttons["pinned-COM3"].waitForSelected())
        XCTAssertTrue(com3.isHittable)
        shot("buses-pinned-com3-en-light", app)
        // A swipe moves the name: back to KR MRT.
        app.buttons["nearby.COM3"].swipeRight()
        XCTAssertTrue(app.buttons["pinned-KR-MRT"].waitForSelected())
        waitForSign(app, "KR-MRT")
        shot("buses-pinned-krmrt-en-light", app)
        // Nothing below moved.
        XCTAssertEqual(services.frame.minY, below, accuracy: 1)
        // Past the last stop, how to pin another.
        app.buttons["pinned-COM3"].tap()
        XCTAssertTrue(app.buttons["pinned-COM3"].waitForSelected())
        app.buttons["nearby.COM3"].swipeLeft()
        let add = app.descendants(matching: .any)["pinned-add"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        expectation(for: NSPredicate(format: "isHittable == true"), evaluatedWith: add)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(add.label.contains("Pin another stop"), add.label)
        XCTAssertFalse(app.buttons["pinned-COM3"].isSelected)
        shot("buses-pinned-add-en-light", app)
        // Unpinning the stop showing shows the one that took its place.
        app.buttons["pinned-KR-MRT"].tap()
        XCTAssertTrue(app.buttons["pinned-KR-MRT"].waitForSelected())
        app.buttons["star-KR-MRT"].tap()
        XCTAssertTrue(app.buttons["pinned-COM3"].waitForSelected())
        XCTAssertFalse(app.buttons["pinned-KR-MRT"].exists)
        XCTAssertTrue(waitForSign(app, "COM3", svc: "D1").isHittable)
        shot("buses-pinned-unpinned-en-light", app)
    }

    func testManyPinsScrollTheirNames() {
        let stops = ["COM3", "UTOWN", "KR-MRT", "CLB", "YIH", "AS5", "BIZ2", "LT27"]
        setProfile { $0["pinnedStops"] = stops }
        let app = launch()
        openBuses(app)
        waitForSign(app, "COM3")
        shot("buses-pinned-many-en-light", app)
        // The last name is off to the side; chosen, it comes into view.
        let last = app.buttons["pinned-LT27"]
        XCTAssertTrue(last.exists)
        XCTAssertFalse(last.isHittable)
        for _ in 0..<7 {
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.'")).allElementsBoundByIndex.first { $0.isHittable }?
                .swipeLeft()
        }
        XCTAssertTrue(last.waitForSelected())
        XCTAssertTrue(last.isHittable)
        shot("buses-pinned-many-last-en-light", app)
    }

    func testServiceNotRunning() {
        let app = launch()
        openBuses(app)
        let field = app.textFields["buses-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("R1")
        app.buttons["hit-service:R1"].tap()
        XCTAssertTrue(
            app.otherElements["line-stopped"].firstMatch.waitForExistence(timeout: 10)
                || app.staticTexts["Stopped for today"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No buses running"].exists)
        shot("buses-line-stopped-en-light", app)
    }

    func testPublicBuses() {
        setProfile { $0["publicBuses"] = true }
        let app = launch()
        openBuses(app)
        let field = app.textFields["buses-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Kent Ridge MRT")
        app.buttons["hit-stop:KR-MRT"].tap()
        waitForBoard(app, svc: "95")
        let row = app.buttons["board-row-95"]
        XCTAssertTrue(row.label.contains("Public bus 95, fare applies"))
        // A public bus has no line here.
        XCTAssertFalse(row.isEnabled)
        shot("buses-public-en-light", app)
    }

    func testPinsFull() {
        // As many pinned as the profile allows: one more isn't, and a note says why.
        let stops = ["COM3", "UTOWN", "KR-MRT", "CLB", "YIH", "AS5", "BIZ2", "LT27"]
        setProfile { $0["pinnedStops"] = stops }
        let app = launch()
        openBuses(app)
        // All eight on the home, in their order.
        XCTAssertTrue(app.buttons["pinned-LT27"].waitForExistence(timeout: 15))
        let field = app.textFields["buses-search"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Kent Vale")
        app.buttons["hit-stop:KV"].tap()
        let pin = app.buttons["buses-pin"]
        XCTAssertTrue(pin.waitForExistence(timeout: 10))
        pin.tap()
        let note = app.staticTexts["buses-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 3))
        XCTAssertEqual(note.label, "You can pin up to 8 stops")
        shot("buses-pins-full-en-light", app)
        XCTAssertEqual(app.buttons["buses-pin"].label, "Pin this stop")
    }

    func testOpenedFromElsewhere() {
        let app = launch(extra: ["TERMINUS_OPEN_STOP": "UTOWN"])
        XCTAssertTrue(app.staticTexts["University Town"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.tabBars.buttons["Stops"].isSelected)
        waitForBoard(app, svc: "D2")
        shot("buses-opened-stop-en-light", app)
        // Back is the tab's home.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["service-A1"].waitForExistence(timeout: 10))
    }

    func testNoConnection() {
        let app = launch(extra: ["TERMINUS_API_BASE": "http://localhost:9"])
        openBuses(app)
        XCTAssertTrue(app.staticTexts["Couldn't reach terminus. Check your connection and try again."].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Try again"].exists)
        shot("buses-offline-en-light", app)
    }

    /// The same screens in dark, in Chinese, and at a large text size.
    func testLooks() {
        for (lang, theme, big) in [("en", "dark", false), ("zh", "light", false), ("zh", "dark", false), ("en", "light", true)] {
            let tag = "\(lang)-\(theme)\(big ? "-xxl" : "")"
            resetProfile()
            let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme)
            if big { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"] }
            app.launch()
            allowLocation()
            openBuses(app, lang: lang)
            XCTAssertTrue(app.buttons["service-A1"].waitForExistence(timeout: 10))
            shot("buses-home-empty-\(tag)", app)
            app.terminate()
            setProfile { $0["pinnedStops"] = ["PGPR", "UTOWN"] }
            app.launch()
            openBuses(app, lang: lang)
            waitForSign(app, "PGPR", svc: "K")
            shot("buses-home-pinned-\(tag)", app)
            app.swipeUp()
            shot("buses-home-lines-\(tag)", app)
            app.swipeDown()
            app.buttons["nearby.PGPR"].tap()
            app.buttons["side-1"].tap()
            waitForBoard(app, svc: "A1")
            shot("buses-across-\(tag)", app)
            app.buttons["board-row-A1"].tap()
            XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 10))
            sleep(1)
            shot("buses-line-\(tag)", app)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            app.navigationBars.buttons.element(boundBy: 0).tap()
            let field = app.textFields["buses-search"]
            XCTAssertTrue(field.waitForExistence(timeout: 5))
            field.tap()
            field.typeText("a")
            sleep(1)
            shot("buses-search-\(tag)", app)
            app.terminate()
        }
    }
}

extension XCUIElement {
    /// Whether it's the chosen one within `timeout`: a segment after a tap or a swipe.
    func waitForSelected(timeout: TimeInterval = 5) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if exists && isSelected { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        return false
    }
}

// MARK: the stub's account

/// The test account's pins and public buses put back as the stub starts them.
func resetProfile() {
    let (token, _) = stubSession()
    var p = apiJSON("GET", "/api/me/profile", token: token) ?? [:]
    p["pinnedStops"] = []
    p["publicBuses"] = false
    _ = apiJSON("PUT", "/api/me/profile", token: token, body: p)
}

func setProfile(_ change: (inout [String: Any]) -> Void) {
    let (token, _) = stubSession()
    var p = apiJSON("GET", "/api/me/profile", token: token) ?? [:]
    change(&p)
    _ = apiJSON("PUT", "/api/me/profile", token: token, body: p)
}

@discardableResult
func apiJSON(_ method: String, _ path: String, token: String?, body: [String: Any]? = nil) -> [String: Any]? {
    var req = URLRequest(url: URL(string: stub + path)!)
    req.httpMethod = method
    if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
    if let body {
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
    }
    return (try? JSONSerialization.jsonObject(with: stubFetch(req))) as? [String: Any]
}
