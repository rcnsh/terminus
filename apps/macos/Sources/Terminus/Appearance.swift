import AppKit

/// Light, dark, or the Mac's own setting ("auto"), chosen in Settings ›
/// Appearance, for this Mac only. Applied to the whole app (the popover and
/// every window) as its appearance; "auto" leaves it to the Mac.
@MainActor
enum Appearance {
    static let key = "theme"

    static var pref: String { UserDefaults.standard.string(forKey: key) ?? "auto" }

    /// The saved choice, applied at launch and whenever it changes.
    static func apply() {
        NSApp.appearance = switch pref {
        case "light": NSAppearance(named: .aqua)
        case "dark": NSAppearance(named: .darkAqua)
        default: nil
        }
    }
}
