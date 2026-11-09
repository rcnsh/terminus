import CoreLocation
import XCTest

/// The App Store screenshots' captures (apps/ios/store/captures), one test a
/// scene, against the dev stub on a Thursday at 09:26 with GEA1000 at 10:00,
/// as the Play set was taken. Only with STORE_LANG (en or zh,
/// TEST_RUNNER_STORE_LANG on xcodebuild's command line): the scenes move the
/// stub's clock and the home screen's widgets, which the other suites mustn't
/// meet. Run by apps/ios/store/capture.sh, which sets the status bar's time
/// for each scene.
@MainActor
final class StoreShotsUITests: XCTestCase {
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let env = ProcessInfo.processInfo.environment
    var lang: String { env["STORE_LANG"] ?? "en" }

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard env["STORE_LANG"] != nil else { throw XCTSkip("store screenshots only with STORE_LANG") }
        stubPost("/__stub/freeze")
        stubPost("/__stub/at?t=2026-10-09T01:26:00Z")
        stubPost("/__stub/class?in=34")
        // capture.sh's TURN=1: the iPad on its side; upright otherwise, so a
        // turned simulator doesn't stay turned for the next run.
        XCUIDevice.shared.orientation = env["STORE_TURN"] == "1" ? .landscapeLeft : .portrait
    }

    func place(_ lat: Double, _ lng: Double) {
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: lat, longitude: lng))
    }

    /// Signed in as the stub's test account, light, at `sky`'s hour. Not
    /// XCUIApplication.terminus(signedIn:), which moves the class to 50 minutes on.
    func launch(sky: String = "dawn", token: String? = nil, extra: [String: String] = [:]) -> XCUIApplication {
        // A short walk north of PGP, so the trip starts there; the bus's scene moves on from it.
        if extra["at"] == nil { place(1.2927, 103.7803) }
        let app = XCUIApplication()
        app.launchEnvironment["TERMINUS_API_BASE"] = stub
        app.launchEnvironment["TERMINUS_RESET"] = "1"
        app.launchEnvironment["TERMINUS_LANG"] = lang
        app.launchEnvironment["TERMINUS_THEME"] = "light"
        app.launchEnvironment["TERMINUS_SKY"] = sky
        app.launchEnvironment["TERMINUS_TOKEN"] = token ?? stubSession().0
        app.launchEnvironment["TERMINUS_EMAIL"] = "you@u.nus.edu"
        for (k, v) in extra where k != "at" { app.launchEnvironment[k] = v }
        app.launch()
        XCTAssertTrue(tab(app, 0).waitForExistence(timeout: 15))
        return app
    }

    /// Tab `i` (Now, Stops, Map, Settings): in the tab bar, or in the rail
    /// beside the page on a wide window (the open Duo), which isn't a tab bar.
    func tab(_ app: XCUIApplication, _ i: Int) -> XCUIElement {
        if app.tabBars.buttons.count > i { return app.tabBars.buttons.element(boundBy: i) }
        let names = lang == "zh" ? ["现在", "车站", "地图", "设置"] : ["Now", "Stops", "Map", "Settings"]
        return app.buttons[names[i]].firstMatch
    }

    func save(_ file: String, _ target: XCUIApplication) {
        // On the open Duo and an iPad on its side, XCUITest's own screenshot
        // comes out sideways or black: capture.sh (SHOT_DISPLAY) takes it
        // with simctl instead, when this asks and until the picture is there.
        guard env["STORE_HOST_SHOT"] == "1", let dir = env["TERMINUS_SHOTS"] else { return shot("\(lang)-\(file)", target) }
        let png = "\(dir)/\(lang)-\(file).png"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: "\(dir)/\(lang)-\(file).ready", contents: nil)
        for _ in 0..<60 where !FileManager.default.fileExists(atPath: png) { usleep(500_000) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: png), "capture.sh took no screenshot")
    }

    func test1LeaveBy() {
        let app = launch()
        XCTAssertTrue(app.descendants(matching: .any)["now.card"].waitForExistence(timeout: 15))
        sleep(2)
        save("1-leave-by", app)
    }

    /// Next bus + favourites over Buses near you, both medium, as the
    /// Play set's home screen has the next bus with its buttons over the board.
    /// Widgets draw their sky and "Now" from the phone's own clock, which a
    /// simulator can't move: this scene runs at the real time, with the class
    /// 34 minutes off as in the others.
    func test2Widget() {
        stubPost("/__stub/thaw")
        stubPost("/__stub/at?t=\(ISO8601DateFormatter().string(from: Date()))")
        stubPost("/__stub/class?in=34")
        let app = launch()
        sleep(3)
        // Nearby opened, as a widget's tap does, so Buses near you has its board.
        app.open(URL(string: "terminus://nearby")!)
        sleep(4)
        XCUIDevice.shared.press(.home)
        sleep(1)
        let system = SystemUITests()
        system.clearWidgets()
        // Each new widget goes in at the top.
        system.addWidget(page: 7)
        system.addWidget(page: 4)
        system.doneEditing()
        sleep(2)
        // The favourites widget back on the trip, from Nearby.
        let chip = springboard.buttons.matching(NSPredicate(format: "label == 'Show Timetable' OR label == '查看 课表'")).firstMatch
        if chip.waitForExistence(timeout: 10) { chip.tap() }
        sleep(5)
        save("2-widget", springboard)
    }

    /// The big screens' second scene in place of the home screen's widgets:
    /// Now's Nearby, the buses at the stops around you, as the widget shows.
    func test2Nearby() {
        let app = launch(sky: "day")
        let chip = app.buttons["chip.nearby"]
        XCTAssertTrue(chip.waitForExistence(timeout: 15))
        chip.tap()
        sleep(5)
        save("2-nearby", app)
    }

    func test3Map() {
        let app = launch(sky: "golden", extra: ["TERMINUS_MAP_SVC": "A1"])
        tab(app, 2).tap()
        XCTAssertTrue(app.buttons["map.pill.A1"].waitForExistence(timeout: 20))
        let downloading = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '4 MB'")).firstMatch
        for _ in 0..<30 where downloading.exists { sleep(1) }
        sleep(8)
        save("3-map", app)
    }

    func test4Buses() {
        // The Stops tab's home with two pinned stops, the first showing.
        setProfile { $0["pinnedStops"] = ["COM3", "UTOWN"] }
        defer { resetProfile() }
        let app = launch(sky: "day")
        tab(app, 1).tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.COM3.'")).firstMatch.waitForExistence(timeout: 15))
        // Two panes (capture.sh's PANES=1): COM 3 open beside the list, not an empty pane.
        if env["STORE_WIDE"] == "1" { app.buttons["nearby.COM3"].firstMatch.tap() }
        sleep(3)
        save("4-buses", app)
    }

    /// On the R2 from PGP: at the stop as the bus leaves, then along its route
    /// past Opp HSSML, so the app takes it the user is on it.
    func test5OnTheBus() {
        let token = stubSession().0
        place(1.291765, 103.780419)
        stubPost("/__stub/at?t=2026-10-09T01:42:00Z")
        let app = launch(token: token, extra: ["at": "PGP"])
        sleep(4)
        for (t, lat, lng) in [
            ("2026-10-09T01:44:00Z", 1.291765, 103.780419),
            ("2026-10-09T01:46:00Z", 1.292798, 103.774978),
            ("2026-10-09T01:47:00Z", 1.293208, 103.772618),
        ] {
            stubPost("/__stub/at?t=\(t)")
            place(lat, lng)
            app.terminate()
            app.launchEnvironment["TERMINUS_RESET"] = "0"
            app.launch()
            sleep(6)
        }
        save("5-on-the-bus", app)
    }
}
