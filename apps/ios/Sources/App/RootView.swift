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
        // The layout follows the window's width, the welcome and setup included.
        .readsWindowWidth()
        .environment(app)
        .environment(prefs)
        .tint(.brand)
        .preferredColorScheme(prefs.colorScheme)
        .onChange(of: app.paired && !app.needsSetup, initial: true) { _, tabs in StatusBar.inTabs = tabs }
        // A new language redraws everything in it.
        .id(prefs.lang)
        .onOpenURL { Links.open($0) }
        // A pairing link from the account page's QR code (/pair?code=…), through Associated Domains.
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL, let code = SignInCode.pairCode(scanned: url.absoluteString) else { return }
            WelcomeModel.shared.checkPairLink(code)
        }
    }
}

/// The four tabs, as on Android and the web app.
struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    private let sky = SkyClock.shared

    enum Tab: Hashable { case now, buses, map, settings }

    /// A keyboard is up. Rotated after a search, iPadOS can hand the pages
    /// the keyboard's room again once it has gone, and keep it: the map then
    /// drew in the top of the window. With none up, that room is ignored.
    @State private var keyboard = false

    var body: some View {
        // The Map tab tapped while on it goes back to how it opened, as on Android.
        let selection = Binding(
            get: { app.tab },
            set: { t in
                if t == app.tab, t == .map { MapModel.shared.home() }
                app.tab = t
            })
        let room: SafeAreaRegions = keyboard ? [] : .keyboard
        TabView(selection: selection) {
            NowView()
                .ignoresSafeArea(room)
                .tabItem { Label(L("Now"), systemImage: "clock") }
                .tag(Tab.now)
            // Stops: a stop sign on its pole, drawn (Support/Assets.xcassets), as SF Symbols has none.
            BusesView()
                .ignoresSafeArea(room)
                .tabItem { Label(L("Stops"), image: "StopSign") }
                .tag(Tab.buses)
            MapTab()
                .ignoresSafeArea(room)
                .tabItem { Label(L("Map"), systemImage: "map") }
                .tag(Tab.map)
            SettingsView()
                .ignoresSafeArea(room)
                .tabItem { Label(L("Settings"), systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
        .onGeometryChange(for: Bool.self) {
            // One side only: a landscape iPhone's notch and corners inset both.
            $0.safeAreaInsets.top == 0 && ($0.safeAreaInsets.leading == 0) != ($0.safeAreaInsets.trailing == 0)
        } action: {
            StatusBar.beside = $0
        }
        .onReceive(NotificationCenter.default.publisher(for: .openTab)) { n in
            if let t = n.object as? Tab { app.tab = t }
        }
        // Now, Stops and Settings start in the hour's sky: light icons over a
        // dark one. The map is the theme's.
        .statusBar(light: app.tab == .map ? nil : SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk)
    }
}

extension Notification.Name {
    /// Opens a tab from elsewhere (a widget's link, a stop picked on Now): `object` is a MainTabs.Tab.
    static let openTab = Notification.Name("terminus.openTab")
}
