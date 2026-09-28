import AppKit
import Foundation
import Observation
import os
import ServiceManagement

private let log = Logger(subsystem: "sh.rcn.nusbus", category: "refresh")

@MainActor
@Observable
final class AppModel {
    static let shared = AppModel()

    var paired = TokenStore.read() != nil
    var pairing = false
    var pairError: String?

    /// Always the planned trip: this is what the menu bar shows.
    var plan: NextAnswer? { answers[.plan] }
    var target: Target = .plan
    /// The last answer per view. Switching views shows the cached one at once
    /// and refreshes it in place, instead of blanking the popover (which made
    /// it collapse and then grow back when the data arrived).
    var answers: [Target: NextAnswer] = [:]
    var shown: NextAnswer? { answers[target] }
    var showNearby = false
    var nearby: [NearbyStop]?
    var loading = false
    var places: [Place] = []
    var destinations: [Destination] = []

    var error: String?
    var updated: Date?
    var popoverOpen = false { didSet { if popoverOpen { kick() } } }
    var needsLocation: Bool { locator.undecided }

    var openAtLogin: Bool {
        get { SMAppService.mainApp.status == .enabled }
        set {
            do {
                if newValue { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            } catch {
                self.error = "Couldn't change the login item: \(error.localizedDescription)"
            }
        }
    }

    private let locator = Locator()
    private var paused = false
    private var loop: Task<Void, Never>?

    init() {
        log.notice("start: paired=\(self.paired) base=\(Api.base, privacy: .public)")
        observeSleep()
        start()
    }

    /// The menu bar text: "D2 4m", or nil for the plain icon.
    var menuTitle: String? {
        guard let plan, plan.quality != "ended", plan.label != "Set up" else { return nil }
        let short = plan.label
            .replacingOccurrences(of: " · ", with: " ")
            .replacingOccurrences(of: " min", with: "m")
        return short.count > 16 ? String(short.prefix(15)) + "…" : short
    }

    // MARK: pairing

    func pair(_ code: String) {
        pairing = true
        pairError = nil
        Task {
            do {
                let name = Host.current().localizedName ?? "Mac"
                let token = try await Api(token: nil).pair(code: code, name: String(name.prefix(40)))
                TokenStore.write(token)
                paired = true
                pairing = false
                if locator.undecided { locator.ask() }
                kick()
            } catch let e as ApiError {
                pairing = false
                pairError = e.message
            } catch {
                pairing = false
                pairError = "Couldn't reach nusbus. Check your connection and try again."
            }
        }
    }

    func unpair() {
        let token = TokenStore.read()
        Task {
            try? await Api(token: token).logout()
            TokenStore.write(nil)
            paired = false
            answers = [:]
            nearby = nil
            places = []
            target = .plan
            showNearby = false
        }
    }

    func askLocation() { locator.ask() }

    // MARK: what the popover shows

    func select(_ t: Target) {
        target = t
        showNearby = false
        kick()
    }

    func selectNearby() {
        showNearby = true
        kick()
    }

    func loadDestinations() {
        guard destinations.isEmpty else { return }
        Task { destinations = (try? await Api(token: TokenStore.read()).destinations()) ?? [] }
    }

    // MARK: refresh loop

    /// 30 s while the popover is open, 2 min otherwise; nothing while asleep
    /// or locked. The API caches each stop for 15 s, so faster shows nothing new.
    private func start() {
        loop?.cancel()
        loop = Task {
            while !Task.isCancelled {
                if !paused && paired { await refresh() }
                try? await Task.sleep(for: .seconds(popoverOpen ? 30 : 120))
            }
        }
    }

    private func kick() { start() }

    func refresh() async {
        guard let token = TokenStore.read() else {
            log.notice("no token; showing pairing")
            paired = false
            return
        }
        log.debug("refreshing against \(Api.base, privacy: .public)")
        let api = Api(token: token)
        let loc = await locator.current()
        let lat = loc?.coordinate.latitude, lon = loc?.coordinate.longitude
        loading = true
        defer { loading = false }
        do {
            // What's on screen first; the plan (for the menu bar) after.
            if showNearby {
                nearby = try await api.nearby(lat: lat, lon: lon)
            } else if target != .plan {
                answers[target] = try await api.next(target, lat: lat, lon: lon)
            }
            let p = try await api.next(.plan, lat: lat, lon: lon)
            answers[.plan] = p
            places = p.places ?? []
            error = nil
            updated = Date()
        } catch let e as ApiError where e.status == 401 {
            TokenStore.write(nil)
            paired = false
            pairError = "This Mac was removed from your account. Pair it again."
        } catch let e as ApiError {
            log.error("api error \(e.status): \(e.message, privacy: .public)")
            error = e.message
        } catch {
            // kick() restarts the loop and cancels a refresh in flight; that
            // is not an outage.
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { return }
            log.error("refresh failed: \(error.localizedDescription, privacy: .public)")
            self.error = "Offline"
        }
    }

    private func observeSleep() {
        let ws = NSWorkspace.shared.notificationCenter
        ws.addObserver(forName: NSWorkspace.willSleepNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = true }
        }
        ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = false; self?.kick() }
        }
        let dist = DistributedNotificationCenter.default()
        dist.addObserver(forName: .init("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = true }
        }
        dist.addObserver(forName: .init("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.paused = false; self?.kick() }
        }
    }
}
