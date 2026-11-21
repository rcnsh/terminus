import CoreLocation
import Observation

@MainActor @Observable
final class Locator: NSObject, CLLocationManagerDelegate {
    static let shared = Locator()

    private let manager = CLLocationManager()
    private(set) var status: CLAuthorizationStatus
    private var waiting: [UUID: CheckedContinuation<CLLocation?, Never>] = [:]
    private var deciding: [CheckedContinuation<Void, Never>] = []

    override init() {
        status = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    }

    var undecided: Bool { status == .notDetermined }
    var denied: Bool { status == .denied || status == .restricted }
    var allowed: Bool { status == .authorizedWhenInUse || status == .authorizedAlways }

    func ask() { manager.requestWhenInUseAuthorization() }

    func decide() async {
        guard undecided else { return }
        await withCheckedContinuation { c in
            deciding.append(c)
            if deciding.count == 1 { ask() }
        }
    }

    func settle(_ s: CLAuthorizationStatus) {
        status = s
        guard s != .notDetermined else { return }
        let d = deciding
        deciding = []
        for c in d { c.resume() }
    }

    func fix(maxAge: TimeInterval = 60, wait: Duration = .seconds(6)) async -> CLLocation? {
        guard allowed else { return nil }
        if let last = manager.location, Self.fresh(last.timestamp, maxAge: maxAge) { return last }
        let id = UUID()
        return await withCheckedContinuation { c in
            waiting[id] = c
            if waiting.count == 1 { manager.requestLocation() }
            Task { @MainActor in
                try? await Task.sleep(for: wait)
                guard let c = self.waiting.removeValue(forKey: id) else { return }
                c.resume(returning: self.manager.location.flatMap { Self.fresh($0.timestamp, maxAge: maxAge) ? $0 : nil })
            }
        }
    }

    func quickFix() async -> (fix: CLLocation?, later: Task<CLLocation?, Never>?) {
        guard allowed else { return (nil, nil) }
        if let last = manager.location, Self.fresh(last.timestamp, maxAge: Self.freshS) { return (last, nil) }
        let later = Task { await self.fix() }
        let soon = await fix(wait: Self.grace)
        if let soon { return (soon, nil) }
        return (Self.toSend(soon, last: manager.location), later)
    }

    nonisolated static let freshS: TimeInterval = 60
    nonisolated static let grace: Duration = .milliseconds(1_500)
    nonisolated static let lastMaxAgeS: TimeInterval = 10 * 60
    nonisolated static let maxAccM: Double = 200
    nonisolated static let movedM: CLLocationDistance = 50

    nonisolated static func toSend(_ new: CLLocation?, last: CLLocation?, now: Date = Date()) -> CLLocation? {
        new ?? last.flatMap { fresh($0.timestamp, maxAge: lastMaxAgeS, now: now) ? $0 : nil }
    }

    nonisolated static func refreshAgain(sent: CLLocation?, new: CLLocation?, sentAt: Date = Date()) -> Bool {
        guard let new, new !== sent, (new.accAt(new.timestamp) ?? 0) <= maxAccM else { return false }
        guard let sent, (sent.accAt(sentAt) ?? 0) <= maxAccM else { return true }
        return new.distance(from: sent) > movedM
    }

    nonisolated static func fresh(_ at: Date, maxAge: TimeInterval, now: Date = Date()) -> Bool {
        now.timeIntervalSince(at) < maxAge
    }

    var last: CLLocation? { allowed ? manager.location : nil }

    private func finish(_ loc: CLLocation?) {
        let w = waiting
        waiting = [:]
        for c in w.values { c.resume(returning: loc) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
        let s = m.authorizationStatus
        Task { @MainActor in self.settle(s) }
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
    var acc: Double? { accAt(Date()) }

    func accAt(_ now: Date) -> Double? {
        horizontalAccuracy >= 0 ? horizontalAccuracy + max(0, now.timeIntervalSince(timestamp)) * 1.3 : nil
    }
}
