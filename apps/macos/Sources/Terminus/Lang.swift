import AppKit
import Foundation

/// The Mac app in English or Simplified Chinese (phase 10).
///
/// macOS picks the app's language when it starts: the app's own choice
/// (`AppleLanguages` in its defaults, which Settings → Language sets, as does
/// System Settings → General → Language & Region → Applications), else the
/// Mac's. The translations are Support/zh-Hans.lproj/Localizable.strings,
/// keyed by the English they replace; `L` looks them up. The server writes
/// answers and cards in the account's language, or this one ([header]).
enum Lang {
    private static let key = "AppleLanguages"

    /// auto, en or zh: what this app was set to (auto follows the Mac).
    static var pref: String {
        let mine = UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "")?[key] as? [String]
        guard let first = mine?.first else { return "auto" }
        return first.hasPrefix("zh") ? "zh" : "en"
    }

    /// Sets the app's language; it shows from the next launch ([relaunch]).
    static func set(_ pref: String) {
        if pref == "auto" { UserDefaults.standard.removeObject(forKey: key) } else { UserDefaults.standard.set([pref == "zh" ? "zh-Hans" : "en"], forKey: key) }
    }

    /// Whether the app is showing Chinese.
    static var zh: Bool { Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true }

    /// Accept-Language for the API.
    static var header: String { zh ? "zh-Hans" : "en" }

    /// For times and dates: Chinese in Singapore, or the Mac's own.
    static var locale: Locale { zh ? Locale(identifier: "zh_Hans_SG") : .current }

    private static let appliedKey = "langApplied"

    /// The account's language (its profile's lang), when it changed since last
    /// time: set here for the next launch. A choice made here before the
    /// account had one is returned, to save to the account.
    static func followAccount(_ accountLang: String?) -> String? {
        let applied = UserDefaults.standard.string(forKey: appliedKey)
        if accountLang == "auto", pref != "auto", applied == nil {
            UserDefaults.standard.set(pref, forKey: appliedKey)
            return pref
        }
        guard let lang = accountLang, ["auto", "en", "zh"].contains(lang), lang != applied else { return nil }
        UserDefaults.standard.set(lang, forKey: appliedKey)
        if lang != pref { set(lang) }
        return nil
    }

    /// A choice made here, saved to the account too: not applied back.
    static func noteAccount(_ lang: String) { UserDefaults.standard.set(lang, forKey: appliedKey) }

    /// Starts terminus again, in the language just chosen.
    @MainActor static func relaunch() {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { _, _ in
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

/// "Leave by %@" in the app's language, with the blanks filled. Every word the
/// app writes itself goes through here; the server's come already written.
func L(_ en: String, _ args: String...) -> String {
    let s = Bundle.main.localizedString(forKey: en, value: en, table: nil)
    return args.isEmpty ? s : String(format: s, locale: Lang.locale, arguments: args)
}
