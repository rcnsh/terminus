import Foundation
import Security

/// What the app, its widgets and the notification service share, in the app
/// group: the settings they all read and the latest answer, so a widget
/// shows what the app last saw without asking again. The token is in the
/// keychain, shared through the same group.
enum Shared {
    /// The app group, from the build's Info.plist (TerminusGroup): the beta has its own.
    static let group = Bundle.main.object(forInfoDictionaryKey: "TerminusGroup") as? String ?? "group.sh.rcn.terminus"

    /// The group's defaults, or this process's own where the group isn't
    /// available (a build without the entitlement, the unit tests).
    nonisolated(unsafe) static let defaults: UserDefaults = UserDefaults(suiteName: group) ?? .standard

    /// The group's folder, for files the widgets read (the latest answer, the day).
    static var folder: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    /// The answer the app last fetched for Next, as it came, for the widgets
    /// and the notification service: read with [NextAnswer.decode].
    static var lastAnswer: Data? {
        get { try? Data(contentsOf: folder.appendingPathComponent("next.json")) }
        set { write(newValue, to: "next.json") }
    }

    /// Nearby's stops as they came, for the widget's Nearby mode.
    static var lastNearby: Data? {
        get { try? Data(contentsOf: folder.appendingPathComponent("nearby.json")) }
        set { write(newValue, to: "nearby.json") }
    }

    /// Today's plan as it came, kept for when the phone is offline (OfflineDay).
    static var lastDay: Data? {
        get { try? Data(contentsOf: folder.appendingPathComponent("day.json")) }
        set { write(newValue, to: "day.json") }
    }

    private static func write(_ data: Data?, to name: String) {
        let url = folder.appendingPathComponent(name)
        if let data {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }
}

/// This phone's sign-in, in the keychain: readable after the first unlock,
/// so the widgets and a push in the night can use it, and never backed up
/// to another phone. Each server keeps its own, so the real account's token
/// never goes to the dev stub.
enum TokenStore {
    private static var account: String { Api.base }
    private static let service = "sh.rcn.terminus.token"

    private static func query(_ extra: [CFString: Any] = [:]) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        if accessGroupWorks { q[kSecAttrAccessGroup] = Shared.group }
        return q.merging(extra) { _, b in b }
    }

    /// Whether the keychain takes the app group as an access group (it does
    /// once the app is signed with the group); a build without it keeps the
    /// token in this app's own keychain, which the extensions can't read.
    private static let accessGroupWorks: Bool = {
        let probe: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service + ".probe", kSecAttrAccount: "probe",
            kSecAttrAccessGroup: Shared.group, kSecValueData: Data("1".utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(
            [kSecClass: kSecClassGenericPassword, kSecAttrService: service + ".probe", kSecAttrAccessGroup: Shared.group] as CFDictionary)
        return status == errSecSuccess || status == errSecDuplicateItem
    }()

    static func read() -> String? {
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ token: String) {
        let data = Data(token.utf8)
        let found = SecItemUpdate(query() as CFDictionary, [kSecValueData: data] as CFDictionary)
        if found == errSecItemNotFound {
            SecItemAdd(
                query([kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]) as CFDictionary, nil)
        }
    }

    static func clear() {
        SecItemDelete(query() as CFDictionary)
    }
}
