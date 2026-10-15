import CoreLocation
import Observation

/// Where the phone is, when asked: only while the app is in use, never in the
/// background. A fix from the last minute is as good as a new one, so the
/// 30-second refresh doesn't mean a GPS request every 30 seconds. Without
/// a fix the server plans from your last class or home.
@MainActor @Observable
final class Locator: NSObject, CLLocationManagerDelegate {
    static let shared = Locator()

    private let manager = CLLocationManager()
    private(set) var status: CLAuthorizationStatus
    private var waiting: [CheckedContinuation<CLLocation?, Never>] = []

    override init() {
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    /// Not asked yet: the card offers to.
    var undecided: Bool { status == .notDetermined }
    /// Refused (or restricted): only Settings can change it.
    var denied: Bool { status == .denied || status == .restricted }
    var allowed: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }

    func ask() { manager.requestWhenInUseAuthorization() }

    /// A recent fix, or a new one within a few seconds; nil without permission or a fix.
    func fix(maxAge: TimeInterval = 60) async -> CLLocation? {
        guard allowed else { return nil }
        if let last = manager.location, -last.timestamp.timeIntervalSinceNow < maxAge { return last }
        return await withCheckedContinuation { c in
            waiting.append(c)
            if waiting.count == 1 { manager.requestLocation() }
            // A fix that never comes (indoors, the simulator with none set) mustn't hold the answer up.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(6))
                self.finish(self.manager.location)
            }
        }
    }

    /// The last fix this phone had, however old, for a quick answer.
    var last: CLLocation? { allowed ? manager.location : nil }

    private func finish(_ loc: CLLocation?) {
        let w = waiting
        waiting = []
        for c in w { c.resume(returning: loc) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        let s = m.authorizationStatus
        Task { @MainActor in self.status = s }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let l = locations.last
        Task { @MainActor in self.finish(l) }
    }

    nonisolated func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finish(nil) }
    }
}

extension CLLocation {
    /// How far out the fix may be, for the server (`acc`); nil when unknown.
    var acc: Double? { horizontalAccuracy >= 0 ? horizontalAccuracy : nil }
}
