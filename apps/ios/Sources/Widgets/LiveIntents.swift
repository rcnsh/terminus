import AppIntents

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
