import ActivityKit
import Foundation
import UIKit

@MainActor enum LiveTrip {
    nonisolated static let lingerS: TimeInterval = 10 * 60

    nonisolated static func onScreen(_ state: ActivityState) -> Bool { state == .active || state == .stale }

    static var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    static var supported: Bool { UIDevice.current.userInterfaceIdiom == .phone }

    private static var d: UserDefaults { Shared.defaults }

    static func update(_ a: NextAnswer?) async {
        asked += 1
        let mine = asked
        await serially {
            guard mine == asked else { return }
            await apply(a)
        }
    }

    private static var asked = 0
    private static var tail: Task<Void, Never>?

    static func serially(_ step: @escaping @MainActor () async -> Void) async {
        let before = tail
        let task = Task { @MainActor in
            await before?.value
            await step()
        }
        tail = task
        await task.value
    }

    private static func apply(_ a: NextAnswer?) async {
        dropOrphanToken()
        await endFinished()
        let running = Activity<TripAttributes>.activities.map(\.id)
        guard TripPrefs.liveActivity, allowed, let a, TokenStore.read() != nil,
            let state = TripAttributes.ContentState.of(a)
        else {
            await end(running, arrived: a?.phase == "arrived" ? a : nil)
            return
        }
        let trip = TripReminders.tripKey(a) ?? "trip"
        let content = ActivityContent(state: state, staleDate: a.staleAt?.addingTimeInterval(-ServerClock.skew), relevanceScore: 100)
        let unpushedContent = ActivityContent(
            state: state, staleDate: (a.staleAt ?? state.overAt(linger: lingerS))?.addingTimeInterval(-ServerClock.skew),
            relevanceScore: 100)
        if let act = Activity<TripAttributes>.activities.first(where: { $0.attributes.trip == trip && onScreen($0.activityState) }) {
            let same = act.id
            await Self.update(same, unpushed(act) ? unpushedContent : content)
            await end(running.filter { $0 != same }, arrived: nil)
            return
        }
        await end(running, arrived: nil)
        guard UIApplication.shared.applicationState != .background else { return }
        let attributes = TripAttributes(trip: trip)
        do {
            _ = try Activity.request(attributes: attributes, content: content, pushType: .token)
        } catch {
            _ = try? Activity.request(attributes: attributes, content: unpushedContent, pushType: nil)
        }
    }

    private nonisolated static func update(_ id: String, _ content: ActivityContent<TripAttributes.ContentState>) async {
        guard let act = Activity<TripAttributes>.activities.first(where: { $0.id == id }) else { return }
        if act.content.state != content.state || act.content.staleDate != content.staleDate { await act.update(content) }
    }

    private static func end(_ ids: [String], arrived: NextAnswer?) async {
        guard !ids.isEmpty else { return }
        let words = arrived.map { a in (a.card?.phaseText, a.card?.title ?? a.label, a.card?.line ?? a.label, a.card?.glance) }
        await finish(ids, arrived: words, linger: lingerS)
        if let owner = tokenFor, ids.contains(owner) { forgetToken() }
    }

    private nonisolated static func finish(_ ids: [String], arrived: (String?, String, String, String?)?, linger: TimeInterval) async {
        for act in Activity<TripAttributes>.activities where ids.contains(act.id) {
            if let (phaseText, headline, line, glance) = arrived {
                var state = act.content.state
                state.phase = "arrived"
                state.phaseText = phaseText
                state.headline = headline
                state.line = line
                state.glance = glance ?? state.glance
                state.leaveAt = nil
                state.departAt = nil
                state.arriveAt = nil
                state.staleAt = nil
                await act.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(linger)))
            } else {
                await act.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    static func endAll() async {
        asked += 1
        await serially { await end(Activity<TripAttributes>.activities.map(\.id), arrived: nil) }
    }

    private static func unpushed(_ act: Activity<TripAttributes>) -> Bool {
        act.pushToken == nil || Push.liveToken == nil || act.id != tokenFor
    }

    private static func endFinished() async {
        let now = ServerClock.now
        let over = Activity<TripAttributes>.activities.filter { unpushed($0) && isOver($0.content.state, now: now) }
        await end(over.map(\.id), arrived: nil)
    }

    nonisolated static func isOver(_ s: TripAttributes.ContentState, now: Date) -> Bool {
        s.overAt(linger: lingerS).map { now >= $0 } ?? false
    }

    private static var tokenFor: String? {
        get { d.string(forKey: "live.tokenFor") }
        set { d.set(newValue, forKey: "live.tokenFor") }
    }

    private static func forgetToken() {
        guard Push.liveToken != nil || tokenFor != nil else { return }
        Push.liveToken = nil
        tokenFor = nil
        Push.sync()
    }

    private static func dropOrphanToken() {
        guard Push.liveToken != nil else { return }
        let owner = tokenFor
        if !Activity<TripAttributes>.activities.contains(where: {
            $0.id == owner && onScreen($0.activityState)
        }) {
            forgetToken()
        }
    }

    private static func observe(_ activity: Activity<TripAttributes>) {
        Task {
            for await token in activity.pushTokenUpdates {
                Push.liveToken = Api.apnsToken(token, prefix: "apnsla")
                tokenFor = activity.id
                Push.sync(force: true)
            }
        }
    }

    static func observeTokens() {
        for activity in Activity<TripAttributes>.activities { observe(activity) }
        Task {
            for await activity in Activity<TripAttributes>.activityUpdates { observe(activity) }
        }
        if #available(iOS 17.2, *) {
            Task {
                for await token in Activity<TripAttributes>.pushToStartTokenUpdates {
                    Push.startToken = Api.apnsToken(token, prefix: "apnsstart")
                    Push.sync(force: true)
                }
            }
        }
        Task { await serially { await endFinished() } }
    }
}
