import XCTest

/// The welcome screen, signing in, pairing and the setup, tapped through
/// against the dev stub. Sign-in codes and approval links are read from the
/// stub's log (TERMINUS_STUB_LOG, /tmp/stub-onboarding.log by default): the
/// tests run on the same Mac.
@MainActor
final class OnboardingUITests: XCTestCase {
    nonisolated override func setUp() {
        continueAfterFailure = false
    }

    // MARK: welcome

    func testWelcomeInEveryLook() {
        for (lang, theme) in [("en", "light"), ("en", "dark"), ("zh", "light"), ("zh", "dark")] {
            let app = XCUIApplication.terminus(lang: lang, theme: theme)
            app.launch()
            XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 10))
            shot("welcome-\(lang)-\(theme)", app)
            app.terminate()
        }
    }

    func testLanguageSwitchRedrawsInChinese() {
        let app = XCUIApplication.terminus(lang: "en")
        app.launch()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 10))
        app.buttons["welcome.lang.zh"].tap()
        XCTAssertTrue(app.buttons["开始"].waitForExistence(timeout: 5))
        app.buttons["welcome.lang.en"].tap()
        XCTAssertTrue(app.buttons["Get started"].waitForExistence(timeout: 5))
    }

    // MARK: setup

    /// Get started, then every step of the setup with something chosen on each, to the tabs.
    func testGetStartedThroughSetup() {
        let app = XCUIApplication.terminus(lang: "en", theme: "light")
        app.launch()
        start(app)

        // Home: nothing chosen yet, so the big button is the skip.
        XCTAssertTrue(app.buttons["setup.later"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["home.PGP"].waitForExistence(timeout: 10))
        shot("setup-1-home-empty", app)
        app.buttons["home.PGP"].tap()
        XCTAssertTrue(app.buttons["setup.next"].waitForExistence(timeout: 5))
        let walk = app.steppers["home.walk"]
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        walk.buttons.element(boundBy: 1).tap()
        shot("setup-1-home-pgp", app)
        app.buttons["home.off"].tap()
        XCTAssertTrue(app.buttons["home.stop"].waitForExistence(timeout: 5))
        shot("setup-1-home-off", app)
        app.buttons["home.UTR"].tap()
        app.buttons["setup.next"].tap()

        // Classes: a link imported, and the class the stub can't place (off campus) given a stop.
        let link = app.textFields["classes.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        shot("setup-2-classes-empty", app)
        link.tap()
        link.typeText("https://nusmods.com/timetable/sem-1/share?CS2030=LAB:1,TUT:1,LEC:1")
        app.buttons["classes.import"].tap()
        XCTAssertTrue(app.staticTexts["classes.summary"].waitForExistence(timeout: 15))
        dismissKeyboard(app)
        shot("setup-2-classes-imported", app)
        let skip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'classes.skip.'"))
        XCTAssertEqual(skip.count, 1)
        let search = app.textFields["Choose a stop"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("COM3")
        let result = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'COM3'")).firstMatch
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        shot("setup-2-classes-placing", app)
        result.tap()
        XCTAssertEqual(skip.count, 0)
        dismissKeyboard(app)
        shot("setup-2-classes-week", app)
        app.buttons["setup.next"].tap()

        // Pace.
        XCTAssertTrue(app.buttons["pace.fast"].waitForExistence(timeout: 5))
        shot("setup-3-pace", app)
        app.buttons["pace.fast"].tap()
        XCTAssertTrue(app.staticTexts["4 min"].waitForExistence(timeout: 3))
        app.segmentedControls["pace.clock"].buttons["18:36"].tap()
        app.switches["pace.busy"].switches.firstMatch.tap()
        shot("setup-3-pace-changed", app)
        // Back and on again keeps what was chosen.
        app.buttons["setup.back"].tap()
        XCTAssertTrue(app.textFields["classes.link"].waitForExistence(timeout: 5))
        app.buttons["setup.next"].tap()
        XCTAssertTrue(app.buttons["pace.fast"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["pace.fast"].isSelected)
        app.buttons["setup.next"].tap()

        // Alerts: both asked for, each answered by the system's own question.
        XCTAssertTrue(app.buttons["setup.back"].waitForExistence(timeout: 5))
        shot("setup-4-alerts", app)
        allowSystemAlert(app, tapping: app.buttons["alerts.notify"])
        allowSystemAlert(app, tapping: app.buttons["alerts.location"])
        XCTAssertTrue(app.descendants(matching: .any)["alerts.location.done"].waitForExistence(timeout: 10))
        shot("setup-4-alerts-done", app)
        app.buttons["setup.next"].tap()
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
    }

    /// The steps in dark and in Chinese, ending with Skip setup.
    func testSetupLooks() {
        for (lang, theme) in [("en", "dark"), ("zh", "light"), ("zh", "dark")] {
            let app = XCUIApplication.terminus(lang: lang, theme: theme)
            app.launch()
            start(app)
            XCTAssertTrue(app.buttons["home.PGP"].waitForExistence(timeout: 10))
            app.buttons["home.PGP"].tap()
            XCTAssertTrue(app.buttons["setup.next"].waitForExistence(timeout: 5))
            shot("look-\(lang)-\(theme)-1-home", app)
            app.buttons["setup.next"].tap()
            let link = app.textFields["classes.link"]
            XCTAssertTrue(link.waitForExistence(timeout: 5))
            link.tap()
            link.typeText("https://nusmods.com/timetable/sem-1/share?CS2030=LAB:1&XX9999=LEC:1")
            app.buttons["classes.import"].tap()
            XCTAssertTrue(app.staticTexts["classes.summary"].waitForExistence(timeout: 15))
            dismissKeyboard(app)
            shot("look-\(lang)-\(theme)-2-classes", app)
            app.buttons["setup.next"].tap()
            XCTAssertTrue(app.buttons["pace.fast"].waitForExistence(timeout: 5))
            shot("look-\(lang)-\(theme)-3-pace", app)
            app.buttons["setup.next"].tap()
            XCTAssertTrue(
                app.buttons["alerts.notify"].waitForExistence(timeout: 5) || app.descendants(matching: .any)["alerts.notify.done"].exists)
            shot("look-\(lang)-\(theme)-4-alerts", app)
            app.buttons["setup.skipAll"].tap()
            XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 10))
            app.terminate()
        }
    }

    /// A link that isn't one: the server's words, in the step, and Continue stays put.
    func testImportFailureIsSaid() {
        let app = XCUIApplication.terminus(lang: "en")
        app.launch()
        start(app)
        XCTAssertTrue(app.buttons["setup.later"].waitForExistence(timeout: 10))
        app.buttons["setup.later"].tap()
        let link = app.textFields["classes.link"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        link.typeText("not a link")
        app.buttons["setup.next"].tap()
        XCTAssertTrue(app.staticTexts["setup.message"].waitForExistence(timeout: 10))
        XCTAssertTrue(link.exists)
        dismissKeyboard(app)
        shot("setup-2-classes-error", app)
    }

    // MARK: signing in

    /// The test account, with the code from the email typed in: it's set up, so straight to the tabs.
    func testSignInWithTheCode() {
        let app = XCUIApplication.terminus(lang: "en", theme: "light")
        app.launch()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 10))
        app.buttons["welcome.signIn"].tap()
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["signIn.action"].isEnabled)
        email.typeText("you@u")
        XCTAssertFalse(app.buttons["signIn.action"].isEnabled, "not an address yet")
        email.typeText(".nus.edu")
        shot("signin-1-email", app)
        let before = logLines()
        app.buttons["signIn.action"].tap()
        let field = app.textFields["signIn.code"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        let (code, _) = signInEmail(after: before)
        shot("signin-2-waiting", app)
        // A wrong code first: the server says so, and the boxes stay.
        field.typeText(code == "222222" ? "333333" : "222222")
        XCTAssertTrue(app.staticTexts["signIn.message"].waitForExistence(timeout: 10))
        shot("signin-3-wrong-code", app)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        field.typeText(code)
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))
    }

    /// A new address, approved from the email by its number: a new account, so the setup follows.
    func testSignInApprovedFromTheEmail() {
        let app = XCUIApplication.terminus(lang: "zh", theme: "dark")
        app.launch()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 10))
        app.buttons["welcome.signIn"].tap()
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.typeText("new\(Int.random(in: 10_000...99_999))@u.nus.edu")
        let before = logLines()
        app.buttons["signIn.action"].tap()
        let match = app.descendants(matching: .any).matching(identifier: "signIn.match").firstMatch
        XCTAssertTrue(match.waitForExistence(timeout: 10))
        dismissKeyboard(app)
        shot("signin-zh-dark-waiting", app)
        let (_, link) = signInEmail(after: before)
        let number = match.label.components(separatedBy: CharacterSet.decimalDigits.inverted).joined()
        approve(link: link, number: number)
        XCTAssertTrue(app.descendants(matching: .any)["setup.progress"].waitForExistence(timeout: 15))
        shot("signin-zh-dark-then-setup", app)
    }

    /// "Use a different email" goes back to the address; Back to the welcome screen.
    func testDifferentEmailAndBack() {
        let app = XCUIApplication.terminus(lang: "en")
        app.launch()
        XCTAssertTrue(app.buttons["welcome.signIn"].waitForExistence(timeout: 10))
        app.buttons["welcome.signIn"].tap()
        let email = app.textFields["signIn.email"]
        XCTAssertTrue(email.waitForExistence(timeout: 5))
        email.typeText("other\(Int.random(in: 10_000...99_999))@u.nus.edu")
        app.buttons["signIn.action"].tap()
        XCTAssertTrue(app.buttons["Use a different email"].waitForExistence(timeout: 10))
        app.buttons["Use a different email"].tap()
        XCTAssertTrue(app.textFields["signIn.email"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 5))
    }

    // MARK: pairing

    func testPairWithACode() {
        let app = XCUIApplication.terminus(lang: "en", theme: "light")
        app.launch()
        XCTAssertTrue(app.buttons["welcome.pair"].waitForExistence(timeout: 10))
        app.buttons["welcome.pair"].tap()
        let field = app.textFields["pair.code"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        shot("pair-1-empty", app)
        // A code nobody made: the server's words.
        field.typeText("zz-zz zz")
        XCTAssertTrue(app.staticTexts["pair.error"].waitForExistence(timeout: 10))
        shot("pair-2-wrong", app)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 6))
        let code = freshPairCode()
        field.typeText(String(code.prefix(3)))
        shot("pair-3-typing", app)
        field.typeText(String(code.dropFirst(3)))
        XCTAssertTrue(app.tabBars.firstMatch.waitForExistence(timeout: 15))
    }

    func testPairAndSignInLooks() {
        let app = XCUIApplication.terminus(lang: "zh", theme: "dark")
        app.launch()
        XCTAssertTrue(app.buttons["welcome.pair"].waitForExistence(timeout: 10))
        app.buttons["welcome.pair"].tap()
        let field = app.textFields["pair.code"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.typeText("TES")
        shot("pair-zh-dark", app)
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["welcome.signIn"].tap()
        XCTAssertTrue(app.textFields["signIn.email"].waitForExistence(timeout: 5))
        shot("signin-zh-dark-email", app)
    }

    // MARK: helpers

    private func start(_ app: XCUIApplication) {
        let start = app.buttons["welcome.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
    }

    private func dismissKeyboard(_ app: XCUIApplication) {
        guard app.keyboards.count > 0 else { return }
        // A drag down the page dismisses it.
        app.swipeDown()
    }

    /// Taps `button`, then Allow on the system's question if it asks one.
    private func allowSystemAlert(_ app: XCUIApplication, tapping button: XCUIElement) {
        guard button.waitForExistence(timeout: 3) else { return }
        button.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow While Using App", "Allow"] {
            let b = springboard.alerts.buttons[label]
            if b.waitForExistence(timeout: 4) {
                b.tap()
                return
            }
        }
    }

    private var logPath: String { ProcessInfo.processInfo.environment["TERMINUS_STUB_LOG"] ?? "/tmp/stub-onboarding.log" }

    private func logLines() -> Int {
        ((try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "").components(separatedBy: "\n").count
    }

    /// The code and approval link from the sign-in email the stub logged after line `after`.
    private func signInEmail(after: Int) -> (String, String) {
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let lines = ((try? String(contentsOfFile: logPath, encoding: .utf8)) ?? "").components(separatedBy: "\n")
            if let line = lines.dropFirst(max(0, after - 1)).last(where: { $0.hasPrefix("sign-in code:") }) {
                let parts = line.split(separator: " ").map(String.init)
                if let i = parts.firstIndex(of: "code:"), let l = parts.firstIndex(of: "link:"), i + 1 < parts.count, l + 1 < parts.count {
                    return (parts[i + 1], parts[l + 1])
                }
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTFail("no sign-in email in \(logPath)")
        return ("", "")
    }

    /// Chooses `number` on the page the email links to, as someone reading it on a laptop would.
    private func approve(link: String, number: String) {
        guard let url = URL(string: link),
            let r = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "r" })?.value
        else {
            return XCTFail("bad link \(link)")
        }
        var req = URLRequest(url: URL(string: stub + "/auth/approve")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        req.httpBody = Data("r=\(r)&n=\(number)".utf8)
        XCTAssertEqual(send(req).status, 200)
    }

    /// A new pairing code for the stub's test account, as Settings › Add a device makes one.
    private func freshPairCode() -> String {
        let (token, _) = stubSession()
        var req = URLRequest(url: URL(string: stub + "/api/me/pair-code")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = Data("{}".utf8)
        struct R: Decodable { let code: String }
        let code = send(req).data.flatMap { try? JSONDecoder().decode(R.self, from: $0) }?.code ?? ""
        XCTAssertEqual(code.count, 6)
        return code
    }

    /// A request to the stub, waited for.
    private func send(_ req: URLRequest) -> (data: Data?, status: Int) {
        final class Box: @unchecked Sendable {
            var data: Data?
            var status = 0
        }
        let box = Box()
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            box.data = data
            box.status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            done.signal()
        }.resume()
        done.wait()
        return (box.data, box.status)
    }
}
