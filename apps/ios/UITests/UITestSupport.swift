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
            // The class 50 minutes off, however long the run has gone on.
            stubPost("/__stub/class?in=50")
            let (token, email) = stubSession()
            app.launchEnvironment["TERMINUS_TOKEN"] = token
            app.launchEnvironment["TERMINUS_EMAIL"] = email
        }
        for (k, v) in extra { app.launchEnvironment[k] = v }
        return app
    }
}

/// The stub's answer to `req`, waited for (empty if it didn't answer).
func stubFetch(_ req: URLRequest) -> Data {
    final class Box: @unchecked Sendable { var data = Data() }
    let box = Box()
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { d, _, _ in
        box.data = d ?? Data()
        done.signal()
    }.resume()
    done.wait()
    return box.data
}

/// A fresh device session for the stub's test account.
func stubSession() -> (String, String) {
    struct R: Decodable {
        let token: String
        let email: String
    }
    var req = URLRequest(url: URL(string: stub + "/__stub/session")!)
    req.httpMethod = "POST"
    guard let out = try? JSONDecoder().decode(R.self, from: stubFetch(req)) else { fatalError("the dev stub isn't answering at \(stub)") }
    return (out.token, out.email)
}

/// A new account without an email, set up already (a home at PGP), so the
/// tabs show rather than the onboarding: its token.
func stubAnonToken() -> String {
    var req = URLRequest(url: URL(string: stub + "/api/auth/anon")!)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.httpBody = Data(#"{"name":"iPhone","platform":"ios"}"#.utf8)
    let t = ((try? JSONSerialization.jsonObject(with: stubFetch(req))) as? [String: Any])?["token"] as? String ?? ""
    var put = URLRequest(url: URL(string: stub + "/api/me/profile")!)
    put.httpMethod = "PUT"
    put.setValue("Bearer \(t)", forHTTPHeaderField: "authorization")
    put.setValue("application/json", forHTTPHeaderField: "content-type")
    put.httpBody = Data(#"{"home":{"stops":["PGP"]},"seen":["onboarding"]}"#.utf8)
    _ = stubFetch(put)
    return t
}

/// POSTs to one of the stub's own routes (/__stub/at?t=..., /__stub/freeze, /__stub/class?in=N).
func stubPost(_ path: String) {
    var req = URLRequest(url: URL(string: stub + path)!)
    req.httpMethod = "POST"
    _ = stubFetch(req)
}

extension XCTestCase {
    /// A screenshot kept with the test's results, and written to
    /// $TERMINUS_SHOTS/<name>.png when that's set, to look at.
    @MainActor func shot(_ name: String, _ app: XCUIApplication) {
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
