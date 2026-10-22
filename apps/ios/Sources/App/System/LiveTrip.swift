import ActivityKit
import Foundation
import UIKit

/// The Live Activity for a trip under way, Android's live notification:
/// started when the card's phase says the trip is on (due, heading, waiting,
/// riding or missed), updated with each answer, and ended when you're there
/// or the trip is over. Only while it's turned on in Settings and allowed in
/// the phone's. iOS lets the app start one only while it's open; updates, and the end, can come
/// from the background too. From iOS 17.2 the server starts one by push
/// (the push-to-start token, `apnsstart:`) when the trip is due or missed
/// with the app closed, as Android's starts from a push. Its countdown ticks by itself.
@MainActor enum LiveTrip {
    /// How long a finished trip stays on the Lock Screen, saying you're there.
    nonisolated static let lingerS: TimeInterval = 5 * 60

    static var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    private static var d: UserDefaults { Shared.defaults }

    /// The activity for `a`: started, updated or ended. One step at a time:
    /// two answers close together would otherwise both find no activity
    /// across their awaits and start one each. A step overtaken by a later
    /// answer before its turn is skipped; the later one is what counts.
    static func update(_ a: NextAnswer?) async {
        asked += 1
        let mine = asked
        await serially {
            guard mine == asked else { return }
            await apply(a)
        }
    }

    /// Bumped by each update and endAll, so a queued update can tell it's been overtaken.
    private static var asked = 0
    /// The last step queued: each waits for the one before it.
    private static var tail: Task<Void, Never>?

    /// Runs `step` after every step queued before it, and waits for it.
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
        // Stale past the card's staleAt: the Lock Screen dims it and says so.
        let content = ActivityContent(state: state, staleDate: a.staleAt?.addingTimeInterval(-ServerClock.skew), relevanceScore: 100)
        // One no push can reach dims when the trip should be over, whatever the card said, until the app ends it.
        let unpushedContent = ActivityContent(
            state: state, staleDate: (a.staleAt ?? state.overAt(linger: lingerS))?.addingTimeInterval(-ServerClock.skew),
            relevanceScore: 100)
        if let act = Activity<TripAttributes>.activities.first(where: { $0.attributes.trip == trip && $0.activityState == .active }) {
            let same = act.id
            await Self.update(same, unpushed(act) ? unpushedContent : content)
            await end(running.filter { $0 != same }, arrived: nil)
            return
        }
        await end(running, arrived: nil)
        // Only the open app may start one.
        guard UIApplication.shared.applicationState != .background else { return }
        let attributes = TripAttributes(trip: trip)
        do {
            // Its push token comes through activityUpdates (observeTokens).
            _ = try Activity.request(attributes: attributes, content: content, pushType: .token)
        } catch {
            // Without push (a build without the entitlement): it still runs, updated from the app.
            _ = try? Activity.request(attributes: attributes, content: unpushedContent, pushType: nil)
        }
    }

    /// Updates one activity, found again here by its id: an Activity isn't
    /// Sendable, so it's never handed from the main actor to ActivityKit's calls.
    private nonisolated static func update(_ id: String, _ content: ActivityContent<TripAttributes.ContentState>) async {
        guard let act = Activity<TripAttributes>.activities.first(where: { $0.id == id }) else { return }
        if act.content.state != content.state || act.content.staleDate != content.staleDate { await act.update(content) }
    }

    /// Ends the activities `ids`; with `arrived`, they say so for a few minutes first.
    private static func end(_ ids: [String], arrived: NextAnswer?) async {
        guard !ids.isEmpty else { return }
        let words = arrived.map { a in (a.card?.phaseText, a.card?.title ?? a.label, a.card?.line ?? a.label, a.card?.glance) }
        await finish(ids, arrived: words, linger: lingerS)
        // The server's token goes only with the activity it's for, not with a duplicate ended beside it.
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

    /// Every activity goes: signed out, or turned off.
    static func endAll() async {
        asked += 1
        await serially { await end(Activity<TripAttributes>.activities.map(\.id), arrived: nil) }
    }

    // MARK: without push

    /// Whether the server can't update `act`: started without push (a build
    /// without the entitlement), or its token isn't the one the server has.
    private static func unpushed(_ act: Activity<TripAttributes>) -> Bool {
        act.pushToken == nil || Push.liveToken == nil || act.id != tokenFor
    }

    /// Ends the activities no push can end once their trip is over: they'd
    /// otherwise say "Times may have changed" until iOS's own limit. Each
    /// time the app runs, in the foreground or the background.
    private static func endFinished() async {
        let now = ServerClock.now
        let over = Activity<TripAttributes>.activities.filter { unpushed($0) && isOver($0.content.state, now: now) }
        await end(over.map(\.id), arrived: nil)
    }

    /// Whether a trip nothing can update is over at `now` (the server's clock).
    nonisolated static func isOver(_ s: TripAttributes.ContentState, now: Date) -> Bool {
        s.overAt(linger: lingerS).map { now >= $0 } ?? false
    }

    // MARK: the push token

    /// The activity the live token sent to the server belongs to.
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

    /// The token's activity has gone without the app ending it (swiped away, iOS's limit): so does the token.
    private static func dropOrphanToken() {
        guard Push.liveToken != nil else { return }
        let owner = tokenFor
        if !Activity<TripAttributes>.activities.contains(where: {
            $0.id == owner && ($0.activityState == .active || $0.activityState == .stale)
        }) {
            forgetToken()
        }
    }

    /// The server is told each running activity's push token, so it can update it.
    private static func observe(_ activity: Activity<TripAttributes>) {
        Task {
            for await token in activity.pushTokenUpdates {
                Push.liveToken = Api.apnsToken(token, prefix: "apnsla")
                tokenFor = activity.id
                Push.sync(force: true)
            }
        }
    }

    /// At launch: each activity's push token as it comes, whoever started
    /// it (the app, or the server by push); the token that lets the server
    /// start one; and the ones no push can end, ended if their trip is over.
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
