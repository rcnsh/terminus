import AppKit

@MainActor
enum Appearance {
    static let key = "theme"

    static var pref: String { UserDefaults.standard.string(forKey: key) ?? "auto" }

    static func apply() {
        NSApp.appearance =
            switch pref {
            case "light": NSAppearance(named: .aqua)
            case "dark": NSAppearance(named: .darkAqua)
            default: nil
            }
    }
}
