import CoreLocation
import Foundation

/// The device token, in a file only this user can read.
///
/// Not the Keychain: this app is ad-hoc signed, so each rebuild has a new
/// code identity and the Keychain would block on an access prompt after every
/// update. With a signing certificate, move this back to the Keychain.
enum TokenStore {
    private static var support: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    private static var url: URL {
        support.appendingPathComponent("terminus", isDirectory: true).appendingPathComponent("device-token")
    }

    /// Before the rename the token lived under "nusbus". Move it once, so an
    /// update doesn't sign the Mac out.
    static func migrate() {
        let old = support.appendingPathComponent("nusbus/device-token")
        let fm = FileManager.default
        guard !fm.fileExists(atPath: url.path), let token = try? String(contentsOf: old, encoding: .utf8) else { return }
        write(token.trimmingCharacters(in: .whitespacesAndNewlines))
        try? fm.removeItem(at: old.deletingLastPathComponent())
    }

    static func read() -> String? {
        guard let s = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }

    static func write(_ token: String?) {
        let fm = FileManager.default
        guard let token else {
            try? fm.removeItem(at: url)
            return
        }
        let dir = url.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // Create with 0600 before writing, so the token is never world-readable.
        fm.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        try? Data(token.utf8).write(to: url)
    }
}

/// One-shot location fixes. Every failure is nil: without a location the API
/// follows the timetable, which is a fine answer.
@MainActor
final class Locator: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLLocation?, Never>] = []
    private var last: CLLocation?
    private var generation = 0

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    var authorized: Bool {
        let s = manager.authorizationStatus
        return s == .authorizedAlways || s == .authorized
    }

    var undecided: Bool { manager.authorizationStatus == .notDetermined }

    func ask() { manager.requestWhenInUseAuthorization() }

    /// A fix no older than two minutes, or a fresh one (up to ~5 s).
    func current() async -> CLLocation? {
        guard authorized else { return nil }
        if let last, -last.timestamp.timeIntervalSinceNow < 120 { return last }
        let fix = await withCheckedContinuation { cont in
            waiting.append(cont)
            guard waiting.count == 1 else { return }
            generation += 1
            let gen = generation
            manager.requestLocation()
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(5))
                // Only time out the request this timer was started for.
                if self.generation == gen { self.finish(nil) }
            }
        }
        return fix ?? last
    }

    private func finish(_ loc: CLLocation?) {
        if let loc { last = loc }
        generation += 1
        let conts = waiting
        waiting = []
        conts.forEach { $0.resume(returning: loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let loc = locations.last
        Task { @MainActor in self.finish(loc) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}
