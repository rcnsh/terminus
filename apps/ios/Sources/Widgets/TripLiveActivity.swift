import ActivityKit
import SwiftUI
import WidgetKit

/// The trip under way on the Lock Screen and in the Dynamic Island: the
/// bus, the card's line, and a countdown that ticks by itself (to leaving,
/// to the bus, or to getting off). On the bus, how far along the ride is.
/// Past the card's staleAt with nothing newer, it says the times may have
/// changed rather than counting down to a bus that may be gone.
struct TripLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TripAttributes.self) { context in
            LockScreenTrip(state: context.state, stale: context.isStale)
                .activityBackgroundTint(Color.surface)
                .activitySystemActionForegroundColor(Color.ink)
                .widgetURL(URL(string: "terminus://plan"))
        } dynamicIsland: { context in
            let s = context.state
            let count = context.isStale ? nil : s.countdown(phoneNow: Date(), skew: ServerClock.skew)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    TripBadge(state: s, size: 17).padding(.leading, 4).padding(.top, 2)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if let count {
                        Text(timerInterval: count.range, countsDown: true)
                            .font(.system(size: 22, weight: .semibold)).monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .frame(maxWidth: 90, alignment: .trailing)
                            .foregroundStyle(islandAccent)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 1) {
                        if let heading = heading(s) { Text(verbatim: heading).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        Text(verbatim: s.phase == "riding" ? s.headline : s.glance.isEmpty ? s.headline : s.glance)
                            .font(.headline).lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        if s.phase == "riding", let from = s.departDate, let to = s.arriveDate, to > from {
                            RideBar(from: from, to: to, off: s.off, color: serviceColor(s.color), muted: .secondary)
                        }
                        Text(verbatim: context.isStale ? L("Times may have changed. Open terminus to check.") : s.line)
                            .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                TripBadge(state: s, size: 12)
            } compactTrailing: {
                if let count {
                    Text(timerInterval: count.range, countsDown: true)
                        .monospacedDigit()
                        .frame(maxWidth: 52)
                        .foregroundStyle(islandAccent)
                } else {
                    Text(verbatim: s.glance).lineLimit(1).frame(maxWidth: 84)
                }
            } minimal: {
                TripBadge(state: s, size: 11)
            }
            .widgetURL(URL(string: "terminus://plan"))
            .keylineTint(serviceColor(s.color))
        }
    }
}

/// The accent on the Dynamic Island's black: the dark theme's.
private let islandAccent = Color(rgb: 0xFB923C)

/// "On the bus · GEA1000": the phase, then where to.
private func heading(_ s: TripAttributes.ContentState) -> String? {
    let h = [s.phaseText, s.to].compactMap { $0 }.joined(separator: " · ")
    return h.isEmpty ? nil : h
}

/// The bus as painted, or someone walking when there's none.
private struct TripBadge: View {
    let state: TripAttributes.ContentState
    let size: CGFloat

    var body: some View {
        if let svc = state.svc {
            BusBadge(svc: svc, color: state.color, size: size)
        } else {
            Image(systemName: state.phase == "arrived" ? "checkmark.circle.fill" : "figure.walk")
                .font(.system(size: size + 2, weight: .semibold))
                .foregroundStyle(islandAccent)
                .accessibilityHidden(true)
        }
    }
}

/// The Lock Screen's banner: where to and the phase, the card's line with
/// the bus, the countdown big on the right, then the ride's progress.
private struct LockScreenTrip: View {
    let state: TripAttributes.ContentState
    let stale: Bool

    var body: some View {
        let s = state
        let count = stale ? nil : s.countdown(phoneNow: Date(), skew: ServerClock.skew)
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Wordmark(size: 13).foregroundStyle(Color.ink)
                if let h = heading(s) {
                    Text(verbatim: h).font(.system(size: 13, weight: .medium)).foregroundStyle(Color.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(alignment: .center, spacing: 10) {
                TripBadge(state: s, size: 18)
                Text(verbatim: s.phase == "riding" ? s.headline : s.line)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(s.late ? Color.bad : Color.ink)
                    .lineLimit(2).minimumScaleFactor(0.8)
                Spacer(minLength: 4)
                if let count {
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(timerInterval: count.range, countsDown: true)
                            .font(.system(size: 24, weight: .bold)).monospacedDigit()
                            .multilineTextAlignment(.trailing)
                            .foregroundStyle(Color.brand)
                            .frame(maxWidth: 96, alignment: .trailing)
                        Text(verbatim: countWord(count.kind)).font(.system(size: 11, weight: .medium)).foregroundStyle(Color.muted)
                            .lineLimit(1)
                    }
                }
            }
            if s.phase == "riding", let from = s.departDate, let to = s.arriveDate, to > from {
                RideBar(from: from, to: to, off: s.off, color: serviceColor(s.color), muted: Color.muted)
            }
            if stale {
                Text(verbatim: L("Times may have changed. Open terminus to check.")).font(.system(size: 13)).foregroundStyle(Color.warn)
                    .lineLimit(2)
            }
        }
        .padding(16)
        .accessibilityElement(children: .combine)
    }

    /// What the countdown is to, under it.
    private func countWord(_ kind: String) -> String {
        switch kind {
        case "leave": L("to leave")
        case "off": L("to your stop")
        default: L("to the bus")
        }
    }
}

/// On the bus: how far along the ride is, by the clock, ending at the stop
/// you get off at. `from` and `to` are the server's times, as labelled; the
/// bar runs on the phone's clock, so it's moved by the skew between them.
private struct RideBar: View {
    let from: Date
    let to: Date
    let off: String?
    let color: Color
    let muted: Color

    var body: some View {
        let skew = ServerClock.skew
        VStack(alignment: .leading, spacing: 3) {
            ProgressView(timerInterval: from.addingTimeInterval(-skew)...to.addingTimeInterval(-skew), countsDown: false) {
                EmptyView()
            } currentValueLabel: {
                EmptyView()
            }
            .tint(color)
            HStack {
                Text(verbatim: campusTime(from)).font(.system(size: 11)).foregroundStyle(muted)
                Spacer()
                Text(verbatim: [off, campusTime(to)].compactMap { $0 }.joined(separator: " ")).font(.system(size: 11, weight: .medium))
            }
        }
    }
}
