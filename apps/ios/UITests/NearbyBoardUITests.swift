import CoreLocation
import XCTest

/// Nearby as a departure board, against the dev stub, for the design
/// review's checklist: each state in light and dark, its screenshots named
/// by the item ("nearby-1-minutes-light"). Between COM 3 and CLB, with COM 3
/// pinned and CLB not, 12-hour times unless a test says otherwise, the
/// clock held still so both themes show one moment.
@MainActor
final class NearbyBoardUITests: XCTestCase {
    /// 11:55:30 AM on campus: COM 3's D1 struck at "1 min" (11:57 AM), then 12:09 PM.
    private let noon = "2026-11-04T03:55:30Z"

    override func setUp() {
        continueAfterFailure = false
        stubPost("/__stub/reset")
        setProfile {
            $0["pinnedStops"] = ["COM3"]
            $0["publicBuses"] = false
            // The account's clock: the app follows it once the profile comes.
            $0["clock"] = "12"
        }
        MainActor.assumeIsolated {
            XCUIDevice.shared.location = XCUILocation(location: CLLocation(latitude: 1.2955, longitude: 103.7739))
        }
    }

    override func tearDown() {
        stubPost("/__stub/reset")
        resetProfile()
        setProfile { $0["clock"] = "auto" }
    }

    /// The stub's clock at `t`, held there.
    private func at(_ t: String, realHours: Bool = false) {
        // Running again first: /__stub/at counts from where a held clock was held.
        stubPost("/__stub/thaw")
        stubPost("/__stub/hours?real=\(realHours ? 1 : 0)")
        stubPost("/__stub/at?t=\(t)")
        stubPost("/__stub/freeze")
    }

    /// The app on Nearby, its times in minutes or as clock times.
    private func nearby(
        lang: String = "en", theme: String, clock: Bool, hours: String = "12", textSize: String? = nil,
        waitFor row: String = "nearbyRow.COM3.D1"
    ) -> XCUIApplication {
        let app = XCUIApplication.terminus(
            signedIn: true, lang: lang, theme: theme, extra: ["TERMINUS_SKY": "day", "TERMINUS_CLOCK": hours])
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        // Asked afresh, so Nearby is where the simulator is rather than at home.
        app.resetAuthorizationStatus(for: .location)
        app.launch()
        allowLocation(app, lang: lang)
        let chip = app.buttons["chip.nearby"]
        XCTAssertTrue(chip.waitForExistence(timeout: 15), "no Nearby chip")
        chip.tap()
        let first = app.buttons[row]
        let came = first.waitForExistence(timeout: 15)
        if !came { shot("failed-nearby-\(name)", app) }
        XCTAssertTrue(came, "no \(row)")
        let times = app.segmentedControls["nearbyTimes"].buttons.element(boundBy: clock ? 1 : 0)
        if !times.isSelected { times.tap() }
        // The star comes with the pins, and the columns settle once measured.
        XCTAssertTrue(app.buttons["star-COM3"].waitForExistence(timeout: 10))
        sleep(1)
        return app
    }

    /// Says yes to the location question: the notice over Now asks it.
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

    /// Scrolls until `e` is on screen, clear of the tab bar, `margin` above it.
    private func reveal(_ e: XCUIElement, in app: XCUIApplication, margin: CGFloat = 0) {
        XCTAssertTrue(e.waitForExistence(timeout: 15), "\(e) never came")
        let bar = app.tabBars.firstMatch.frame
        for _ in 0..<10 where !(e.isHittable && e.frame.maxY + margin < bar.minY) {
            app.swipeUp(velocity: .slow)
        }
    }

    /// Item 1, a struck "1 min" Next and the large time in Then; item 8, the
    /// plates with the chevron, the star pinned (COM 3) and not (CLB); item 7,
    /// the foot with all three lines.
    func testMinutes() {
        at(noon)
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme, clock: false)
            reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
            shot("nearby-1-minutes-struck-\(theme)", app)
            reveal(app.buttons["nearby.CLB"], in: app, margin: 120)
            shot("nearby-8-plates-pinned-and-not-\(theme)", app)
            reveal(app.descendants(matching: .any)["nearbyFoot"], in: app)
            XCTAssertTrue(app.descendants(matching: .any)["nearbyFoot"].label.contains("Crossed out"))
            shot("nearby-7-foot-all-three-\(theme)", app)
            app.terminate()
        }
    }

    /// Item 2: 12-hour clock times, AM/PM on Next and where the half changes (11:57 AM, 12:09 PM, ~12:21).
    func testClock12() {
        at(noon)
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme, clock: true)
            reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
            print("COM3 D1 reads: \(app.buttons["nearbyRow.COM3.D1"].label)")
            shot("nearby-2-clock-12h-half-changes-\(theme)", app)
            app.terminate()
        }
    }

    /// Item 3: Chinese, 上午/下午 before the time; then 24-hour with a struck 18:0x.
    func testClockChinese() {
        at(noon)
        for theme in ["light", "dark"] {
            let app = nearby(lang: "zh", theme: theme, clock: true)
            reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
            shot("nearby-3-clock-zh-12h-\(theme)", app)
            app.terminate()
        }
        // 5:59:30 PM: COM 3's D2 struck at 18:01.
        at("2026-11-04T09:59:30Z")
        setProfile { $0["clock"] = "24" }
        for theme in ["light", "dark"] {
            let app = nearby(lang: "zh", theme: theme, clock: true, hours: "24", waitFor: "nearbyRow.COM3.D2")
            reveal(app.buttons["nearbyRow.COM3.D2"], in: app)
            shot("nearby-3-clock-zh-24h-struck-\(theme)", app)
            app.terminate()
        }
    }

    /// Item 4, on the smallest screen (an iPhone SE): clock times at the
    /// usual text size and one step up; the places wrap, no time spills over,
    /// and when a row can't fit at 0.85 every row's times go under it at full size.
    func testSmallScreen() {
        at(noon)
        let w = Int(XCUIScreen.main.screenshot().image.size.width)
        for (size, cat) in [("default", nil), ("xl", "UICTContentSizeCategoryXL"), ("xxl", "UICTContentSizeCategoryXXL")] {
            for theme in ["light", "dark"] {
                let app = nearby(theme: theme, clock: true, textSize: cat)
                reveal(app.buttons["nearbyRow.COM3.D1"], in: app)
                shot("r5-clock-\(w)pt-text-\(size)-\(theme)", app)
                reveal(app.buttons["nearbyRow.CLB.A1"], in: app)
                shot("r5-clock-\(w)pt-text-\(size)-down-\(theme)", app)
                app.terminate()
            }
        }
    }

    /// Item 5: a public bus ("151 $") widens every badge on the screen alike.
    func testPublicBus() {
        at(noon)
        setProfile { $0["publicBuses"] = true }
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme, clock: false)
            reveal(app.descendants(matching: .any)["nearbyRow.CLB.151"], in: app)
            shot("nearby-5-public-bus-badges-\(theme)", app)
            app.terminate()
        }
    }

    /// Item 6, the destinations: a loop at its first stop ("via UTown", D1 at
    /// COM 3), one with no landmark ahead ("to KR Bus Ter", A1 at CLB) and a
    /// "–" (the last buses of the night, real hours); item 7, the foot with
    /// nothing struck or guessed: only "Tap a service…".
    func testDestinationsAndALastBus() {
        // 10:50 PM: every bus live, none too soon, the last of each with no bus after it.
        at("2026-11-04T14:50:00Z", realHours: true)
        for theme in ["light", "dark"] {
            let app = nearby(theme: theme, clock: false)
            reveal(app.buttons["nearbyRow.CLB.A1"], in: app)
            shot("nearby-6-destinations-and-dash-\(theme)", app)
            let foot = app.descendants(matching: .any)["nearbyFoot"]
            reveal(foot, in: app)
            XCTAssertFalse(foot.label.contains("Crossed out"), foot.label)
            XCTAssertFalse(foot.label.contains("guess"), foot.label)
            shot("nearby-7-foot-tap-only-\(theme)", app)
            app.terminate()
        }
    }

    // MARK: what VoiceOver finds

    /// Round 4, item 6, on one-line rows: minutes, the usual text size.
    func testAccessibilityOneLine() {
        at(noon)
        let app = nearby(theme: "light", clock: false)
        let rows = checkAccessibility(app, struck: "nearbyRow.COM3.D1", estimate: "nearbyRow.COM3.D2")
        // None stacked.
        for id in rows { XCTAssertLessThan(app.buttons[id].frame.height, 66, "\(id) is on two lines") }
        XCTAssertEqual(refreshed(app), rows, "the rows keep their identifiers across a refresh")
    }

    /// Round 4, item 6, on stacked rows: an iPhone SE, clock times, two text
    /// sizes up (one up, every row still fits beside its times at 0.85 or more).
    func testAccessibilityStacked() throws {
        try XCTSkipUnless(XCUIScreen.main.screenshot().image.size.width <= 375, "rows stack only on a small screen: run it on an SE")
        at(noon)
        let app = nearby(theme: "light", clock: true, textSize: "UICTContentSizeCategoryXXL")
        let rows = checkAccessibility(app, struck: "nearbyRow.COM3.D1", estimate: "nearbyRow.COM3.D2")
        // Every row stacked, or none: here, every one.
        for id in rows { XCTAssertGreaterThan(app.buttons[id].frame.height, 66, "\(id) isn't stacked") }
        XCTAssertEqual(refreshed(app), rows, "the rows keep their identifiers across a refresh")
    }

    /// The checks both layouts share; the rows' identifiers, in order.
    @discardableResult
    private func checkAccessibility(_ app: XCUIApplication, struck: String, estimate: String) -> [String] {
        let all = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearby'")).allElementsBoundByIndex
        // As VoiceOver goes through them: top to bottom. (XCUITest lists a container's
        // own elements first, so its order isn't the reading order.)
        let found = all.map { (id: $0.identifier, y: $0.frame.minY) }.sorted { $0.y < $1.y }
        let rows = found.filter { $0.id.hasPrefix("nearbyRow.") }
        XCTAssertGreaterThan(rows.count, 3)
        // Each row is one element: its times, its second line too, aren't elements of their own.
        for r in rows {
            let e = app.buttons[r.id]
            XCTAssertEqual(e.descendants(matching: .any).count, 0, "\(r.id) has elements inside")
        }
        // Inside the signs, nothing but their plates and rows: no heading, no time on its own.
        let plates = found.filter { $0.id.hasPrefix("nearby.") }.map { app.buttons[$0.id].label }
        for p in plates {
            let sign = app.otherElements.matching(NSPredicate(format: "label == %@", p)).firstMatch
            XCTAssertTrue(sign.exists, "no sign for \(p)")
            let inside = sign.descendants(matching: .any).allElementsBoundByIndex.filter {
                !$0.identifier.hasPrefix("nearby") && !$0.identifier.hasPrefix("star-")
            }
            XCTAssertEqual(inside.map(\.label), [], "elements in the \(p) sign besides its plate, star and rows")
        }
        // Each plate before its own rows, the foot after the last card, the Stops row after it.
        XCTAssertEqual(found.first?.id, "nearbyTimes")
        XCTAssertEqual(found.last?.id, "nearbyStops")
        var plate: String?
        for f in found {
            if f.id.hasPrefix("nearby.") { plate = String(f.id.dropFirst("nearby.".count)) }
            if f.id.hasPrefix("nearbyRow.") {
                XCTAssertEqual(f.id.split(separator: ".")[1], plate.map { Substring($0) }, "\(f.id) isn't under its plate")
            }
        }
        let ids = found.map(\.id)
        let foot = ids.firstIndex(of: "nearbyFoot")
        XCTAssertNotNil(foot)
        XCTAssertGreaterThan(foot ?? -1, ids.lastIndex { $0.hasPrefix("nearbyRow.") } ?? .max, "the foot isn't after the last card")
        // A struck row and an estimate's, as said.
        for (id, struck) in [(struck, true), (estimate, false)] {
            let said = app.buttons[id].label
            print("\(id) says: \(said)")
            if struck { XCTAssertTrue(said.contains("too soon to catch"), said) }
            for word in ["next you can catch", "about", "minutes"] { XCTAssertTrue(said.contains(word), "\(word) not in: \(said)") }
            XCTAssertFalse(said.contains("~"), said)
            // Live or estimated for the first bus only, as Android reads it.
            let tags = said.ranges(of: /\b(live|estimated)\b/)
            XCTAssertLessThanOrEqual(tags.count, 1, said)
            if let tag = tags.first, let then = said.range(of: "then ") {
                XCTAssertLessThan(tag.lowerBound, then.lowerBound, said)
            }
            XCTAssertNil(said.range(of: #"\bmin\b"#, options: .regularExpression), "a bare min in: \(said)")
        }
        return rows.map(\.id)
    }

    /// Asks for Nearby again (its chip, tapped again, fetches afresh) and waits
    /// for the answer: the rows' identifiers after it.
    private func refreshed(_ app: XCUIApplication) -> [String] {
        let chip = app.buttons["chip.nearby"]
        for _ in 0..<6 where !chip.isHittable { app.swipeDown() }
        chip.tap()
        XCTAssertTrue(app.buttons["nearbyRow.COM3.D1"].waitForExistence(timeout: 15), "no rows after the refresh")
        sleep(1)
        return app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'nearbyRow.'")).allElementsBoundByIndex
            .map(\.identifier)
    }
}
