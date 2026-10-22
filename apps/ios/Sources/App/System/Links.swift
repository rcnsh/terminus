import Foundation

/// Links that open the app: a widget's tap, a notification's, the Live
/// Activity's. The same terminus:// links as Android's widgets and shortcuts:
/// terminus://plan, terminus://nearby, terminus://place/<key>,
/// terminus://to/<code>?label=…, and the tabs terminus://buses, map and settings.
@MainActor enum Links {
    /// Longest label a link may put on a tab.
    nonisolated static let maxLabel = 40

    static func open(_ url: URL) {
        guard url.scheme == "terminus", let route = route(url, key: key) else { return }
        let app = AppModel.shared
        switch route {
        case .tab(let tab):
            NotificationCenter.default.post(name: .openTab, object: tab)
            return
        case .plan: if app.paired { app.select(.plan) }
        case .nearby: if app.paired { app.selectNearby() }
        case .place(let key): if app.paired { app.select(.place(key: key)) }
        case .to(let code, let label): if app.paired { app.select(.code(code, label: label)) }
        }
        NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.now)
    }

    enum Route: Equatable {
        case plan, nearby
        case place(String)
        case to(String, String)
        case tab(MainTabs.Tab)
    }

    /// Where `url` goes. A stop looked up (`to`) only from this app's own
    /// widgets, which carry `key`: another app could otherwise add places
    /// with names of its choosing.
    nonisolated static func route(_ url: URL, key: String) -> Route? {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let last = url.pathComponents.dropFirst().first
        switch url.host {
        case "plan", "next": return .plan
        case "nearby": return .nearby
        case "place": return last.map { .place($0) }
        case "to":
            guard let code = last, c?.queryItems?.first(where: { $0.name == "k" })?.value == key else { return nil }
            let label = c?.queryItems?.first { $0.name == "label" }?.value ?? code
            return .to(code, String(label.prefix(maxLabel)))
        case "buses": return .tab(.buses)
        case "map": return .tab(.map)
        case "settings": return .tab(.settings)
        default: return nil
        }
    }

    /// The key this phone's widgets put on their links (WidgetMode.link), made once.
    nonisolated static var key: String { WidgetStore.linkKey }
}
