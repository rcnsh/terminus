import Foundation

/// The app in English or Simplified Chinese, switched in Settings without a
/// restart: `L` looks each phrase up in the chosen language's table
/// (Support/zh-Hans.lproj/Localizable.strings, keyed by the English it
/// replaces). "auto" follows the phone. The widgets and the notification
/// service read the same choice from the app group. The server writes
/// answers, cards and errors in this language too ([header]).
enum Lang {
    private static let key = "lang"

    /// auto, en or zh.
    static var pref: String {
        get { Shared.defaults.string(forKey: key) ?? "auto" }
        set {
            let v = ["en", "zh"].contains(newValue) ? newValue : "auto"
            Shared.defaults.set(v, forKey: key)
            cache.withLock { $0 = nil }
        }
    }

    /// Whether the app shows Chinese: the choice, else the phone's first language.
    static var zh: Bool {
        switch pref {
        case "zh": true
        case "en": false
        default: Locale.preferredLanguages.first?.hasPrefix("zh") == true
        }
    }

    /// Accept-Language for the API.
    static var header: String { zh ? "zh-Hans" : "en" }

    /// For times and dates: Chinese in Singapore, or the phone's own.
    static var locale: Locale { zh ? Locale(identifier: "zh_Hans_SG") : .current }

    /// The Chinese table, loaded once (and again after a change of language).
    private static let cache = Mutex<[String: String]?>(nil)

    static func table() -> [String: String] {
        if let t = cache.withLock({ $0 }) { return t }
        let url = Bundle.main.url(forResource: "Localizable", withExtension: "strings", subdirectory: nil, localization: "zh-Hans")
        let t = url.flatMap { NSDictionary(contentsOf: $0) as? [String: String] } ?? [:]
        cache.withLock { $0 = t }
        return t
    }

    /// `en` in the app's language, as written: no blanks filled.
    static func word(_ en: String) -> String { zh ? (table()[en] ?? en) : en }
}

/// "Leave by %@" in the app's language, with the blanks filled. Every word the
/// app writes itself goes through here; the server's come already written.
func L(_ en: String, _ args: String...) -> String {
    let s = Lang.word(en)
    return args.isEmpty ? s : String(format: s, locale: Lang.locale, arguments: args)
}

/// `s` as VoiceOver should say it: "~09:11", a timetable guess, as "about
/// 09:11" ("约 09:11"), since the "~" alone isn't read out.
func spokenTimes(_ s: String) -> String {
    s.replacingOccurrences(of: "~", with: L("about") + " ")
}

/// A value behind a lock, for the few statics more than one thread reads.
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
