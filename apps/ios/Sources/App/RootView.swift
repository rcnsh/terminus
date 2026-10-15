import SwiftUI

/// The welcome and setup until there's an account with a setup, then the tabs.
struct RootView: View {
    @State private var app = AppModel.shared
    @State private var prefs = Prefs.shared

    var body: some View {
        Group {
            if !app.paired {
                WelcomeFlow()
            } else if app.needsSetup {
                OnboardingFlow()
            } else {
                MainTabs()
            }
        }
        .environment(app)
        .environment(prefs)
        .tint(.brand)
        .preferredColorScheme(prefs.colorScheme)
        // A new language redraws everything in it.
        .id(prefs.lang)
        .onOpenURL { Links.open($0) }
    }
}

/// The four tabs, as on Android and the web app.
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    private var sky = SkyClock.shared

    enum Tab: Hashable { case now, buses, map, settings }

    var body: some View {
        // The Map tab tapped while on it goes back to how it opened, as on Android.
        let selection = Binding(
            get: { app.tab },
            set: { t in
                if t == app.tab, t == .map { MapModel.shared.home() }
                app.tab = t
            })
        TabView(selection: selection) {
            NowView()
                .tabItem { Label(L("Now"), systemImage: "clock") }
                .tag(Tab.now)
            BusesView()
                .tabItem { Label(L("Buses"), systemImage: "bus") }
                .tag(Tab.buses)
            MapTab()
                .tabItem { Label(L("Map"), systemImage: "map") }
                .tag(Tab.map)
            SettingsView()
                .tabItem { Label(L("Settings"), systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onReceive(NotificationCenter.default.publisher(for: .openTab)) { n in
            if let t = n.object as? Tab { app.tab = t }
        }
        // Now, Buses and Settings start in the hour's sky: light icons over a
        // dark one. The map is the theme's.
        .statusBar(light: app.tab == .map ? nil : SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk)
    }
}

extension Notification.Name {
    /// Opens a tab from elsewhere (a widget's link, a stop picked on Now): `object` is a MainTabs.Tab.
    static let openTab = Notification.Name("terminus.openTab")
}
