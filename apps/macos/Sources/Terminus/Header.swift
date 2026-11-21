import SwiftUI

struct Header: View {
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let a = model.showNearby ? model.plan : model.shown
        let resting = !model.showNearby && a?.mode == "rest"
        let offline = !model.showNearby && model.target == .plan ? model.offlinePick(at: model.clock) : nil
        HStack(alignment: .center, spacing: 12) {
            IconTile(
                system: model.showNearby
                    ? "location.fill" : resting ? "moon.zzz.fill" : a?.arrived == true ? "checkmark.circle.fill" : "bus.fill",
                tint: .brand
            )
            Ticking(every: 1) { now in
                let l = lines(a, resting: resting, offline: offline, now: now)
                if a == nil && !model.showNearby && offline == nil && model.answerError == nil {
                    VStack(alignment: .leading, spacing: 3) {
                        SkeletonLine(font: .system(size: 12, weight: .medium), points: 120)
                        SkeletonLine(font: .system(size: 20, weight: .bold, design: .rounded), points: 170)
                        SkeletonLine(font: .caption, points: 90)
                    }
                    .shimmering()
                    .skeletonSpoken()
                } else {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(l.head)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(l.big)
                            .font(.system(size: 20, weight: .bold, design: .rounded))
                            .foregroundStyle(l.dimmed ? .secondary : .primary)
                            .lineLimit(2)
                            .minimumScaleFactor(0.8)
                        if let st = l.status { StatusLine(color: st.color, text: st.text) }
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spokenTimes([l.head, l.big, l.status?.spoken].compactMap { $0 }.joined(separator: L(", "))))
                    .accessibilityAddTraits([.isHeader, .updatesFrequently])
                }
            }
            Spacer(minLength: 0)
            Button {
                Task { await model.refresh() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 12, weight: .semibold))
                    .animation(model.loading && !reduceMotion ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default) {
                        $0.rotationEffect(.degrees(model.loading && !reduceMotion ? 360 : 0))
                    }
                    .opacity(model.loading && reduceMotion ? 0.4 : 1)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.primary.opacity(0.06)))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("r")
            .help(L("Refresh"))
            .accessibilityLabel(model.loading ? L("Refreshing") : L("Refresh"))
        }
        .card()
        .onChange(of: model.error) { _, e in announce(e) }
    }

    private struct Lines {
        var head: String
        var big: String
        var dimmed = false
        var status: (color: Color, text: String, spoken: String)?
    }

    private func lines(_ a: NextAnswer?, resting: Bool, offline: OfflineDay.Pick?, now: Date) -> Lines {
        let head = offline.map { OfflineDay.lines($0).head } ?? heading(a)
        if let p = offline.flatMap({ _ in model.offlinePick(at: now) }) {
            let text = L("Offline")
            return Lines(head: head, big: OfflineDay.lines(p).big, status: (.gray, text, text))
        }
        let old = !model.showNearby && !resting && a?.arrived != true && model.isOld(a, at: now)
        var out = Lines(
            head: head,
            big: model.showNearby ? L("Departures near you") : (a?.isClassPlan == true ? a?.leaveHeadline(now: now) ?? big(a) : big(a)),
            dimmed: old)
        let sure = { (s: String) in [s, model.showNearby ? nil : a?.card?.quality].compactMap { $0 }.joined(separator: " · ") }
        if old {
            let text = L("Updating times…")
            out.status = (.gray, text, text)
        } else if !model.showNearby, let a, a.isClassPlan, let at = a.countdownAt {
            if let left = Self.secondsLeft(to: at, now: now) {
                let spoken = left >= 60 ? L("in %@ min", "\((left + 30) / 60)") : L("in under a minute")
                out.status = (a.leaveLate ? .red : .brand, sure(Self.leaveIn(left)), sure(spoken))
            }
        } else if !model.showNearby, !resting, let a, a.hasLiveTime, let at = a.departure {
            let guess = a.card?.quality != nil
            out.status = (
                dotColor(a.quality), sure(Self.countdown(to: at, now: now, minutes: guess)),
                sure(Self.countdown(to: at, now: now, minutes: true))
            )
        } else if resting {
            out.status = (.brand, restStatus, restStatus)
        } else if let text = status(a) {
            out.status = (dotColor(model.showNearby ? nil : a?.quality), text, text)
        }
        return out
    }

    private func big(_ a: NextAnswer?) -> String {
        guard let a else { return L("Checking…") }
        return a.card?.title ?? a.label
    }

    nonisolated static func countdown(to at: Date, now: Date, minutes: Bool = false) -> String {
        guard let left = secondsLeft(to: at, now: now) else {
            return L("Left %@ min ago", "\(max(1, Int((now.timeIntervalSince(at) / 60).rounded(.up))))")
        }
        if minutes { return left >= 60 ? L("Leaves in %@ min", "\((left + 30) / 60)") : L("Leaves in under a minute") }
        return left >= 60 ? L("Leaves in %@ min %@ s", "\(left / 60)", "\(left % 60)") : L("Leaves in %@ s", "\(left)")
    }

    nonisolated static func secondsLeft(to at: Date, now: Date) -> Int? {
        let left = at.timeIntervalSince(now)
        return left > 0 ? max(1, Int(left)) : nil
    }

    nonisolated static func leaveIn(_ left: Int) -> String {
        if left >= 120 { return L("in %@ min", "\((left + 30) / 60)") }
        return left >= 60 ? L("in %@ min %@ s", "\(left / 60)", "\(left % 60)") : L("in %@ s", "\(left)")
    }

    private var restStatus: String { L("No buses until your day starts") + updatedAt }

    private var updatedAt: String { model.updated.map { " · \(campusTime($0))" } ?? "" }

    private func heading(_ a: NextAnswer?) -> String {
        if model.showNearby { return L("Nearby") }
        guard let a else { return L("Next bus") }
        if a.mode == "rest" { return L("Off hours") }
        if a.isFree { return L("Today") }
        if let p = a.card?.phaseText, let d = a.dest { return "\(p) · \(d.label)" }
        if let h = a.card?.heading { return h }
        if a.mode == "nearby" { return L("Nearby") }
        return L("Next bus")
    }

    private func status(_ a: NextAnswer?) -> String? {
        if a?.isFree == true { return L("Nothing to catch") }
        if a?.arrived == true { return L("You're there") }
        if let e = model.error { return e }
        let when = updatedAt
        if model.showNearby { return L("Updated") + when }
        return a?.card?.quality.map { $0 + when }
    }

    private func dotColor(_ q: String?) -> Color {
        Self.dotColor(q, error: model.error != nil, nearby: model.showNearby)
    }

    nonisolated static func dotColor(_ q: String?, error: Bool, nearby: Bool) -> Color {
        if error { return .red }
        switch q {
        case "live": return .green
        case "scheduled", "stale": return .orange
        case nil: return nearby ? .green : .gray
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
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }
}
