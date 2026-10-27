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
    private var waiting: [UUID: CheckedContinuation<CLLocation?, Never>] = [:]

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

    /// A recent fix, or a new one within `wait`; nil without permission or a fix.
    func fix(maxAge: TimeInterval = 60, wait: Duration = .seconds(6)) async -> CLLocation? {
        guard allowed else { return nil }
        if let last = manager.location, Self.fresh(last.timestamp, maxAge: maxAge) { return last }
        let id = UUID()
        return await withCheckedContinuation { c in
            waiting[id] = c
            if waiting.count == 1 { manager.requestLocation() }
            // A fix that never comes (indoors, the simulator with none set)
            // mustn't hold the answer up. This ask's own wait only, and only
            // a fix still within maxAge: an hours-old one from home would
            // plan from the wrong stop, where none lets the server use your
            // last class or home.
            Task { @MainActor in
                try? await Task.sleep(for: wait)
                guard let c = self.waiting.removeValue(forKey: id) else { return }
                c.resume(returning: self.manager.location.flatMap { Self.fresh($0.timestamp, maxAge: maxAge) ? $0 : nil })
            }
        }
    }

    /// A fix for an answer now: a recent one, else a new one if it comes
    /// within `grace`, else the last one while it's under `lastMaxAgeS` old
    /// (its `acc` says how far you may have walked since), else none. When
    /// it couldn't wait, `later` is the new fix still on its way, up to the
    /// usual few seconds, for the caller to check with `refreshAgain`. One
    /// location request either way, as with `fix()`.
    func quickFix() async -> (fix: CLLocation?, later: Task<CLLocation?, Never>?) {
        guard allowed else { return (nil, nil) }
        if let last = manager.location, Self.fresh(last.timestamp, maxAge: Self.freshS) { return (last, nil) }
        // Both wait on the one request, which this first ask starts: `later`
        // only joins it once this has suspended.
        let later = Task { await self.fix() }
        let soon = await fix(wait: Self.grace)
        if let soon { return (soon, nil) }
        return (Self.toSend(soon, last: manager.location), later)
    }

    /// A fix younger than this is used without asking for another.
    nonisolated static let freshS: TimeInterval = 60
    /// How long an answer waits for a new fix before going without it.
    nonisolated static let grace: Duration = .milliseconds(1_500)
    /// The last fix stands in for a new one while it's younger than this.
    nonisolated static let lastMaxAgeS: TimeInterval = 10 * 60
    /// The server drops a fix whose `acc` is over this (`MAX_FIX_ACC_M` there).
    nonisolated static let maxAccM: Double = 200
    /// A new fix this far from the one sent changes the answer enough to ask again.
    nonisolated static let movedM: CLLocationDistance = 50

    /// What goes with the request: the new fix, else the last one while it's recent enough.
    nonisolated static func toSend(_ new: CLLocation?, last: CLLocation?, now: Date = Date()) -> CLLocation? {
        new ?? last.flatMap { fresh($0.timestamp, maxAge: lastMaxAgeS, now: now) ? $0 : nil }
    }

    /// Whether the fix that came after the request should ask again: it went
    /// without one, or from somewhere else. The second ask finds this fix
    /// recent, so it doesn't wait or ask again.
    /// A sent fix the server drops (its `acc`, at `sentAt`, past `maxAccM`)
    /// counts as none.
    nonisolated static func refreshAgain(sent: CLLocation?, new: CLLocation?, sentAt: Date = Date()) -> Bool {
        // Nothing new, or a fix the server would drop too: asking again repeats the ask.
        guard let new, new !== sent, (new.accAt(new.timestamp) ?? 0) <= maxAccM else { return false }
        guard let sent, (sent.accAt(sentAt) ?? 0) <= maxAccM else { return true }
        return new.distance(from: sent) > movedM
    }

    /// Whether a fix taken `at` is recent enough.
    nonisolated static func fresh(_ at: Date, maxAge: TimeInterval, now: Date = Date()) -> Bool {
        now.timeIntervalSince(at) < maxAge
    }

    /// The last fix this phone had, however old, for a quick answer.
    var last: CLLocation? { allowed ? manager.location : nil }

    private func finish(_ loc: CLLocation?) {
        let w = waiting
        waiting = [:]
        for c in w.values { c.resume(returning: loc) }
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
    /// How far out the fix may be, for the server (`acc`): its accuracy, plus
    /// how far you could have walked since at 1.3 m/s, as Android sends it.
    /// The server drops one past 200 m. Nil when the accuracy is unknown.
    var acc: Double? { accAt(Date()) }

    func accAt(_ now: Date) -> Double? {
        horizontalAccuracy >= 0 ? horizontalAccuracy + max(0, now.timeIntervalSince(timestamp)) * 1.3 : nil
    }
}
