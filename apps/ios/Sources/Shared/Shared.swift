import Foundation
import Security

enum Shared {
    static let group: String = {
        let built = Bundle.main.object(forInfoDictionaryKey: "TerminusGroup") as? String ?? "group.sh.rcn.terminus"
        return chooseGroup(built: built, renamed: renamedGroups()) {
            FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: $0) != nil
        }
    }()

    static func chooseGroup(built: String, renamed: [String], opens: (String) -> Bool) -> String {
        if opens(built) { return built }
        return renamed.first { $0.hasPrefix(built + ".") && opens($0) } ?? built
    }

    private static func renamedGroups() -> [String] {
        let here = Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String] ?? []
        let app = Bundle(url: Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent())
        return here + (app?.object(forInfoDictionaryKey: "ALTAppGroups") as? [String] ?? [])
    }

    nonisolated(unsafe) static let defaults: UserDefaults = UserDefaults(suiteName: group) ?? .standard

    static var folder: URL {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    static var lastAnswer: Data? {
        get { try? Data(contentsOf: folder.appendingPathComponent("next.json")) }
        set { write(newValue, to: "next.json") }
    }

    static var lastNearby: Data? {
        get { try? Data(contentsOf: folder.appendingPathComponent("nearby.json")) }
        set { write(newValue, to: "nearby.json") }
    }

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

enum TokenStore {
    private static var account: String { account(for: Api.base) }
    private static let service = "sh.rcn.terminus.token"

    static func account(for base: String) -> String { Servers.isLocal(base) ? base : "site" }

    private static func query(_ extra: [CFString: Any] = [:], account: String = Self.account) -> [CFString: Any] {
        var q: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        if accessGroupWorks { q[kSecAttrAccessGroup] = Shared.group }
        return q.merging(extra) { _, b in b }
    }

    private static var accessGroupWorks: Bool {
        if let known = probed.withLock({ $0 }) { return known }
        let probe: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: service + ".probe", kSecAttrAccount: "probe",
            kSecAttrAccessGroup: Shared.group, kSecValueData: Data("1".utf8),
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemAdd(probe as CFDictionary, nil)
        SecItemDelete(
            [kSecClass: kSecClassGenericPassword, kSecAttrService: service + ".probe", kSecAttrAccessGroup: Shared.group] as CFDictionary)
        guard let works = probeAnswer(status) else { return true }
        probed.withLock { $0 = works }
        return works
    }
    private static let probed = Mutex<Bool?>(nil)

    static func probeAnswer(_ status: OSStatus) -> Bool? {
        if status == errSecInteractionNotAllowed { return nil }
        return status == errSecSuccess || status == errSecDuplicateItem
    }

    static func read() -> String? {
        if case .found(let token) = lookup() { return token }
        return nil
    }

    enum Lookup: Equatable {
        case found(String)
        case none
        case locked
    }

    static func lookup() -> Lookup {
        let mine = lookup(account: account)
        if mine != .none { return mine }
        guard account == "site" else { return .none }
        for old in legacy {
            guard case .found(let token) = lookup(account: old) else { continue }
            save(token)
            SecItemDelete(query(account: old) as CFDictionary)
            return .found(token)
        }
        return .none
    }

    private static var legacy: [String] { [Servers.backupBase, Servers.defaultBase].compactMap { $0 } }

    private static func lookup(account: String) -> Lookup {
        var out: CFTypeRef?
        let status = SecItemCopyMatching(
            query([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne], account: account) as CFDictionary, &out)
        return lookupAnswer(status, data: out as? Data)
    }

    static func lookupAnswer(_ status: OSStatus, data: Data?) -> Lookup {
        if status == errSecInteractionNotAllowed { return .locked }
        guard status == errSecSuccess, let token = data.flatMap({ String(data: $0, encoding: .utf8) }) else { return .none }
        return .found(token)
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
        if account == "site" { for old in legacy { SecItemDelete(query(account: old) as CFDictionary) } }
    }
}
