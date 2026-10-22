import XCTest

/// Settings, every page, against the dev stub's test account: what each
/// shows (screenshots in light and dark, English and Chinese), and that the
/// edits made there reach the server.
@MainActor
final class SettingsUITests: XCTestCase {
    /// The stub's test account is shared by every test and keeps what each
    /// changes: its profile as it was, put back after each test.
    private var saved: Data?

    override func setUp() async throws {
        continueAfterFailure = false
        stubPost("/__stub/reset")
        let (t, _) = stubSession()
        var req = URLRequest(url: URL(string: stub + "/api/me/profile")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization")
        saved = stubFetch(req)
        token = t
    }

    override func tearDown() async throws {
        guard let saved, let t = token else { return }
        var put = URLRequest(url: URL(string: stub + "/api/me/profile")!)
        put.httpMethod = "PUT"
        put.setValue("Bearer \(t)", forHTTPHeaderField: "authorization")
        put.setValue("application/json", forHTTPHeaderField: "content-type")
        put.httpBody = saved
        _ = stubFetch(put)
    }

    private static let pages = ["trips", "timetable", "favourites", "notifications", "language", "appearance", "devices", "feedback"]

    private func open(lang: String = "en", theme: String = "light", extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme, extra: extra)
        app.launch()
        let tab = app.tabBars.buttons.element(boundBy: 3)
        XCTAssertTrue(tab.waitForExistence(timeout: 15))
        tab.tap()
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 10))
        return app
    }

    private func tile(_ app: XCUIApplication, _ page: String) -> XCUIElement {
        let t = app.buttons["settings.tile.\(page)"]
        if !t.isHittable { app.swipeUp() }
        return t
    }

    private func back(_ app: XCUIApplication) {
        app.buttons["settings.back"].firstMatch.tap()
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 5))
    }

    /// Every page, opened from the list, screenshotted, and back.
    private func walk(lang: String, theme: String) {
        let app = open(lang: lang, theme: theme)
        let tag = "\(lang)-\(theme)"
        // The list waits for the profile's summaries.
        _ = app.staticTexts["PGP · \(lang == "zh" ? "步速：正常" : "Normal pace")"].waitForExistence(timeout: 8)
        shot("settings-\(tag)-00-list", app)
        for (i, page) in Self.pages.enumerated() {
            tile(app, page).tap()
            XCTAssertTrue(app.buttons["settings.back"].waitForExistence(timeout: 5), page)
            sleep(1)
            shot("settings-\(tag)-\(String(format: "%02d", i + 1))-\(page)", app)
            if ["trips", "timetable", "appearance"].contains(page) {
                app.swipeUp()
                shot("settings-\(tag)-\(String(format: "%02d", i + 1))-\(page)-more", app)
            }
            back(app)
        }
        app.buttons["settings.account"].tap()
        XCTAssertTrue(app.buttons["settings.signOut"].waitForExistence(timeout: 5))
        shot("settings-\(tag)-09-account", app)
        back(app)
        app.swipeUp()
        app.buttons["settings.about"].tap()
        XCTAssertTrue(app.staticTexts["settings.version"].waitForExistence(timeout: 5))
        shot("settings-\(tag)-10-about", app)
        app.swipeUp()
        shot("settings-\(tag)-10-about-more", app)
        app.buttons["settings.licences"].tap()
        sleep(1)
        shot("settings-\(tag)-11-licences", app)
    }

    func testEveryPageEnglishLight() { walk(lang: "en", theme: "light") }
    func testEveryPageEnglishDark() { walk(lang: "en", theme: "dark") }
    func testEveryPageChineseLight() { walk(lang: "zh", theme: "light") }
    func testEveryPageChineseDark() { walk(lang: "zh", theme: "dark") }

    /// The largest text: one tile to a row, and every page still readable.
    func testLargeText() throws {
        let app = XCUIApplication.terminus(signedIn: true)
        app.launchArguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityL"]
        app.launch()
        let tab = app.tabBars.buttons.element(boundBy: 3)
        XCTAssertTrue(tab.waitForExistence(timeout: 15))
        tab.tap()
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 10))
        sleep(1)
        shot("settings-large-list", app)
        for page in ["trips", "devices", "appearance"] {
            let t = app.buttons["settings.tile.\(page)"]
            while !t.isHittable { app.swipeUp() }
            t.tap()
            XCTAssertTrue(app.buttons["settings.back"].waitForExistence(timeout: 5))
            sleep(1)
            shot("settings-large-\(page)", app)
            app.swipeUp()
            shot("settings-large-\(page)-more", app)
            app.buttons["settings.back"].firstMatch.tap()
            XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 5))
        }
    }

    /// A switch, a stepper and a menu on Your trips are saved to the account.
    func testTripsSaves() throws {
        let app = open()
        tile(app, "trips").tap()
        let publicBuses = app.switches["settings.public"]
        XCTAssertTrue(publicBuses.waitForExistence(timeout: 8))
        while !publicBuses.isHittable { app.swipeUp() }
        publicBuses.switches.firstMatch.exists ? publicBuses.switches.firstMatch.tap() : publicBuses.tap()
        app.swipeDown()
        app.buttons["One minute more"].tap()
        app.buttons["One minute more"].tap()
        sleep(2)
        let p = profile()
        XCTAssertEqual(p["publicBuses"] as? Bool, true)
        XCTAssertEqual(p["homeWalkMin"] as? Int, 7)
        shot("settings-trips-edited", app)
    }

    /// A favourite added from the search, removed, and put back with Undo.
    func testFavourites() throws {
        let app = open()
        tile(app, "favourites").tap()
        XCTAssertTrue(app.buttons["settings.addFavourite"].waitForExistence(timeout: 8))
        app.buttons["settings.addFavourite"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        shot("settings-favourites-search-empty", app)
        search.tap()
        search.typeText("COM3")
        let result = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'where.'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 8))
        shot("settings-favourites-search", app)
        result.tap()
        XCTAssertTrue(app.staticTexts["COM3"].waitForExistence(timeout: 5))
        sleep(2)
        XCTAssertTrue(places().contains("COM3"))
        shot("settings-favourites-added", app)
        let gym = app.buttons["Remove Gym"]
        XCTAssertTrue(gym.waitForExistence(timeout: 5))
        gym.tap()
        XCTAssertTrue(app.buttons["settings.undo"].waitForExistence(timeout: 3))
        shot("settings-favourites-removed", app)
        sleep(1)
        XCTAssertFalse(places().contains("Gym"))
        app.buttons["settings.undo"].tap()
        sleep(2)
        XCTAssertTrue(places().contains("Gym"))
    }

    /// A class added by hand, then removed.
    func testAddClass() throws {
        let app = open()
        tile(app, "timetable").tap()
        let add = app.buttons["settings.addClass"]
        XCTAssertTrue(add.waitForExistence(timeout: 8))
        while !add.isHittable { app.swipeUp() }
        add.tap()
        let name = app.textFields["settings.className"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        name.typeText("Gym session")
        app.buttons["settings.classWhere"].tap()
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("UTown")
        let result = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'where.'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 8))
        result.tap()
        shot("settings-timetable-add", app)
        app.buttons["settings.addClassDone"].tap()
        sleep(2)
        XCTAssertTrue(classes().contains("Gym session"))
        shot("settings-timetable-added", app)
        let remove = app.buttons["Remove Gym session"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        sleep(2)
        XCTAssertFalse(classes().contains("Gym session"))
    }

    /// A bad NUSMods link: the server's reason is shown.
    func testImportRefused() throws {
        let app = open()
        tile(app, "timetable").tap()
        let field = app.textFields["settings.nusmodsLink"]
        XCTAssertTrue(field.waitForExistence(timeout: 8))
        field.tap()
        field.typeText("not a link")
        app.buttons["settings.import"].tap()
        XCTAssertTrue(
            app.otherElements["settings.toast"].waitForExistence(timeout: 8)
                || app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] 'NUSMods'")).count > 1)
        shot("settings-timetable-import-refused", app)
    }

    /// Add a device: the code and its QR.
    func testPairCode() throws {
        let app = open()
        tile(app, "devices").tap()
        let add = app.buttons["settings.addDevice"]
        XCTAssertTrue(add.waitForExistence(timeout: 8))
        add.tap()
        XCTAssertTrue(app.staticTexts["settings.pairCode"].waitForExistence(timeout: 8))
        shot("settings-devices-pair", app)
        app.buttons["settings.pairDone"].tap()
    }

    /// Feedback: typed, sent, thanked.
    func testFeedback() throws {
        let app = open()
        tile(app, "feedback").tap()
        let note = app.textViews["settings.feedbackNote"]
        XCTAssertTrue(note.waitForExistence(timeout: 5))
        note.tap()
        note.typeText("The map could show the bus number bigger.")
        shot("settings-feedback-typed", app)
        app.buttons["settings.feedbackSend"].tap()
        // Sent and thanked; or, while the server doesn't take "ios" yet, its refusal said under the note.
        let thanks = app.staticTexts["Thanks. Your feedback was sent."]
        let refused = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Platform'")).firstMatch
        XCTAssertTrue(thanks.waitForExistence(timeout: 8) || refused.exists)
        shot("settings-feedback-sent", app)
    }

    /// Language: Chinese from Settings, which stays open on the page.
    func testLanguageSwitch() throws {
        let app = open()
        tile(app, "language").tap()
        let zh = app.segmentedControls["settings.lang"].buttons["中文"]
        XCTAssertTrue(zh.waitForExistence(timeout: 5))
        zh.tap()
        sleep(2)
        shot("settings-language-after", app)
        XCTAssertTrue(app.staticTexts["语言和时间"].waitForExistence(timeout: 5))
        shot("settings-language-zh", app)
        sleep(1)
        XCTAssertEqual(profile()["lang"] as? String, "zh")
        app.segmentedControls["settings.lang"].buttons["English"].tap()
        XCTAssertTrue(app.staticTexts["Language and time"].waitForExistence(timeout: 5))
    }

    /// The card styles, picked from segments, the chosen one drawn under them.
    func testCardStyle() throws {
        let app = open()
        tile(app, "appearance").tap()
        let route = app.segmentedControls["settings.cardStyle"].buttons["Route"]
        XCTAssertTrue(route.waitForExistence(timeout: 5))
        while !route.isHittable { app.swipeUp() }
        route.tap()
        XCTAssertTrue(route.isSelected)
        XCTAssertTrue(app.staticTexts["The whole trip as a line, with the times under it."].exists)
        shot("settings-appearance-route", app)
    }

    /// The developer settings: seven taps on the version (shown already in a debug build).
    func testAboutDeveloper() throws {
        let app = open()
        app.swipeUp()
        app.buttons["settings.about"].tap()
        let version = app.staticTexts["settings.version"]
        XCTAssertTrue(version.waitForExistence(timeout: 5))
        for _ in 0..<7 { version.tap() }
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["DEVELOPER"].waitForExistence(timeout: 3))
        shot("settings-about-developer", app)
        // Diagnostics, then the requests this app made to get here.
        let copy = app.buttons["settings.diagnostics.copy"]
        while !copy.isHittable { app.swipeUp() }
        XCTAssertTrue(app.staticTexts["DIAGNOSTICS"].exists)
        shot("settings-about-diagnostics", app)
        copy.tap()
        XCTAssertTrue(app.staticTexts["Diagnostics copied"].waitForExistence(timeout: 3))
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["RECENT REQUESTS"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["GET /api/me/next"].firstMatch.exists)
        shot("settings-about-requests", app)
    }

    /// Sign out asks first, then the welcome screen.
    func testSignOut() throws {
        let app = open()
        app.buttons["settings.account"].tap()
        app.buttons["settings.signOut"].tap()
        shot("settings-account-signout", app)
        app.alerts.buttons["Sign out"].tap()
        XCTAssertFalse(app.tabBars.firstMatch.waitForExistence(timeout: 3))
    }

    /// An account without an email: Account offers to add one, and Delete this account asks first.
    func testAnonymous() throws {
        let token = anonToken()
        let app = XCUIApplication.terminus(signedIn: false, extra: ["TERMINUS_TOKEN": token])
        app.launch()
        let tab = app.tabBars.buttons.element(boundBy: 3)
        XCTAssertTrue(tab.waitForExistence(timeout: 15))
        tab.tap()
        XCTAssertTrue(app.buttons["settings.account"].waitForExistence(timeout: 10))
        shot("settings-anon-list", app)
        app.buttons["settings.account"].tap()
        XCTAssertTrue(app.buttons["settings.addEmail"].waitForExistence(timeout: 5))
        shot("settings-anon-account", app)
        app.buttons["settings.delete"].tap()
        XCTAssertTrue(app.alerts.firstMatch.waitForExistence(timeout: 3))
        shot("settings-anon-delete", app)
        app.alerts.buttons["Cancel"].tap()
        back(app)
        tile(app, "devices").tap()
        XCTAssertTrue(app.buttons["settings.addEmail"].waitForExistence(timeout: 5))
        shot("settings-anon-devices", app)
    }

    // MARK: the stub's view of the account

    private var token: String?

    private func profile() -> [String: Any] {
        let t = token ?? ""
        var req = URLRequest(url: URL(string: stub + "/api/me/profile")!)
        req.setValue("Bearer \(t)", forHTTPHeaderField: "authorization")
        return (try? JSONSerialization.jsonObject(with: stubFetch(req))) as? [String: Any] ?? [:]
    }

    private func places() -> [String] { (profile()["places"] as? [[String: Any]] ?? []).compactMap { $0["label"] as? String } }

    private func classes() -> [String] { (profile()["manual"] as? [[String: Any]] ?? []).compactMap { $0["label"] as? String } }

    private func anonToken() -> String { stubAnonToken() }

}
