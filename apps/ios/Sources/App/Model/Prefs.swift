import SwiftUI

/// The choices kept on this phone that redraw the app: its language, its
/// appearance and the card's style. The account keeps its own copy of the
/// language and the clock; Settings saves both.
@MainActor @Observable
final class Prefs {
    static let shared = Prefs()

    /// auto, en or zh (Lang.pref), here so a change redraws the app.
    var lang: String = Lang.pref {
        didSet {
            guard lang != oldValue else { return }
            Lang.pref = lang
            AppModel.shared.languageChanged()
        }
    }

    /// auto, light or dark.
    var theme: String = Shared.defaults.string(forKey: "theme") ?? "auto" {
        didSet { Shared.defaults.set(theme, forKey: "theme") }
    }

    /// steps or route: how Now draws a trip (Settings › Appearance).
    var cardStyle: String = Shared.defaults.string(forKey: "cardStyle") ?? "steps" {
        didSet { Shared.defaults.set(cardStyle, forKey: "cardStyle") }
    }

    /// auto, 12 or 24 (Clock.pref).
    var clock: String = Clock.pref {
        didSet { Clock.pref = clock }
    }

    var colorScheme: ColorScheme? {
        switch theme {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }
}
