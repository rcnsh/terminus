import CoreLocation
import XCTest

@MainActor
final class NearbyBoardUITests: XCTestCase {
    private let noon = "2026-11-04T03:55:30Z"

    override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
        setProfile {
            $0["pinnedStops"] = ["COM3"]
            $0["publicBuses"] = false
        }
        MainActor.assumeIsolated {
            XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 1.2955, longitude: 103.7739))
        }
    }

    override func tearDown() {
        stubPost("/__stub/reset")
        resetProfile()
    }

    private func at(_ t: String, realHours: Bool = true) {
        stubPost("/__stub/thaw")
        stubPost("/__stub/hours?real=\(realHours ? 1 : 0)")
        stubPost("/__stub/at?t=\(t)")
        stubPost("/__stub/freeze")
    }

    private func nearby(lang: String = "en", theme: String, textSize: String? = nil, waitFor row: String = "nearbyRow.COM3.D1")
        -> XCUIApplication
    {
        let app = XCUIApplication.terminus(signedIn: true, lang: lang, theme: theme, extra: ["TERMINUS_SKY": "day"])
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.resetAuthorizationStatus(for: .location)
        app.launch()
        allowLocation(app, lang: lang)
        let tab = app.tabBars.buttons[lang == "zh" ? "附近" : "Nearby"]
        XCTAssertTrue(tab.waitForExistence(timeout: 15), "no Nearby tab")
        tab.tap()
        let first = app.buttons[row]
        let came = first.waitForExistence(timeout: 15)
        if !came { shot("failed-nearby-\(name)", app) }
        XCTAssertTrue(came, "no \(row)")
        XCTAssertTrue(app.buttons["star-COM3"].waitForExistence(timeout: 10))
        sleep(1)
        return app
    }

    private func allowLocation(_ app: XCUIApplication, lang: String) {
        let ask = app.buttons[lang == "zh" ? "继续" : "Continue"]
        guard ask.waitForExistence(timeout: 10) else { return }
        ask.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["Allow While Using App", "使用 App 时允许"] {
            let b = springboard.buttons[label]
            if b.waitForExistence(timeout: 3) {
                b.tap()
                return
            }
        }
    }

    private func reveal(_ e: XCUIElement, in app: XCUIApplication, margin: CGFloat = 0) {
        XCTAssertTrue(e.waitForExistence(timeout: 15), "\(e) never came")
        let bar = app.tabBars.firstMatch.frame
        for _ in 0..<10 where !(e.isHittable && e.frame.maxY + margin < bar.minY) {
            app.swipeUp(velocity: .slow)
        }
    }

    func testMinutes() {
        at(noon)
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme)
            reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
            shot("nearby-1-minutes-\(theme)", app)
            reveal(app.buttons["nearby.CLB"], in: app, margin: 120)
            shot("nearby-8-plates-pinned-and-not-\(theme)", app)
            let foot = app.descendants(matching: .any)["nearbyFoot"]
            reveal(foot, in: app)
            XCTAssertFalse(foot.label.contains("Crossed out"), foot.label)
            XCTAssertTrue(foot.label.contains("guess"), foot.label)
            shot("nearby-7-foot-\(theme)", app)
            app.terminate()
        }
    }

    func testSmallScreen() {
        at(noon)
        let w = Int(XCUIScreen.main.screenshot().image.size.width)
        let shots: [(size: String, category: String?, themes: [String])] = [
            ("default", nil, ["light", "dark"]), ("ax1-stacked", "UICTContentSizeCategoryAccessibilityM", ["light"]),
        ]
        for (size, category, themes) in shots {
            for theme in themes {
                let app = nearby(theme: theme, textSize: category)
                reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
                shot("r8-\(w)pt-text-\(size)-\(theme)", app)
                reveal(app.buttons["nearbyRow.CLB.A1"], in: app)
                shot("r8-\(w)pt-text-\(size)-down-\(theme)", app)
                app.terminate()
            }
        }
    }

    func testPublicBus() {
        at(noon)
        setProfile { $0["publicBuses"] = true }
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme)
            reveal(app.descendants(matching: .any)["nearbyRow.CLB.151"], in: app)
            shot("nearby-5-public-bus-badges-\(theme)", app)
            app.terminate()
        }
    }

    func testDestinationsAndALastBus() {
        at("2026-11-04T14:50:00Z")
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme)
            reveal(app.buttons["nearbyRow.CLB.A1"], in: app)
            shot("nearby-6-destinations-and-dash-\(theme)", app)
            XCTAssertFalse(app.descendants(matching: .any)["nearbyFoot"].exists, "a foot with nothing guessed")
            app.terminate()
        }
    }

    func testAccessibilityOneLine() {
        at(noon)
        let app = nearby(theme: "light")
        let rows = checkAccessibility(app)
        for id in rows { XCTAssertLessThan(app.buttons[id].frame.height, 66, "\(id) is on two lines") }
        XCTAssertEqual(refreshed(app), rows, "the rows keep their identifiers across a refresh")
    }

    func testAccessibilityStacked() throws {
        try XCTSkipUnless(XCUIScreen.main.screenshot().image.size.width <= 375, "rows stack only on a small screen: run it on an SE")
        at(noon)
        let app = nearby(theme: "light", textSize: "UICTContentSizeCategoryAccessibilityM")
        let rows = checkAccessibility(app)
        for id in rows { XCTAssertGreaterThan(app.buttons[id].frame.height, 85, "\(id) isn't stacked") }
        XCTAssertEqual(refreshed(app), rows, "the rows keep their identifiers across a refresh")
    }

    @discardableResult
    private func checkAccessibility(_ app: XCUIApplication) -> [String] {
        let all = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearby'")).allElementsBoundByIndex
        let found = all.map { (id: $0.identifier, y: $0.frame.minY) }.sorted { $0.y < $1.y }
        let rows = found.filter { $0.id.hasPrefix("nearbyRow.") }
        XCTAssertGreaterThan(rows.count, 3)
        for r in rows {
            let e = app.buttons[r.id]
            XCTAssertEqual(e.descendants(matching: .any).count, 0, "\(r.id) has elements inside")
        }
        let plates = found.filter { $0.id.hasPrefix("nearby.") }.map { app.buttons[$0.id].label }
        for p in plates {
            let sign = app.otherElements.matching(NSPredicate(format: "label == %@", p)).firstMatch
            XCTAssertTrue(sign.exists, "no sign for \(p)")
            let inside = sign.descendants(matching: .any).allElementsBoundByIndex.filter {
                !$0.identifier.hasPrefix("nearby") && !$0.identifier.hasPrefix("star-")
            }
            XCTAssertEqual(inside.map(\.label), [], "elements in the \(p) sign besides its plate, star and rows")
        }
        XCTAssertEqual(found.first?.id.hasPrefix("nearby."), true, "\(found.first?.id ?? "nothing") before the first plate")
        if found.contains(where: { $0.id == "nearbyFoot" }) { XCTAssertEqual(found.last?.id, "nearbyFoot") }
        var plate: String?
        for f in found {
            if f.id.hasPrefix("nearby.") { plate = String(f.id.dropFirst("nearby.".count)) }
            if f.id.hasPrefix("nearbyRow.") {
                XCTAssertEqual(f.id.split(separator: ".")[1], plate.map { Substring($0) }, "\(f.id) isn't under its plate")
            }
        }
        let ids = found.map(\.id)
        if let foot = ids.firstIndex(of: "nearbyFoot") {
            XCTAssertGreaterThan(foot, ids.lastIndex { $0.hasPrefix("nearbyRow.") } ?? .max, "the foot isn't after the last card")
        }
        let time = #"(about )?(\d+ minutes?|under a minute)"#
        let first = "(\(time)(, (live|estimated))?|Arriving)"
        let shape = #"^(Bus|Public bus) [^,]+(, [^,]+)?(, "# + first + #")?(, then "# + time + ")*$"
        var checked = 0
        for r in rows {
            let said = app.buttons[r.id].label
            if r.id == "nearbyRow.COM3.D1" || r.id == "nearbyRow.COM3.D2" { print("\(r.id) says: \(said)") }
            for word in ["too soon", "next you can catch", "~", " AM", " PM"] { XCTAssertFalse(said.contains(word), "\(word) in: \(said)") }
            XCTAssertNil(said.range(of: #"\bmin\b"#, options: .regularExpression), "a bare min in: \(said)")
            guard !said.contains("fare applies") else { continue }
            XCTAssertNotNil(said.range(of: shape, options: .regularExpression), "not as Android reads it: \(said)")
            checked += 1
        }
        XCTAssertGreaterThan(checked, 3)
        XCTAssertTrue(app.buttons["nearbyRow.COM3.D2"].label.contains("then about"), app.buttons["nearbyRow.COM3.D2"].label)
        return rows.map(\.id)
    }

    private func refreshed(_ app: XCUIApplication) -> [String] {
        app.tabBars.buttons["Now"].tap()
        sleep(16)
        app.tabBars.buttons["Nearby"].tap()
        XCTAssertTrue(app.buttons["nearbyRow.COM3.D1"].waitForExistence(timeout: 15), "no rows after the refresh")
        sleep(1)
        return app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.'")).allElementsBoundByIndex
            .map(\.identifier)
    }
}
