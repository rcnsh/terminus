import AppIntents

/// Turn off, on the trip's Live Activity: as Android's on its live
/// notification, the Live Activity setting goes off (Settings › Notifications
/// turns it on again) and the activity ends. The server is told, so it
/// starts none by push.
///
/// Built into the app as well as the widgets: a LiveActivityIntent runs in
/// the app's process (woken in the background if need be), the only one that
/// can end the activity and tell the server.
struct TurnOffLiveIntent: LiveActivityIntent {
    static let title = LocalizedStringResource("Turn off", table: "Widgets")
    static let isDiscoverable = false

    init() {}

    func perform() async throws -> some IntentResult {
        TripPrefs.liveActivity = false
        #if TERMINUS_APP
            await TripSync.liveTurnedOff()
        #endif
        return .result()
    }
}
