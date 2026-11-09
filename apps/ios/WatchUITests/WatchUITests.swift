import XCTest

/// The watch app against the dev stub, as the iPhone's UI tests run:
/// TERMINUS_STUB in the runner's environment (TEST_RUNNER_TERMINUS_STUB on
/// xcodebuild's command line), signed in with a stub session's token.
final class WatchUITests: XCTestCase {
    private let stub = ProcessInfo.processInfo.environment["TERMINUS_STUB"] ?? "http://localhost:8787"

    override func setUp() {
        continueAfterFailure = false
    }

    private func post(_ path: String) -> Data {
        var req = URLRequest(url: URL(string: stub + path)!)
        req.httpMethod = "POST"
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var out = Data()
        URLSession.shared.dataTask(with: req) { d, _, _ in
            out = d ?? Data()
            done.signal()
        }.resume()
        done.wait()
        return out
    }

    private func app(signedIn: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TERMINUS_API_BASE"] = stub
        app.launchEnvironment["TERMINUS_RESET"] = "1"
        app.launchEnvironment["TERMINUS_LANG"] = "en"
        if signedIn {
            _ = post("/__stub/reset")
            _ = post("/__stub/class?in=50")
            let o = (try? JSONSerialization.jsonObject(with: post("/__stub/session"))) as? [String: Any]
            app.launchEnvironment["TERMINUS_TOKEN"] = try? XCTUnwrap(o?["token"] as? String)
        }
        return app
    }

    private func shot(_ name: String, _ app: XCUIApplication) {
        let a = XCTAttachment(screenshot: app.screenshot())
        a.name = name
        a.lifetime = .keepAlways
        add(a)
    }

    /// Not signed in: where to set it up, and nothing else.
    func testUnpairedSaysWhereToSetUp() {
        let app = app(signedIn: false)
        app.launch()
        XCTAssertTrue(app.staticTexts["setup.title"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["targets"].firstMatch.exists)
        shot("setup", app)
    }

    /// Signed in: the trip to the stub's class, then Nearby from the list, then signing out back to setup.
    func testNowNearbyAndSignOut() {
        let app = app(signedIn: true)
        app.launch()
        // "To GEA1000 @ UTown" heads the card whether it says when to leave or, with the
        // simulator's location at the stop, which bus to catch.
        let trip = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'GEA1000'")).firstMatch
        XCTAssertTrue(trip.waitForExistence(timeout: 30), "the trip to the class")
        shot("now", app)

        app.buttons["targets"].firstMatch.tap()
        XCTAssertTrue(app.buttons["target.Next"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["target.KR MRT"].exists, "the account's favourites")
        app.buttons["target.Nearby"].tap()
        XCTAssertTrue(
            app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearby.stop.'")).firstMatch
                .waitForExistence(timeout: 30))
        shot("nearby", app)

        app.buttons["targets"].firstMatch.tap()
        XCTAssertTrue(app.buttons["target.Next"].waitForExistence(timeout: 10))
        // At the foot of the list, under the favourites: a list draws its rows as they scroll in.
        let signOut = app.buttons["signOut"]
        for _ in 0..<6 where !(signOut.exists && signOut.isHittable) { app.swipeUp() }
        XCTAssertTrue(signOut.waitForExistence(timeout: 5))
        signOut.tap()
        let confirm = app.buttons["Sign out"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(app.staticTexts["setup.title"].waitForExistence(timeout: 15))
        shot("signed-out", app)
    }
}
