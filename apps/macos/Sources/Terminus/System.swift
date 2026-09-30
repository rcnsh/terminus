import CoreLocation
import Foundation
import Security

/// The device token, in a file only this user can read:
/// ~/Library/Application Support/terminus/device-token (0600, folder 0700).
///
/// Not the keychain: terminus is signed with a self-signed certificate, with
/// no Apple Team ID, so macOS knows each version only by its code hash and
/// asked for the keychain password after every update. A file has the same
/// protection as an SSH key. The token only reads your bus answers, and
/// Settings on the web can revoke it.
///
/// Versions 1.3.8 to 2.0.0-beta.4 kept it in the keychain. It's moved to the
/// file once, the first time the file isn't there (that read may be the last
/// keychain prompt), and the keychain item is then deleted.
enum TokenStore {
    /// Tests use their own keychain name; the app never changes it.
    nonisolated(unsafe) static var service = "sh.rcn.terminus"
    private static let account = "device-token"

    private enum Lookup {
        case found(String)
        case missing
        /// The keychain refused (locked, or the prompt was denied): the token
        /// may well be there, so this is not "signed out".
        case failed(OSStatus)
    }

    /// Tests point this at a temporary folder; the app never sets it.
    nonisolated(unsafe) static var folder: URL?

    /// A build pointed at a local API (TERMINUS_API_BASE) keeps its own
    /// token, so pairing it to the dev stub never signs this Mac out of the real one.
    private static var folderName: String { Api.base == "https://terminus.rcn.sh" ? "terminus" : "terminus-dev" }

    static var fileURL: URL {
        (folder ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(folderName, isDirectory: true))
            .appendingPathComponent("device-token")
    }

    private static func lookup() -> Lookup {
        if let s = try? String(contentsOf: fileURL, encoding: .utf8) {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .missing : .found(t)
        }
        // The keychain item belongs to the real API's sign-in: a dev build leaves it alone.
        return folderName == "terminus" ? migrateKeychain() : .missing
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
            try? FileManager.default.removeItem(at: fileURL)
            deleteKeychainItem()
            return !FileManager.default.fileExists(atPath: fileURL.path)
        }
        return writeFile(token)
    }

    /// Written to a private temporary file, then moved over the old one, so
    /// the token is never readable by others and never half-written.
    private static func writeFile(_ token: String) -> Bool {
        let fm = FileManager.default
        let dir = fileURL.deletingLastPathComponent()
        do {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
            let tmp = dir.appendingPathComponent(".device-token-\(UUID().uuidString)")
            guard fm.createFile(atPath: tmp.path, contents: Data(token.utf8), attributes: [.posixPermissions: 0o600]) else { return false }
            if fm.fileExists(atPath: fileURL.path) {
                _ = try fm.replaceItemAt(fileURL, withItemAt: tmp)
            } else {
                try fm.moveItem(at: tmp, to: fileURL)
            }
            return true
        } catch {
            return false
        }
    }

    /* ---------- moving out of the keychain, once ---------- */

    private static var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func migrateKeychain() -> Lookup {
        var query = keychainQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data, let s = String(data: data, encoding: .utf8) else { return .missing }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return .missing }
            // The keychain item goes only once the file has the token.
            if writeFile(t) { deleteKeychainItem() }
            return .found(t)
        case errSecItemNotFound:
            return .missing
        default:
            return .failed(status)
        }
    }

    private static func deleteKeychainItem() {
        SecItemDelete(keychainQuery as CFDictionary)
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
