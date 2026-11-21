import SwiftUI
import WidgetKit

@MainActor @Observable
final class Prefs {
    static let shared = Prefs()

    var lang: String = Lang.pref {
        didSet {
            guard lang != oldValue else { return }
            Lang.pref = lang
            AppModel.shared.languageChanged()
        }
    }

    var theme: String = Shared.defaults.string(forKey: "theme") ?? "auto" {
        didSet { Shared.defaults.set(theme, forKey: "theme") }
    }

    var cardStyle: String = Shared.defaults.string(forKey: "cardStyle") ?? "steps" {
        didSet { Shared.defaults.set(cardStyle, forKey: "cardStyle") }
    }

    var newToNus: Bool = NewToNus.on {
        didSet {
            guard newToNus != oldValue else { return }
            NewToNus.on = newToNus
            WidgetCenter.shared.reloadTimelines(ofKind: "nearby")
        }
    }

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
