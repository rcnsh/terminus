import CoreLocation

/// Where the watch is, for an answer: its own fix while the app is open
/// (the phone's Locator, on the watch's own permission), kept rounded for
/// the complications for two hours at most (WidgetStore.location), as the
/// phone keeps its for its widgets. None without permission: the server
/// plans from your last class or home.
enum WatchLocation {
    @MainActor static func fix() async -> (lat: Double, lon: Double, acc: Double?)? {
        guard let f = await Locator.shared.quickFix().fix else { return nil }
        let c = f.coordinate
        WidgetStore.saveLocation(lat: c.latitude, lon: c.longitude, acc: f.acc, at: f.timestamp)
        return (c.latitude, c.longitude, f.acc)
    }
}
