import CoreLocation
import Foundation
import Security

enum TokenStore {
    nonisolated(unsafe) static var service = "sh.rcn.terminus" { didSet { keychainDone = false } }
    private static let account = "device-token"

    private enum Lookup {
        case found(String)
        case missing
        case failed
    }

    nonisolated(unsafe) static var folder: URL? { didSet { keychainDone = false } }

    nonisolated(unsafe) private static var keychainDone = false

    private static var folderName: String {
        let site = Servers.choices.filter { !Servers.isLocal($0) }
        return !site.contains(Api.base) ? "terminus-dev" : Api.isBeta ? "terminus-beta" : "terminus"
    }

    static var fileURL: URL {
        (folder
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent(
                folderName, isDirectory: true))
            .appendingPathComponent("device-token")
    }

    private static func lookup() -> Lookup {
        do {
            let t = try String(contentsOf: fileURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            return t.isEmpty ? .missing : .found(t)
        } catch  where !isMissing(error) {
            return .failed
        } catch {}
        guard folderName == "terminus", !keychainDone else { return .missing }
        let r = migrateKeychain()
        if case .failed = r {} else { keychainDone = true }
        return r
    }

    static func isMissing(_ error: Error) -> Bool {
        let e = error as NSError
        if e.domain == NSCocoaErrorDomain, e.code == NSFileReadNoSuchFileError { return true }
        if e.domain == NSPOSIXErrorDomain, e.code == Int(ENOENT) { return true }
        return (e.userInfo[NSUnderlyingErrorKey] as? NSError).map(isMissing) ?? false
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

    private static var keychainQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
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
            if writeFile(t) { deleteKeychainItem() }
            return .found(t)
        case errSecItemNotFound:
            return .missing
        default:
            return .failed
        }
    }

    private static func deleteKeychainItem() {
        SecItemDelete(keychainQuery as CFDictionary)
    }
}

func fixUncertaintyM(accuracy: Double, ageS: Double) -> Double? {
    guard accuracy >= 0 else { return nil }
    return accuracy + max(ageS, 0) * 1.3
}

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
