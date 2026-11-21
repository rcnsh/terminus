import CoreLocation

enum WatchLocation {
    @MainActor static func fix() async -> (lat: Double, lon: Double, acc: Double?)? {
        guard let f = await Locator.shared.quickFix().fix else { return nil }
        let c = f.coordinate
        WidgetStore.saveLocation(lat: c.latitude, lon: c.longitude, acc: f.acc, at: f.timestamp)
        return (c.latitude, c.longitude, f.acc)
    }
}
