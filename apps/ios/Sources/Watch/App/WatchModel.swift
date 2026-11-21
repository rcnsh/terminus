import Foundation
import Observation

@MainActor @Observable
final class WatchModel {
    static let shared = WatchModel()

    enum View: Hashable {
        case plan
        case nearby
        case place(key: String, label: String)

        var label: String {
            switch self {
            case .plan: L("Next")
            case .nearby: L("Nearby")
            case .place(_, let label): label
            }
        }

        var target: Target? {
            switch self {
            case .plan: .plan
            case .nearby: nil
            case .place(let key, _): .place(key: key)
            }
        }
    }

    private(set) var paired = TokenStore.read() != nil
    private(set) var signedOutReason = WatchSession.signedOutReason
    var view: View = .plan
    private(set) var placeAnswers: [String: NextAnswer] = [:]
    private(set) var plan: NextAnswer?
    private(set) var nearby: [NearbyStop]?
    private(set) var nearbyAt: Date?
    private(set) var loading = false
    private(set) var error: String?
    private(set) var signalling = false
    private(set) var pairing = false
    private var waitingCode: WatchHandoff.Code?
    private(set) var pairError: String?
    private var session = 0
    private(set) var lang = Lang.pref

    init() {
        plan = paired ? WidgetStore.plan()?.0 : nil
    }

    var places: [Place] { plan?.places ?? [] }

    var answer: NextAnswer? {
        switch view {
        case .plan: plan
        case .nearby: nil
        case .place(let key, _): placeAnswers[key]
        }
    }

    var shows: NowShows {
        NowShows.of(
            nearby: view == .nearby, answer: answer, onPlan: view == .plan, paired: paired, error: error, loading: loading, day: nil,
            now: ServerClock.now)
    }

    func choose(_ v: View) {
        guard v != view else { return }
        view = v
        error = nil
    }

    func load() async {
        guard paired, let token = TokenStore.read() else { return }
        let gen = session
        let v = view
        loading = true
        defer { if gen == session { loading = false } }
        let loc = await WatchLocation.fix()
        switch v {
        case .plan:
            let before = Lang.pref
            let came = WidgetStore.answerAt
            await WatchPlan.refresh()
            guard gen == session else { return }
            if TokenStore.read() != token { return syncSignedOut() }
            plan = WidgetStore.plan()?.0
            error = WidgetStore.error
            if Lang.pref != before { lang = Lang.pref }
            if WidgetStore.answerAt != came || Lang.pref != before { WatchPlan.redraw() }
        case .nearby:
            do {
                let (stops, _) = try await Api(token: token).nearby(lat: loc?.lat, lon: loc?.lon, acc: loc?.acc)
                guard gen == session, view == v else { return }
                nearby = stops
                nearbyAt = ServerClock.now
                error = nil
            } catch {
                handle(error, token: token, gen: gen)
            }
        case .place(let key, _):
            do {
                let a = try await Api(token: token).next(.place(key: key), lat: loc?.lat, lon: loc?.lon, acc: loc?.acc)
                guard gen == session else { return }
                placeAnswers[key] = a
                error = nil
            } catch {
                handle(error, token: token, gen: gen)
            }
        }
    }

    func nextLoad(now: Date = ServerClock.now) -> TimeInterval {
        let wait: TimeInterval
        switch view {
        case .nearby:
            wait = NearbyShared.refetch
        case .plan:
            if let (a, at) = WatchPlan.kept() {
                wait = WidgetTiming.nextRefreshAt(a, fetchedAt: at, now: now).timeIntervalSince(now)
            } else {
                wait = WidgetTiming.fallback
            }
        case .place(let key, _):
            wait =
                placeAnswers[key].map { WidgetTiming.nextRefreshAt($0, fetchedAt: now, now: now).timeIntervalSince(now) }
                ?? WidgetTiming.fallback
        }
        return max(wait, Quiet.wait(), WidgetTiming.minGap)
    }

    func follow() async {
        while !Task.isCancelled {
            await load()
            try? await Task.sleep(for: .seconds(nextLoad()))
        }
    }

    private func handle(_ e: Error, token: String, gen: Int) {
        guard gen == session else { return }
        if let e = e as? ApiError, e.status == 401 {
            WatchSession.rejected(token)
            syncSignedOut()
        } else if e is CancellationError || (e as? URLError)?.code == .cancelled {
        } else {
            error = failureMessage(e, otherwise: L("Offline"))
        }
    }

    func step(_ s: Step, to: StepTarget?, dir: String?) {
        guard let token = TokenStore.read(), !signalling else { return }
        signalling = true
        error = nil
        let gen = session
        let v = view
        Task {
            defer { if gen == session { signalling = false } }
            let loc = WidgetStore.location
            do {
                let a = try await Api(token: token).step(trip: s.trip, to: to, dir: dir, lat: loc?.lat, lon: loc?.lon)
                guard gen == session else { return }
                if case .place(let key, _) = v, s.trip.hasPrefix("place:") || s.trip.hasPrefix("to:") {
                    placeAnswers[key] = a
                } else {
                    WidgetStore.keep(a)
                    plan = a
                    WatchPlan.redraw()
                }
            } catch {
                handle(error, token: token, gen: gen)
            }
        }
    }

    func redeem(_ c: WatchHandoff.Code) async {
        guard !pairing else {
            waitingCode = c
            return
        }
        pairing = true
        defer { pairing = false }
        var next: WatchHandoff.Code? = c
        while let c = next {
            pairError = nil
            let old = TokenStore.read()
            do {
                let token = try await Api(token: nil).pair(code: c.code, name: watchName)
                WatchSession.signedIn(token: token, lang: c.lang, clock: c.clock)
                if let old, old != token { Task.detached { try? await Api(token: old).logout() } }
                session += 1
                paired = true
                signedOutReason = nil
                lang = Lang.pref
                view = .plan
                plan = nil
                placeAnswers = [:]
                nearby = nil
                error = nil
                PhoneLink.shared.report()
                await load()
            } catch {
                pairError = failureMessage(error)
            }
            next = waitingCode
            waitingCode = nil
        }
    }

    func signOut() {
        WatchSession.signOut()
        syncSignedOut()
    }

    func syncSignedOut() {
        guard TokenStore.read() == nil else { return }
        session += 1
        paired = false
        signedOutReason = WatchSession.signedOutReason
        view = .plan
        plan = nil
        placeAnswers = [:]
        nearby = nil
        error = nil
        PhoneLink.shared.report()
    }

    func reopened() {
        if paired && TokenStore.read() == nil { syncSignedOut() }
        if paired { plan = WidgetStore.plan()?.0 ?? plan }
        if lang != Lang.pref { lang = Lang.pref }
    }

    private var watchName: String { "Apple Watch" }
}
