import XCTest

/// The widgets, through SpringBoard as a person adds them: signed in against
/// the stub, then the widget gallery, then the home screen. SYS_LANG (en or
/// zh, TEST_RUNNER_SYS_LANG on xcodebuild's command line) picks the language;
/// the shots are named with SYS_TAG too, so a dark run (simctl ui appearance
/// dark) keeps its own.
@MainActor
final class SystemUITests: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let env = ProcessInfo.processInfo.environment
    var lang: String { env["SYS_LANG"] ?? "en" }
    var tag: String { [env["SYS_TAG"], lang].compactMap { $0 }.joined(separator: "-") }

    override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
    }

    /// Signed in, the app has fetched the card once, so the widgets have it.
    func launchSignedIn(extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, extra: extra)
        app.launch()
        XCTAssertTrue(app.tabBars.buttons.firstMatch.waitForExistence(timeout: 10))
        sleep(3)
        XCUIDevice.shared.press(.home)
        sleep(1)
        return app
    }

    func testGalleryOffersTheWidgets() {
        _ = launchSignedIn()
        clearWidgets()
        openGallery()
        let preview = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'terminus,'")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        sleep(1)
        shot("widget-gallery-\(tag)", springboard)
        springboard.buttons["close"].tap()
        doneEditing()
    }

    func testSmallAndMediumWidgets() {
        _ = launchSignedIn()
        clearWidgets()
        addWidget(page: 1)
        addWidget(page: 2)
        addWidget(page: 4)
        doneEditing()
        XCTAssertEqual(widgets().count, 3)
        sleep(3)
        shot("widgets-small-medium-\(tag)", springboard)
    }

    func testLargeWidgets() {
        _ = launchSignedIn()
        clearWidgets()
        addWidget(page: 3)
        doneEditing()
        sleep(3)
        shot("widget-large-\(tag)", springboard)
        clearWidgets()
        addWidget(page: 5)
        doneEditing()
        sleep(3)
        shot("widget-places-large-\(tag)", springboard)
    }

    /// Buses near you at each size, from the board the app fetched for Now's
    /// Nearby (shared with the widgets): small and medium, then large; the
    /// large Next bus widget's next buses under the trip, and the Nearby chip
    /// on the favourites widget; then with New to NUS, which heads each side
    /// with where its buses go.
    func testNearbyWidgets() {
        let app = launchSignedIn(extra: ["TERMINUS_NEW_TO_NUS": "0"])
        fetchNearby(app)
        clearWidgets()
        addWidget(page: 6)
        addWidget(page: 7)
        doneEditing()
        XCTAssertEqual(widgets().count, 2)
        sleep(3)
        shot("widgets-nearby-small-medium-\(tag)", springboard)
        clearWidgets()
        addWidget(page: 8)
        doneEditing()
        sleep(3)
        shot("widget-nearby-large-\(tag)", springboard)
        clearWidgets()
        addWidget(page: 3)
        doneEditing()
        sleep(3)
        shot("widget-large-next-buses-\(tag)", springboard)
        clearWidgets()
        addWidget(page: 4)
        doneEditing()
        sleep(2)
        let chip = springboard.buttons.matching(NSPredicate(format: "label == %@", lang == "zh" ? "查看 附近" : "Show Nearby")).firstMatch
        if chip.waitForExistence(timeout: 10) {
            chip.tap()
            sleep(4)
            shot("widget-places-nearby-\(tag)", springboard)
        }
        // New to NUS, switched on in the app: the widgets redraw.
        clearWidgets()
        app.terminate()
        app.launchEnvironment["TERMINUS_RESET"] = "0"
        app.launchEnvironment["TERMINUS_NEW_TO_NUS"] = "1"
        app.launch()
        fetchNearby(app)
        addWidget(page: 7)
        addWidget(page: 8)
        doneEditing()
        sleep(3)
        shot("widgets-nearby-new-\(tag)", springboard)
        clearAfter()
    }

    /// Now's Nearby opened, as a widget's tap does: the app fetches the board the widgets share.
    func fetchNearby(_ app: XCUIApplication) {
        app.open(URL(string: "terminus://nearby")!)
        sleep(4)
        XCUIDevice.shared.press(.home)
        sleep(1)
    }

    /// A tap on the widget opens the app.
    func testTapOpensTheApp() throws {
        let app = launchSignedIn()
        clearWidgets()
        addWidget(page: 2)
        doneEditing()
        sleep(2)
        let widget = try XCTUnwrap(shownWidget(), "the widget on the home screen")
        widget.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.6)).tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        clearAfter()
    }

    /// With the leave alerts and the Live Activity on, and the trip under
    /// way (the stub told "left"): the Live Activity in Notification Centre.
    func testLiveActivity() throws {
        let (token, email) = stubSession()
        let extra = ["TERMINUS_ALERTS": "1", "TERMINUS_LIVE": "1", "TERMINUS_TOKEN": token, "TERMINUS_EMAIL": email]
        let app = XCUIApplication.terminus(signedIn: false, lang: lang, extra: extra)
        app.launch()
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 8) { allow.tap() }
        XCTAssertTrue(app.tabBars.buttons.firstMatch.waitForExistence(timeout: 10))
        sleep(3)
        // Only a trip with a key can be started: a class, not the way home.
        guard signal("left", token: token) else { throw XCTSkip("the stub's plan now has no trip to start") }
        // Opened again, the app fetches the card in its new phase and starts the Live Activity.
        app.terminate()
        app.launchEnvironment["TERMINUS_RESET"] = "0"
        app.launch()
        // The Next tab asked for, as a widget's tap does: the app fetches the card.
        app.open(URL(string: "terminus://plan")!)
        sleep(6)
        XCUIDevice.shared.press(.home)
        sleep(2)
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.005))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.7)))
        sleep(2)
        // Live Activities ask, the first time, whether to keep showing them.
        for label in ["Always Allow", "Allow"] where springboard.buttons[label].exists {
            springboard.buttons[label].tap()
            sleep(1)
        }
        let activity = springboard.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'terminus,'")).firstMatch
        XCTAssertTrue(activity.waitForExistence(timeout: 5), "the Live Activity shows")
        shot("live-activity-\(tag)", springboard)
        XCUIDevice.shared.press(.home)
    }

    /// Tells the stub the trip's step ("left", "boarded", "reset"), for the
    /// card's trip; false when the card has none.
    @discardableResult
    func signal(_ kind: String, token: String) -> Bool {
        func call(_ path: String, body: [String: Any]? = nil) -> [String: Any]? {
            var req = URLRequest(url: URL(string: stub + path)!)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
            if let body {
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "content-type")
                req.httpBody = try? JSONSerialization.data(withJSONObject: body)
            }
            let done = DispatchSemaphore(value: 0)
            nonisolated(unsafe) var out: [String: Any]?
            URLSession.shared.dataTask(with: req) { data, _, _ in
                out = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                done.signal()
            }.resume()
            done.wait()
            return out
        }
        let next = call("/api/me/next?lat=1.2913&lng=103.7805")
        let card = next?["card"] as? [String: Any]
        let trip = (card?["actions"] as? [[String: Any]])?.first?["trip"] as? String
        guard let trip else { return false }
        return call("/api/me/signal", body: ["kind": kind, "trip": trip]) != nil
    }

    /// The Lock Screen's three: added through its Customise, then the Lock Screen itself.
    func testLockScreenWidgets() {
        _ = launchSignedIn()
        openCoverSheet()
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).press(forDuration: 2)
        let customise = springboard.buttons["posterboard-customize-button"]
        XCTAssertTrue(customise.waitForExistence(timeout: 5))
        customise.tap()
        let inlineSpot = springboard.buttons["inline-widget-reticle-view"]
        XCTAssertTrue(inlineSpot.waitForExistence(timeout: 5))
        sleep(1)
        // Added on an earlier run: kept, as a Lock Screen holds only so many.
        if inlineSpot.label.hasPrefix("terminus"), springboard.icons.matching(identifier: "terminus").count >= 2 {
            springboard.buttons["editing-cancel"].tap()
        } else {
            addLockWidgets()
            springboard.buttons["editing-done"].tap()
        }
        sleep(2)
        // Out of editing, the Lock Screen as it shows.
        let poster = springboard.cells.matching(NSPredicate(format: "identifier BEGINSWITH 'posterboard-posteruuid'")).firstMatch
        if poster.exists { poster.tap() }
        sleep(3)
        XCTAssertTrue(
            springboard.otherElements.matching(NSPredicate(format: "identifier == 'sh.rcn.terminus.widgets:next'")).count
                + springboard.buttons.matching(NSPredicate(format: "identifier == 'sh.rcn.terminus.widgets:next'")).count > 0)
        shot("lock-widgets-\(tag)", springboard)
        XCUIDevice.shared.press(.home)
    }

    /// Rectangular and circular in the row under the clock, then the line above it.
    func addLockWidgets() {
        springboard.buttons["grouped-widgets-reticle-view"].firstMatch.tap()
        openLockGallery()
        let previews = springboard.buttons.matching(NSPredicate(format: "label == 'terminus, Next bus'"))
        for family in ["Rectangular", "Circular"] {
            let p = previews.matching(NSPredicate(format: "value ENDSWITH %@", family)).firstMatch
            XCTAssertTrue(p.waitForExistence(timeout: 5))
            p.tap()
            sleep(1)
        }
        // Back to the list, the sheet down, then the line above the clock.
        springboard.buttons["close"].firstMatch.tap()
        sleep(1)
        dismissSheet()
        springboard.buttons["inline-widget-reticle-view"].tap()
        // The line's own list: a row per widget, "terminus, Next bus, …".
        let row = springboard.cells.matching(NSPredicate(format: "label BEGINSWITH 'terminus,'")).firstMatch
        XCTAssertTrue(springboard.cells.firstMatch.waitForExistence(timeout: 5))
        for _ in 0..<8 where !(row.exists && row.isHittable) {
            springboard.cells.element(boundBy: 0).swipeUp()
            sleep(1)
        }
        XCTAssertTrue(row.exists, "terminus in the line's widgets")
        row.tap()
        sleep(1)
        dismissSheet()
    }

    func openCoverSheet() {
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.005))
        top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.7)))
        sleep(2)
    }

    /// The Lock Screen's widget sheet put away, by a swipe down on its grabber.
    func dismissSheet() {
        let grabber = springboard.buttons["Sheet Grabber"].firstMatch
        guard grabber.exists else { return }
        grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        sleep(1)
    }

    /// In the Lock Screen's widget sheet, terminus's widgets.
    func openLockGallery() {
        let cell = springboard.cells["terminus"]
        XCTAssertTrue(springboard.cells.firstMatch.waitForExistence(timeout: 5))
        sleep(1)
        for _ in 0..<6 where !(cell.exists && cell.isHittable) {
            springboard.cells.element(boundBy: 0).swipeUp()
            sleep(1)
        }
        XCTAssertTrue(cell.exists, "terminus in the Lock Screen's widgets")
        cell.tap()
        sleep(1)
    }

    // MARK: SpringBoard

    func widgets() -> XCUIElementQuery {
        springboard.icons.matching(NSPredicate(format: "identifier == 'terminus' AND value == 'Widget'"))
    }

    /// The terminus widget on the screen. SpringBoard also lists one off its
    /// left edge (x < 0), where a tap does nothing, and lists it first.
    func shownWidget() -> XCUIElement? {
        let screen = springboard.frame
        for _ in 0..<10 {
            if let w = widgets().allElementsBoundByIndex.first(where: { screen.contains($0.frame) }) { return w }
            sleep(1)
        }
        return nil
    }

    func editHomeScreen() {
        if !springboard.buttons["Edit"].exists {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).press(forDuration: 1.5)
        }
        XCTAssertTrue(springboard.buttons["Edit"].waitForExistence(timeout: 5))
    }

    func doneEditing() {
        let done = springboard.buttons["Done"]
        if done.exists { done.tap() }
        sleep(1)
    }

    /// Takes off every terminus widget from the home screen, on every page
    /// (an earlier run can leave one on another), so each test starts from none.
    func clearWidgets() {
        guard widgets().count > 0 else { return }
        editHomeScreen()
        let screen = springboard.frame
        for _ in 0..<40 {
            guard let widget = widgets().allElementsBoundByIndex.first else { break }
            // On another page: turned to, a page at a time.
            if widget.frame.maxX <= screen.minX || widget.frame.minX >= screen.maxX {
                turnPage(back: widget.frame.maxX <= screen.minX)
                continue
            }
            widget.buttons["DeleteButton"].tap()
            let remove = springboard.buttons["Remove"]
            XCTAssertTrue(remove.waitForExistence(timeout: 5))
            remove.tap()
            sleep(1)
        }
        XCTAssertEqual(widgets().count, 0, "every terminus widget taken off")
        doneEditing()
    }

    /// The home screen's next page, or the one before: a swipe low on the
    /// screen, under the icons, so it moves no icon.
    func turnPage(back: Bool) {
        let from = springboard.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.1 : 0.9, dy: 0.76))
        let to = springboard.coordinate(withNormalizedOffset: CGVector(dx: back ? 0.9 : 0.1, dy: 0.76))
        from.press(forDuration: 0.05, thenDragTo: to)
        sleep(1)
    }

    func clearAfter() {
        XCUIDevice.shared.press(.home)
        sleep(1)
        clearWidgets()
    }

    /// The gallery, searched for terminus, at its first widget.
    func openGallery() {
        editHomeScreen()
        springboard.buttons["Edit"].tap()
        let add = springboard.buttons["Add Widget"]
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        let search = springboard.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("terminus")
        let app = springboard.cells.containing(.staticText, identifier: "terminus").firstMatch
        XCTAssertTrue(app.waitForExistence(timeout: 5))
        app.tap()
    }

    /// The gallery's page'th terminus widget (1: Next bus small, 2 medium,
    /// 3 large, 4 Next bus + favourites medium, 5 large, 6 Buses near you
    /// small, 7 medium, 8 large), added.
    func addWidget(page: Int) {
        openGallery()
        let preview = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'terminus,'")).firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 5))
        for n in 1..<page {
            let shown = springboard.buttons.matching(NSPredicate(format: "label BEGINSWITH 'terminus,'")).allElementsBoundByIndex.first {
                $0.isHittable
            }
            XCTAssertNotNil(shown, "gallery page \(n)")
            shown?.swipeLeft()
            usleep(800_000)
        }
        let dots = springboard.pageIndicators.matching(NSPredicate(format: "value BEGINSWITH 'page'")).firstMatch
        XCTAssertEqual(dots.value as? String, "page \(page) of 8")
        let add = springboard.buttons.matching(NSPredicate(format: "label ENDSWITH 'Add Widget' AND label != 'Add Widget'")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5))
        add.tap()
        sleep(1)
    }
}
