import AppKit
import Foundation

enum Lang {
    private static let key = "AppleLanguages"

    static var pref: String {
        let mine = UserDefaults.standard.persistentDomain(forName: Bundle.main.bundleIdentifier ?? "")?[key] as? [String]
        guard let first = mine?.first else { return "auto" }
        return first.hasPrefix("zh") ? "zh" : "en"
    }

    static func set(_ pref: String) {
        if pref == "auto" {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set([pref == "zh" ? "zh-Hans" : "en"], forKey: key)
        }
    }

    #if DEBUG
        nonisolated(unsafe) static var snapshotTable: [String: String]? = nil
    #endif

    static var zh: Bool {
        #if DEBUG
            if snapshotTable != nil { return true }
        #endif
        return Bundle.main.preferredLocalizations.first?.hasPrefix("zh") == true
    }

    static var header: String { zh ? "zh-Hans" : "en" }

    static var locale: Locale { zh ? Locale(identifier: "zh_Hans_SG") : .current }

    private static let appliedKey = "langApplied"

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

    static func noteAccount(_ lang: String) { UserDefaults.standard.set(lang, forKey: appliedKey) }

    @MainActor static func relaunch() {
        let config = NSWorkspace.OpenConfiguration()
        config.createsNewApplicationInstance = true
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: config) { app, _ in
            guard app != nil else { return }
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }
}

func L(_ en: String, _ args: String...) -> String {
    var s = Bundle.main.localizedString(forKey: en, value: en, table: nil)
    #if DEBUG
        if let t = Lang.snapshotTable { s = t[en] ?? en }
    #endif
    return args.isEmpty ? s : String(format: s, locale: Lang.locale, arguments: args)
}

func spokenTimes(_ s: String) -> String {
    s.replacingOccurrences(of: "~", with: L("about") + " ")
}
