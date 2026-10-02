import SwiftUI
import os

/// The hero: where you're going, the answer, and whether it's live.
struct Header: View {
    @Bindable var model: AppModel

    var body: some View {
        let a = model.showNearby ? model.plan : model.shown
        let resting = !model.showNearby && a?.mode == "rest"
        // Offline with the plan gone stale: the day plan's next thing (OfflineDay).
        let offline = !model.showNearby && model.target == .plan ? model.offlinePick(at: model.clock) : nil
        HStack(alignment: .center, spacing: 12) {
            IconTile(
                system: model.showNearby ? "location.fill" : resting ? "moon.zzz.fill" : a?.arrived == true ? "checkmark.circle.fill" : "bus.fill",
                tint: .brand
            )
            VStack(alignment: .leading, spacing: 3) {
                Text(offline.map { OfflineDay.lines($0).head } ?? heading(a))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                // Ticks every second: the countdown and the dimming are
                // computed from the departure time, never from `label`.
                Ticking(every: 1) { now in
                    if let p = offline.flatMap({ _ in model.offlinePick(at: now) }) {
                        let lines = OfflineDay.lines(p)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(lines.big)
                                .font(.system(size: 20, weight: .bold, design: .rounded))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                            StatusLine(color: .gray, text: L("Offline"))
                        }
                    } else {
                        let old = !model.showNearby && !resting && a?.arrived != true && model.isOld(a, at: now)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(model.showNearby ? L("Departures near you") : (a?.isClassPlan == true ? a?.leaveHeadline(now: now) ?? big(a) : big(a)))
                                .font(.system(size: 20, weight: .bold, design: .rounded))
                                .foregroundStyle(old ? .secondary : .primary)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                            if old {
                                StatusLine(color: .gray, text: L("Old times · refreshing"))
                            } else if !model.showNearby, let a, a.isClassPlan, let at = a.leaveAt {
                                let left = Int(at.timeIntervalSince(now))
                                StatusLine(color: a.leaveLate ? .red : .brand, text: left <= 0 ? L("Time to go") : left >= 120 ? L("in %@ min", "\((left + 30) / 60)") : L("in %@ min %@ s", "\(left / 60)", "\(left % 60)"))
                            } else if !model.showNearby, !resting, let a, a.hasLiveTime, let at = a.departure {
                                StatusLine(color: dotColor(a.quality), text: countdown(to: at, now: now))
                            } else {
                                StatusLine(color: resting ? .brand : dotColor(model.showNearby ? nil : a?.quality), text: resting ? restStatus : a?.isFree == true ? L("Nothing to catch") : a?.arrived == true ? L("You're at the stop") : status(a))
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .rotationEffect(.degrees(model.loading && !reduceMotion ? 360 : 0))
                    .opacity(model.loading && reduceMotion ? 0.4 : 1)
                    .animation(model.loading && !reduceMotion ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default, value: model.loading)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.primary.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .help(L("Refresh"))
            .accessibilityLabel(model.loading ? L("Refreshing") : L("Refresh"))
        }
        .card()
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// "D2 · 09:42" when there's a live departure; otherwise the label.
    private func big(_ a: NextAnswer?) -> String {
        guard let a else { return L("Checking…") }
        guard a.hasLiveTime, let at = a.departure else { return a.label }
        // A timetable estimate is not a live time: mark it, as the widget does.
        return "\(a.service) · \(a.quality == "scheduled" ? L("~%@", campusTime(at)) : campusTime(at))"
    }

    private func countdown(to at: Date, now: Date) -> String {
        let left = Int(at.timeIntervalSince(now))
        if left <= 0 { return L("Leaving now") }
        return left >= 60 ? L("Leaves in %@ min %@ s", "\(left / 60)", "\(left % 60)") : L("Leaves in %@ s", "\(left)")
    }

    private var restStatus: String {
        let when = model.updated.map { " · \(campusTime($0))" } ?? ""
        return L("No buses until your day starts") + when
    }

    private func heading(_ a: NextAnswer?) -> String {
        if model.showNearby { return L("Nearby") }
        guard let a else { return L("Next bus") }
        if a.mode == "rest" { return L("Off hours") }
        if a.isFree { return L("Today") }
        // Under way: the phase leads ("On the bus · CS2030").
        if let p = a.card?.phaseText, let d = a.dest { return "\(p.components(separatedBy: CharacterSet(charactersIn: ":：")).first ?? p) · \(d.label)" }
        if a.mode == "nearby" { return L("Nearby") }
        guard let d = a.dest else { return L("Next bus") }
        if a.isClassPlan, let c = a.classAt { return "\(d.label) · \(L("starts %@", campusTime(c)))" }
        let why = switch d.why {
        case "class": L("Next class")
        case "gap-home": L("Long gap · home")
        case "home": L("Heading home")
        default: L("Going to")
        }
        return "\(why) · \(d.label)"
    }

    private func status(_ a: NextAnswer?) -> String {
        if let e = model.error { return e }
        let when = model.updated.map { " · \(campusTime($0))" } ?? ""
        if model.showNearby { return L("Updated") + when }
        switch a?.quality {
        case "live": return L("Live") + when
        case "scheduled": return L("Timetable estimate") + when
        case "stale": return L("Live data a few minutes old") + when
        case "ended": return L("Services ended") + when
        case "unknown": return L("No live data") + when
        default: return L("Loading")
        }
    }

    private func dotColor(_ q: String?) -> Color {
        if model.error != nil { return .red }
        switch q {
        case "live": return .green
        case "scheduled", "stale": return .orange
        case nil: return model.showNearby ? .green : .gray
        default: return .gray
        }
    }
}

struct IconTile: View {
    let system: String
    var tint: Color = .orange
    var body: some View {
        Image(systemName: system)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 42, height: 42)
            .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(tint.opacity(0.16)))
            .contentTransition(.symbolEffect(.replace))
            .accessibilityHidden(true)
    }
}

struct StatusLine: View {
    let color: Color
    let text: String
    var body: some View {
        HStack(spacing: 5) {
            // Colour repeats what the text says; VoiceOver gets the text.
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}
