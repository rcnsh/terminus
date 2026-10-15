import CoreLocation
import XCTest

/// The Buses tab against the dev stub, tapped through: the nearest stop's
/// board, across the road, a pinned stop's page, the search, a service's
/// line, a service not running, the public buses, and the states without a
/// stop or a connection; with screenshots in light and dark, English and
/// Chinese. The stub runs with real hours on a Wednesday at 21:30
/// (STUB_HOURS=real STUB_NOW=2026-10-07T13:30:00Z), when R1 and R2 have
/// stopped and P has too, so a board has services running and not.
final class BusesUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
        resetProfile()
        stubPost("/__stub/freeze")
        // Prince George's Park.
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 1.2913, longitude: 103.7805))
    }

    override func tearDown() {
        resetProfile()
        stubPost("/__stub/thaw")
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
        let tab = app.tabBars.buttons[lang == "zh" ? "巴士" : "Buses"]
        XCTAssertTrue(tab.waitForExistence(timeout: 10))
        tab.tap()
    }

    private func waitForBoard(_ app: XCUIApplication, svc: String = "K") {
        let ok = app.buttons["board-row-\(svc)"].firstMatch.waitForExistence(timeout: 15)
        if !ok {
            shot("failed-board-\(svc)", app)
            try? app.debugDescription.write(toFile: "/tmp/buses-tree.txt", atomically: true, encoding: .utf8)
        }
        XCTAssertTrue(ok, "no \(svc) row on the board")
    }

    // MARK: tests

    func testNearestStopBoard() {
        let app = launch()
        openBuses(app)
        waitForBoard(app)
        XCTAssertTrue(
            app.staticTexts["Nearest stop · 80 m"].exists
                || app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Nearest stop'")).firstMatch.exists)
        shot("buses-home-en-light", app)
        // PGP Foyer and PGP are near each other, not across a road: their names.
        let other = app.buttons["side-1"]
        XCTAssertTrue(other.exists)
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

    func testSearchPinAndSwipe() {
        let app = launch()
        openBuses(app)
        waitForBoard(app)
        let field = app.textFields["buses-search"]
        field.tap()
        // Nothing typed: every service.
        XCTAssertTrue(app.buttons["hit-service:A1"].waitForExistence(timeout: 5))
        shot("buses-search-suggestions-en-light", app)
        field.typeText("com")
        XCTAssertTrue(app.buttons["hit-stop:COM3"].waitForExistence(timeout: 5))
        shot("buses-search-com-en-light", app)
        app.buttons["hit-stop:COM3"].tap()
        XCTAssertTrue(app.staticTexts["COM 3"].waitForExistence(timeout: 10))
        waitForBoard(app, svc: "D1")
        let pin = app.buttons["buses-pin"]
        XCTAssertEqual(pin.label, "Pin this stop")
        pin.tap()
        XCTAssertTrue(app.buttons["Unpin this stop"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Pinned"].waitForExistence(timeout: 5))
        shot("buses-stop-pinned-en-light", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        // Home now has a second page, the pinned stop, and a way to it.
        let next = app.buttons["buses-swipe-for"]
        XCTAssertTrue(next.waitForExistence(timeout: 10))
        XCTAssertTrue(next.label.contains("COM 3"))
        app.swipeLeft()
        XCTAssertTrue(app.staticTexts["Pinned"].waitForExistence(timeout: 10))
        waitForBoard(app, svc: "D1")
        shot("buses-home-pinned-page-en-light", app)
        // Unpinned there, its page goes.
        app.buttons["Unpin this stop"].tap()
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Nearest stop'")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["buses-swipe-for"].exists)
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
        waitForBoard(app)
    }

    func testLineFromTheBoard() {
        let app = launch()
        openBuses(app)
        waitForBoard(app, svc: "A2")
        app.buttons["board-row-A2"].tap()
        XCTAssertTrue(
            app.otherElements["line-running"].firstMatch.waitForExistence(timeout: 10)
                || app.staticTexts["3 buses running"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Your stop"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["On the way"].firstMatch.exists || app.staticTexts["At stop"].firstMatch.exists)
        shot("buses-line-en-light", app)
        app.swipeUp()
        shot("buses-line-scrolled-en-light", app)
        // A stop on the line opens its board, Back comes back to the line.
        let stop = app.buttons["line-stop-KR-MRT"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        stop.tap()
        XCTAssertTrue(app.staticTexts["Kent Ridge MRT"].waitForExistence(timeout: 10))
        waitForBoard(app, svc: "A1")
        shot("buses-line-stop-en-light", app)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 5))
        app.buttons["line-show-on-map"].tap()
        XCTAssertTrue(app.tabBars.buttons["Map"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["Map"].isSelected)
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

    func testPullToRefresh() {
        let app = launch()
        openBuses(app)
        waitForBoard(app)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)))
        let note = app.staticTexts["buses-note"]
        XCTAssertTrue(note.waitForExistence(timeout: 8))
        // Just asked: the server would send the same, so nothing is asked.
        XCTAssertTrue(note.label.hasPrefix("Up to date") || note.label == "Updated just now", note.label)
        shot("buses-pulled-en-light", app)
    }

    func testOpenedFromElsewhere() {
        let app = launch(extra: ["TERMINUS_OPEN_STOP": "UTOWN"])
        XCTAssertTrue(app.staticTexts["University Town"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.tabBars.buttons["Buses"].isSelected)
        waitForBoard(app, svc: "D2")
        shot("buses-opened-stop-en-light", app)
    }

    func testNoConnection() {
        let app = launch(extra: ["TERMINUS_API_BASE": "http://localhost:9"])
        openBuses(app)
        XCTAssertTrue(app.staticTexts["Couldn't reach terminus. Check your connection and try again."].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["Try again"].exists)
        shot("buses-offline-en-light", app)
    }

    func testHomeStopWithoutLocation() {
        app0.resetAuthorizationStatus(for: .location)
        let app = XCUIApplication.terminus(signedIn: true, lang: "en", theme: "light")
        app.launch()
        openBuses(app)
        waitForBoard(app)
        XCTAssertTrue(app.staticTexts["Your home stop"].waitForExistence(timeout: 5))
        shot("buses-home-stop-en-light", app)
    }

    func testNoStopAtAll() {
        // A new account has no home stop; without a location there's nothing to call nearest.
        app0.resetAuthorizationStatus(for: .location)
        let anon = apiJSON("POST", "/api/auth/anon", token: nil, body: ["name": "UI test", "platform": "ios"])
        let token = anon?["token"] as? String ?? ""
        let app = XCUIApplication.terminus(signedIn: false, lang: "en", theme: "light", extra: ["TERMINUS_TOKEN": token])
        app.launch()
        openBuses(app)
        XCTAssertTrue(app.staticTexts["Find your stop"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Allow location to see the stop nearest you, or search for a stop and pin it with the star."].exists)
        shot("buses-find-your-stop-en-light", app)
        app.buttons["buses-allow-location"].tap()
        allowLocation()
        // Allowed: the stop nearest you.
        waitForBoard(app)
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Nearest stop'")).firstMatch.waitForExistence(timeout: 10))
        _ = apiJSON("DELETE", "/api/me", token: token)
    }

    /// The same screens in dark, in Chinese, and at a large text size.
    func testLooks() {
        for (lang, theme, big) in [("en", "dark", false), ("zh", "light", false), ("zh", "dark", false), ("en", "light", true)] {
            let tag = "\(lang)-\(theme)\(big ? "-xxl" : "")"
            let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme)
            if big { app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"] }
            app.launch()
            allowLocation()
            openBuses(app, lang: lang)
            waitForBoard(app)
            shot("buses-home-\(tag)", app)
            app.buttons["side-1"].tap()
            waitForBoard(app, svc: "A1")
            shot("buses-across-\(tag)", app)
            app.buttons["board-row-A1"].tap()
            XCTAssertTrue(app.buttons["line-show-on-map"].waitForExistence(timeout: 10))
            sleep(1)
            shot("buses-line-\(tag)", app)
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

    private var app0: XCUIApplication { XCUIApplication() }
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
    let done = DispatchSemaphore(value: 0)
    var out: [String: Any]?
    URLSession.shared.dataTask(with: req) { data, _, _ in
        out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        done.signal()
    }.resume()
    done.wait()
    return out
}
