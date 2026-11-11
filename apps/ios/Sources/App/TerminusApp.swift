import SwiftUI
import UIKit

@main
struct TerminusApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        #if DEBUG
            DevLaunch.apply()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// What only a UIKit app delegate hears: the push token, and pushes.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        CrashReporter.shared.start()
        WatchLink.shared.start()
        Push.launched(application)
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Push.registered(deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// Info.plist lets an iPhone turn on its side; this keeps it upright
    /// except on a screen tall enough on its side (WindowWidth.phoneTurns).
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        guard UIDevice.current.userInterfaceIdiom == .phone, let screen = window?.windowScene?.screen else { return .all }
        let b = screen.bounds
        return WindowWidth.phoneTurns(shortSide: min(b.width, b.height)) ? .allButUpsideDown : .portrait
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async
        -> UIBackgroundFetchResult
    {
        await Push.received(userInfo)
    }
}

#if DEBUG
    /// For the UI tests and screenshots, in debug builds only: TERMINUS_RESET=1
    /// starts signed out with nothing kept, TERMINUS_TOKEN (and TERMINUS_EMAIL)
    /// signed in with that token, TERMINUS_LANG=en|zh|auto sets the language,
    /// TERMINUS_API_BASE the server (the stub at http://localhost:8787 is kept as the
    /// developer menu's choice), TERMINUS_THEME=light|dark the appearance, TERMINUS_CARD_STYLE=steps|route
    /// the card's style, TERMINUS_NEW_TO_NUS=1|0 New to NUS, TERMINUS_VIEW=nearby opens on the Nearby
    /// tab, as on the watch (and TERMINUS_SKY=night|dawn|day|golden|dusk the sky's hour, in SkyClock).
    @MainActor enum DevLaunch {
        /// TERMINUS_LANG was given: the account takes this phone's language, rather than the other way round.
        nonisolated(unsafe) static var langPinned = false

        static func apply() {
            let env = ProcessInfo.processInfo.environment
            if env["TERMINUS_RESET"] == "1" {
                TokenStore.clear()
                for k in Shared.defaults.dictionaryRepresentation().keys { Shared.defaults.removeObject(forKey: k) }
                Shared.lastAnswer = nil
                Shared.lastDay = nil
                Shared.lastNearby = nil
            }
            // The stub at its usual address is chosen in the developer menu too,
            // so the app stays on it when opened again from the home screen.
            if env["TERMINUS_API_BASE"] == Servers.stub { Servers.choose(Servers.stub) }
            // Signed in already (a token from the stub's POST /__stub/session), set up.
            if let t = env["TERMINUS_TOKEN"], !t.isEmpty {
                TokenStore.save(t)
                Shared.defaults.set(env["TERMINUS_EMAIL"], forKey: "email")
                Shared.defaults.set(env["TERMINUS_EMAIL"] == nil, forKey: "anonymous")
                Shared.defaults.set(false, forKey: "needsSetup")
            }
            if let l = env["TERMINUS_LANG"] {
                Lang.pref = l
                langPinned = true
            }
            if let t = env["TERMINUS_THEME"] { Shared.defaults.set(t, forKey: "theme") }
            if let s = env["TERMINUS_CARD_STYLE"] { Shared.defaults.set(s, forKey: "cardStyle") }
            if let n = env["TERMINUS_NEW_TO_NUS"] { NewToNus.on = n == "1" }
            if env["TERMINUS_VIEW"] == "nearby" { AppModel.shared.tab = .nearby }
        }
    }
#endif
