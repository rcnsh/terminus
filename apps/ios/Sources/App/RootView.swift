import SwiftUI

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
        .readsWindowWidth()
        .environment(app)
        .environment(prefs)
        .tint(.brand)
        .preferredColorScheme(prefs.colorScheme)
        .onChange(of: app.paired && !app.needsSetup, initial: true) { _, tabs in StatusBar.inTabs = tabs }
        .id(prefs.lang)
        .onOpenURL { Links.open($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            guard let url = activity.webpageURL, let code = SignInCode.pairCode(scanned: url.absoluteString) else { return }
            WelcomeModel.shared.checkPairLink(code)
        }
    }
}

struct MainTabs: View {
    @Environment(AppModel.self) private var app
    @Environment(\.colorScheme) private var scheme
    private let sky = SkyClock.shared

    enum Tab: Hashable { case now, nearby, buses, map, settings }

    @State private var keyboard = false
    @State private var beside = false

    var body: some View {
        let selection = Binding(
            get: { app.tab },
            set: { t in
                if t == app.tab, t == .map { MapModel.shared.home() }
                app.tab = t
            })
        TabView(selection: selection) {
            NowView()
                .keyboardRoom()
                .tabItem { Label(L("Now"), systemImage: "clock") }
                .tag(Tab.now)
            NearbyView()
                .tabItem { Label(L("Nearby"), systemImage: "location") }
                .tag(Tab.nearby)
            BusesView()
                .keyboardRoom()
                .tabItem { Label(L("Stops"), image: "StopSign") }
                .tag(Tab.buses)
            MapTab()
                .keyboardRoom()
                .tabItem { Label(L("Map"), systemImage: "map") }
                .tag(Tab.map)
            SettingsView()
                .keyboardRoom()
                .tabItem { Label(L("Settings"), systemImage: "gearshape") }
                .tag(Tab.settings)
        }
        .environment(\.keyboardUp, keyboard)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
        .onGeometryChange(for: Bool.self) {
            $0.safeAreaInsets.top == 0 && ($0.safeAreaInsets.leading == 0) != ($0.safeAreaInsets.trailing == 0)
        } action: {
            StatusBar.beside = $0
            beside = $0
        }
        .defersSystemGestures(on: beside ? .top : [])
        .onReceive(NotificationCenter.default.publisher(for: .openTab)) { n in
            if let t = n.object as? Tab { app.tab = t }
        }
        .statusBar(light: app.tab == .map ? nil : SkyPalette.of(sky.phase, dark: scheme == .dark).lightInk)
    }
}

extension Notification.Name {
    static let openTab = Notification.Name("terminus.openTab")
}
