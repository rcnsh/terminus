import Foundation

/// The two trip settings, kept in the app group so the widgets and the
/// notification service read them too. Both are off until turned on in
/// Settings, as on Android. After changing one, call `TripSync.prefsChanged()`.
enum TripPrefs {
    /// "Notify me when to leave for class": a heads-up at the card's
    /// `remindAt` and "Leave now" at the leave-by, as local notifications.
    static var leaveAlerts: Bool {
        get { Shared.defaults.bool(forKey: "leaveAlerts") }
        set { Shared.defaults.set(newValue, forKey: "leaveAlerts") }
    }

    /// The Live Activity during a trip (Android's live notification): on the
    /// Lock Screen and in the Dynamic Island, from "time to go" until you're there.
    static var liveActivity: Bool {
        get { Shared.defaults.bool(forKey: "liveUpdates") }
        set { Shared.defaults.set(newValue, forKey: "liveUpdates") }
    }

    /// The card's phases from "time to go" until you're there: the Live Activity's span.
    static let tripPhases: Set<String> = ["due", "heading", "waiting", "riding", "missed"]
}
