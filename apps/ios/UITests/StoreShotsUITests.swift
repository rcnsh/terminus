import CoreLocation
import XCTest

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
        XCUIDevice.shared.orientation = env["STORE_TURN"] == "1" ? .landscapeLeft : .portrait
    }

    func place(_ lat: Double, _ lng: Double) {
        XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: lat, longitude: lng))
    }

    func launch(sky: String = "dawn", token: String? = nil, extra: [String: String] = [:]) -> XCUIApplication {
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

    func tab(_ app: XCUIApplication, _ i: Int) -> XCUIElement {
        if app.tabBars.buttons.count > i { return app.tabBars.buttons.element(boundBy: i) }
        let names = lang == "zh" ? ["现在", "附近", "车站", "地图", "设置"] : ["Now", "Nearby", "Stops", "Map", "Settings"]
        return app.buttons[names[i]].firstMatch
    }

    func save(_ file: String, _ target: XCUIApplication) {
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

    func test2Widget() {
        stubPost("/__stub/thaw")
        stubPost("/__stub/at?t=\(ISO8601DateFormatter().string(from: Date()))")
        stubPost("/__stub/class?in=34")
        let app = launch()
        sleep(3)
        app.open(URL(string: "terminus://nearby")!)
        allowLocationIfAsked()
        sleep(4)
        XCUIDevice.shared.press(.home)
        sleep(1)
        let system = SystemUITests()
        system.clearWidgets()
        system.addWidget(page: 7)
        system.addWidget(page: 4)
        system.doneEditing()
        sleep(2)
        let chip = springboard.buttons.matching(NSPredicate(format: "label == 'Show Timetable' OR label == '查看 课表'")).firstMatch
        if chip.waitForExistence(timeout: 10) { chip.tap() }
        sleep(5)
        save("2-widget", springboard)
    }

    func test2Nearby() {
        let app = launch(sky: "day")
        tab(app, 1).tap()
        allowLocationIfAsked()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.'")).firstMatch.waitForExistence(timeout: 15))
        sleep(5)
        save("2-nearby", app)
    }

    func test3Map() {
        let app = launch(sky: "golden", extra: ["TERMINUS_MAP_SVC": "A1"])
        tab(app, 3).tap()
        XCTAssertTrue(app.buttons["map.pill.A1"].waitForExistence(timeout: 20))
        let downloading = app.staticTexts.containing(NSPredicate(format: "label CONTAINS '4 MB'")).firstMatch
        for _ in 0..<30 where downloading.exists { sleep(1) }
        sleep(8)
        save("3-map", app)
    }

    func test4Buses() {
        setProfile { $0["pinnedStops"] = ["COM3", "UTOWN"] }
        defer { resetProfile() }
        let app = launch(sky: "day")
        tab(app, 2).tap()
        XCTAssertTrue(
            app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.COM3.'")).firstMatch.waitForExistence(timeout: 15))
        if env["STORE_WIDE"] == "1" { app.buttons["nearby.COM3"].firstMatch.tap() }
        sleep(3)
        save("4-buses", app)
    }

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
