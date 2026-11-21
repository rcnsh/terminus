import Foundation
import Observation

@MainActor @Observable
final class NearbyTabModel {
    static let shared = NearbyTabModel()

    private(set) var stops: [NearbyStop]?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var fetchedAt: Date?
    private var answeredAt: Date?
    var onScreen = false

    private var loadTask: Task<Void, Never>?
    private var loadID = 0

    func reset() {
        loadTask?.cancel()
        loadTask = nil
        loadID += 1
        loading = false
        stops = nil
        error = nil
        fetchedAt = nil
        answeredAt = nil
    }

    func languageChanged() { answeredAt = nil }

    func locationChanged() { answeredAt = nil }

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
            Task {
                let new = await later.value
                guard onScreen, gen == app.session, mine == loadID, Locator.refreshAgain(sent: loc, new: new, sentAt: sentAt) else {
                    return
                }
                await load(restart: true)
            }
        }
        do {
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

    func pull() async -> PullOutcome {
        let start = Date()
        if !Pull.shouldFetch(lastOK: answeredAt, now: start) { return .upToDate(nextInS: nil) }
        await load()
        return (answeredAt ?? .distantPast) >= start ? .updated : .failed
    }

    func poll() async {
        let wait = Self.waitOnOpening(lastOK: answeredAt, now: Date())
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(max(AppModel.pollS, Quiet.wait())))
        }
    }

    static func waitOnOpening(lastOK: Date?, now: Date) -> TimeInterval {
        guard let lastOK, !Pull.shouldFetch(lastOK: lastOK, now: now) else { return 0 }
        return max(0, AppModel.pollS - now.timeIntervalSince(lastOK))
    }
}
