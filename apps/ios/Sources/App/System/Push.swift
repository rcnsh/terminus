import UIKit

/// Push: Apple's push service, a nudge that the card has changed.
@MainActor enum Push {
    static func launched(_ application: UIApplication) {}
    static func registered(_ token: Data) {}
    static func received(_ userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult { .noData }
}
