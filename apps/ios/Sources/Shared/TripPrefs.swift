import Foundation

enum TripPrefs {
    static var leaveAlerts: Bool {
        get { Shared.defaults.bool(forKey: "leaveAlerts") }
        set { Shared.defaults.set(newValue, forKey: "leaveAlerts") }
    }

    static var liveActivity: Bool {
        get { Shared.defaults.bool(forKey: "liveUpdates") }
        set { Shared.defaults.set(newValue, forKey: "liveUpdates") }
    }

    static let tripPhases: Set<String> = ["due", "heading", "waiting", "riding", "missed"]
}
