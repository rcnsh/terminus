import Foundation
import Observation

/// The Nearby tab's data (ADR 0017): the stops around you, asked for when
/// the tab opens and again every `AppModel.pollS` while it's the tab on
/// screen and the app is in front, never otherwise. A failed refresh keeps
/// the last answer. Each answer is kept for the widgets that share it
/// (TripSync.nearbyFetched).
@MainActor @Observable
final class NearbyTabModel {
    static let shared = NearbyTabModel()

    /// The stops around you; nil until the first answer.
    private(set) var stops: [NearbyStop]?
    private(set) var loading = false
    private(set) var error: String?
    /// When `stops` came, for "Updated 9:41".
    private(set) var fetchedAt: Date?
    /// When the last answer came, for a pull or a tab opened again sooner than
    /// `Pull.freshS` to ask nothing; nil once it's no longer worth keeping (a new language).
    private var answeredAt: Date?
    /// Nearby is the tab on screen with the app in front, as its view says: nothing is asked for otherwise.
    var onScreen = false

    private var loadTask: Task<Void, Never>?
    private var loadID = 0

    /// A new account, or none: nothing of the last one's.
    func reset() {
        loadTask?.cancel()
        // Not waited for by the next load, which is the new account's.
        loadTask = nil
        loadID += 1
        loading = false
        stops = nil
        error = nil
        fetchedAt = nil
        answeredAt = nil
    }

    /// The server words the boards: asked for again in the new language when the tab next shows.
    func languageChanged() { answeredAt = nil }

    /// Location allowed or refused: the answer there is for somewhere else, so the tab asks as it next shows.
    func locationChanged() { answeredAt = nil }

    /// Fetches the stops around you. Only one runs; `restart` drops one in
    /// flight, so a new location permission is used now rather than after it.
    func load(restart: Bool = false) async {
        guard let token = AppModel.shared.token else { return }
        if loadTask != nil {
            if !restart {
                await loadTask?.value
                return
            }
            loadTask?.cancel()
        }
        loadID += 1
        let id = loadID
        let task = Task { await fetch(token: token) }
        loadTask = task
        await task.value
        if loadID == id { loadTask = nil }
    }

    private func fetch(token: String) async {
        let app = AppModel.shared
        let gen = app.session
        let mine = loadID
        loading = true
        defer { if gen == app.session, mine == loadID { loading = false } }
        let (loc, later) = await Locator.shared.quickFix()
        let sentAt = Date()
        if let later {
            // Asked without waiting for the new fix: once more when it comes,
            // if it puts you somewhere else, so the stops are the ones where you are.
            Task {
                let new = await later.value
                // Not if a newer load has begun since (it asks for itself), nor once the tab has gone.
                guard onScreen, gen == app.session, mine == loadID, Locator.refreshAgain(sent: loc, new: new, sentAt: sentAt) else {
                    return
                }
                await load(restart: true)
            }
        }
        do {
            // With the services not running now too, as the widgets that share it want (NearbyShared).
            let (stops, data) = try await Api(token: token).nearby(
                lat: loc?.coordinate.latitude, lon: loc?.coordinate.longitude, acc: loc?.acc, stopped: true)
            guard gen == app.session, !Task.isCancelled else { return }
            TripSync.nearbyFetched(data, token: token)
            self.stops = stops
            fetchedAt = Date()
            answeredAt = fetchedAt
            error = nil
        } catch is CancellationError {
        } catch let e as ApiError {
            guard gen == app.session else { return }
            if e.status == 401 {
                app.rejected(token, reason: signedOutHere)
            } else {
                error = e.message
            }
        } catch is DecodingError {
            if gen == app.session { error = L("Unexpected response from terminus") }
        } catch {
            if gen == app.session, (error as? URLError)?.code != .cancelled { self.error = L("Offline") }
        }
    }

    /// Pulled down: asked for again, unless the answer came back within
    /// `Pull.freshS` (the server would send the same). Says how it went.
    func pull() async -> PullOutcome {
        let start = Date()
        if !Pull.shouldFetch(lastOK: answeredAt, now: start) { return .upToDate(nextInS: nil) }
        await load()
        return (answeredAt ?? .distantPast) >= start ? .updated : .failed
    }

    /// Runs while Nearby is the tab on screen and the app is active: at Now's pace, as when Nearby was its chip.
    func poll() async {
        let wait = Self.waitOnOpening(lastOK: answeredAt, now: Date())
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(max(AppModel.pollS, Quiet.wait())))
        }
    }

    /// How long the tab, opened, waits before asking: nothing, unless its
    /// last answer is under `Pull.freshS` old, which the server would only
    /// send again; then until that answer's next refresh was due, so going
    /// to another tab and back asks no more than staying did.
    static func waitOnOpening(lastOK: Date?, now: Date) -> TimeInterval {
        guard let lastOK, !Pull.shouldFetch(lastOK: lastOK, now: now) else { return 0 }
        return max(0, AppModel.pollS - now.timeIntervalSince(lastOK))
    }
}
