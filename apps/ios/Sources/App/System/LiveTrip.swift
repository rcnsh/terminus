import ActivityKit
import Foundation
import UIKit

/// The Live Activity for a trip under way, Android's live notification:
/// started when the card's phase says the trip is on (due, heading, waiting,
/// riding or missed), updated with each answer, and ended when you're there
/// or the trip is over. Only while it's turned on in Settings and allowed in
/// the phone's. iOS lets the app start one only while it's open; updates, and the end, can come
/// from the background too. Its countdown ticks by itself.
@MainActor enum LiveTrip {
    /// How long a finished trip stays on the Lock Screen, saying you're there.
    static let lingerS: TimeInterval = 5 * 60

    static var allowed: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    /// The activity for `a`: started, updated or ended.
    static func update(_ a: NextAnswer?) async {
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
        if let same = Activity<TripAttributes>.activities.first(where: { $0.attributes.trip == trip && $0.activityState == .active })?.id {
            await Self.update(same, content)
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
            _ = try? Activity.request(attributes: attributes, content: content, pushType: nil)
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
        Push.liveToken = nil
        Push.sync()
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
        await end(Activity<TripAttributes>.activities.map(\.id), arrived: nil)
    }

    /// The server is told each running activity's push token, so it can update it.
    private static func observe(_ activity: Activity<TripAttributes>) {
        Task {
            for await token in activity.pushTokenUpdates {
                Push.liveToken = Api.apnsToken(token, prefix: "apnsla")
                Push.sync(force: true)
            }
        }
    }

    /// At launch: each activity's push token as it comes, whoever started it.
    static func observeTokens() {
        for activity in Activity<TripAttributes>.activities { observe(activity) }
        Task {
            for await activity in Activity<TripAttributes>.activityUpdates { observe(activity) }
        }
    }
}
