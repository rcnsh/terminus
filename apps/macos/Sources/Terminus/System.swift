import CoreLocation
import Foundation
import Security

/// The device token, in the login keychain.
///
/// Releases are signed with the terminus certificate, so every version has the
/// same code identity and keeps access to the item without asking. Ad-hoc
/// builds (swift run, ./build.sh without the certificate) get a new identity
/// each time, and macOS asks once per build before handing the token over.
enum TokenStore {
    private static let service = "sh.rcn.terminus"
    private static let account = "device-token"

    private enum Lookup {
        case found(String)
        case missing
        /// Locked keychain, access refused: the token may well be there.
        case failed(OSStatus)
    }

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func lookup() -> Lookup {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return .missing }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .missing : .found(t)
        case errSecItemNotFound:
            return migrateFile()
        default:
            return .failed(status)
        }
    }

    static var exists: Bool {
        if case .missing = lookup() { return false }
        return true
    }

    static func read() -> String? {
        if case .found(let t) = lookup() { return t }
        return nil
    }

    @discardableResult
    static func write(_ token: String?) -> Bool {
        guard let token else {
            let status = SecItemDelete(base as CFDictionary)
            try? FileManager.default.removeItem(at: legacyURL)
            return status == errSecSuccess || status == errSecItemNotFound
        }
        let data = Data(token.utf8)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard status == errSecItemNotFound else { return status == errSecSuccess }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "terminus device token"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    /// Versions up to 1.3.7 kept the token in Application Support, because
    /// ad-hoc builds couldn't keep Keychain access. Move it over once.
    private static var legacyURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("terminus", isDirectory: true).appendingPathComponent("device-token")
    }

    private static func migrateFile() -> Lookup {
        guard let s = try? String(contentsOf: legacyURL, encoding: .utf8) else { return .missing }
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return .missing }
        // The file goes only once the Keychain has the token.
        if write(t) { try? FileManager.default.removeItem(at: legacyURL) }
        return .found(t)
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
    var denied: Bool { [.denied, .restricted].contains(manager.authorizationStatus) }

    func ask() { manager.requestWhenInUseAuthorization() }

    /// A fix no older than `maxAge`, or a fresh one (up to ~5 s). With the
    /// popover closed a ten-minute-old fix is fine: asking CoreLocation every
    /// two minutes all day costs battery and blinks the location arrow.
    func current(maxAge: TimeInterval = 120) async -> CLLocation? {
        guard authorized else { return nil }
        if let last, -last.timestamp.timeIntervalSinceNow < maxAge { return last }
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
