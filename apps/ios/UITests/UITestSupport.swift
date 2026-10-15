import XCTest

/// The dev stub the tests run against (node apps/api/scripts/dev-stub.mjs):
/// TERMINUS_STUB in the test runner's environment (TEST_RUNNER_TERMINUS_STUB
/// on xcodebuild's command line), else http://localhost:8787.
let stub = ProcessInfo.processInfo.environment["TERMINUS_STUB"] ?? "http://localhost:8787"

extension XCUIApplication {
    /// The app against the stub, starting afresh: signed out, or with
    /// `signedIn`, signed in as the stub's test account (you@u.nus.edu, with
    /// a home at PGP, three places and a class later today).
    static func terminus(signedIn: Bool = false, lang: String = "en", theme: String? = nil, extra: [String: String] = [:])
        -> XCUIApplication
    {
        let app = XCUIApplication()
        app.launchEnvironment["TERMINUS_API_BASE"] = stub
        app.launchEnvironment["TERMINUS_RESET"] = "1"
        app.launchEnvironment["TERMINUS_LANG"] = lang
        if let theme { app.launchEnvironment["TERMINUS_THEME"] = theme }
        if signedIn {
            let (token, email) = stubSession()
            app.launchEnvironment["TERMINUS_TOKEN"] = token
            app.launchEnvironment["TERMINUS_EMAIL"] = email
        }
        for (k, v) in extra { app.launchEnvironment[k] = v }
        return app
    }
}

/// A fresh device session for the stub's test account.
func stubSession() -> (String, String) {
    struct R: Decodable {
        let token: String
        let email: String
    }
    var req = URLRequest(url: URL(string: stub + "/__stub/session")!)
    req.httpMethod = "POST"
    let done = DispatchSemaphore(value: 0)
    var out: R?
    URLSession.shared.dataTask(with: req) { data, _, _ in
        out = data.flatMap { try? JSONDecoder().decode(R.self, from: $0) }
        done.signal()
    }.resume()
    done.wait()
    guard let out else { fatalError("the dev stub isn't answering at \(stub)") }
    return (out.token, out.email)
}

/// POSTs to one of the stub's own routes (/__stub/at?t=..., /__stub/freeze).
func stubPost(_ path: String) {
    var req = URLRequest(url: URL(string: stub + path)!)
    req.httpMethod = "POST"
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, _, _ in done.signal() }.resume()
    done.wait()
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
