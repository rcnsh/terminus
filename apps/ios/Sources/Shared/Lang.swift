import Foundation

enum Lang {
    private static let key = "lang"

    static var pref: String {
        get { Shared.defaults.string(forKey: key) ?? "auto" }
        set {
            let v = ["en", "zh"].contains(newValue) ? newValue : "auto"
            Shared.defaults.set(v, forKey: key)
            cache.withLock { $0 = nil }
        }
    }

    static var zh: Bool {
        switch pref {
        case "zh": true
        case "en": false
        default: Locale.preferredLanguages.first?.hasPrefix("zh") == true
        }
    }

    static var header: String { zh ? "zh-Hans" : "en" }

    static var locale: Locale { zh ? Locale(identifier: "zh_Hans_SG") : .current }

    private static let cache = Mutex<[String: String]?>(nil)

    static func table() -> [String: String] {
        if let t = cache.withLock({ $0 }) { return t }
        var t: [String: String] = [:]
        for url in Bundle.main.urls(forResourcesWithExtension: "strings", subdirectory: nil, localization: "zh-Hans") ?? []
        where url.lastPathComponent != "InfoPlist.strings" {
            t.merge((NSDictionary(contentsOf: url) as? [String: String]) ?? [:]) { a, _ in a }
        }
        cache.withLock { $0 = t }
        return t
    }

    static func word(_ en: String) -> String { zh ? (table()[en] ?? en) : en }
}

func L(_ en: String, _ args: String...) -> String {
    let s = Lang.word(en)
    return args.isEmpty ? s : String(format: s, locale: Lang.locale, arguments: args)
}

let onIPad: Bool = {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim.hasPrefix("iPad") }
    var u = utsname()
    uname(&u)
    let machine = withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    return machine.hasPrefix("iPad")
}()

var signedOutHere: String {
    #if os(watchOS)
        return L("This watch was signed out of your account.")
    #else
        return signedOutPhone
    #endif
}

private var signedOutPhone: String {
    onIPad
        ? L("This iPad was signed out of your account. Sign in again with your email.")
        : L("This phone was signed out of your account. Sign in again with your email.")
}

func spokenTimes(_ s: String) -> String {
    s.replacingOccurrences(of: "~", with: L("about") + " ")
}

final class Mutex<Value>: @unchecked Sendable {
    private var value: Value
    private let lock = NSLock()
    init(_ value: Value) { self.value = value }
    func withLock<R>(_ body: (inout Value) throws -> R) rethrows -> R {
        lock.lock()
        defer { lock.unlock() }
        return try body(&value)
    }
}
