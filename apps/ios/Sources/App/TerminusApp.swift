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
    @MainActor enum DevLaunch {
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
            if env["TERMINUS_API_BASE"] == Servers.stub { Servers.choose(Servers.stub) }
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
