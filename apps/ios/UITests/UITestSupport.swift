import XCTest

/// The app against the dev stub (node apps/api/scripts/dev-stub.mjs), signed
/// out and set up afresh unless a test says otherwise.
extension XCUIApplication {
    static func terminus(reset: Bool = true, lang: String = "en", extra: [String: String] = [:]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["TERMINUS_API_BASE"] = "http://localhost:8787"
        if reset { app.launchEnvironment["TERMINUS_RESET"] = "1" }
        app.launchEnvironment["TERMINUS_LANG"] = lang
        for (k, v) in extra { app.launchEnvironment[k] = v }
        return app
    }
}

extension XCTestCase {
    /// A screenshot kept with the test's results, and written to
    /// $TERMINUS_SHOTS/<name>.png when that's set, to look at.
    func shot(_ name: String, _ app: XCUIApplication) {
        let s = app.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        if let dir = ProcessInfo.processInfo.environment["TERMINUS_SHOTS"] {
            try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png"))
        }
    }
}
