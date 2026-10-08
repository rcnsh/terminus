import SwiftUI

/// The hero: where you're going, the answer, and whether it's live.
struct Header: View {
    @Bindable var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            // Ticks every second: the countdown and the dimming are
            // computed from the departure time, never from `label`.
            Ticking(every: 1) { now in
                let l = lines(a, resting: resting, offline: offline, now: now)
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
                // One element, read as a sentence. Its words change once a
                // minute at most, so VoiceOver isn't fed a new second each tick.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenTimes([l.head, l.big, l.status?.spoken].compactMap { $0 }.joined(separator: L(", "))))
                .accessibilityAddTraits([.isHeader, .updatesFrequently])
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
            .keyboardShortcut("r")
            .help(L("Refresh"))
            .accessibilityLabel(model.loading ? L("Refreshing") : L("Refresh"))
        }
        .card()
        // The error shows on the status line, away from the focus: say it.
        .onChange(of: model.error) { _, e in announce(e) }
    }

    /// What the header says at `now`: the heading, the headline, and the
    /// status line with its dot and how it's spoken (to the minute).
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
        var out = Lines(head: head, big: model.showNearby ? L("Departures near you") : (a?.isClassPlan == true ? a?.leaveHeadline(now: now) ?? big(a) : big(a)), dimmed: old)
        // How sure the time is, worded on the server ("Timetable estimate"),
        // beside the countdown: the "~" alone is easy to miss.
        let sure = { (s: String) in [s, model.showNearby ? nil : a?.card?.quality].compactMap { $0 }.joined(separator: " · ") }
        if old {
            let text = L("Updating times…")
            out.status = (.gray, text, text)
        } else if !model.showNearby, let a, a.isClassPlan, let at = a.countdownAt {
            // Once it's time, the headline says "Leave now" and this line goes, as on the phone and the web.
            // At the stop the headline is the bus ("D2 at 09:41"): this counts to it, not the leave-by.
            if let left = Self.secondsLeft(to: at, now: now) {
                let spoken = left >= 60 ? L("in %@ min", "\((left + 30) / 60)") : L("in under a minute")
                out.status = (a.leaveLate ? .red : .brand, sure(Self.leaveIn(left)), sure(spoken))
            }
        } else if !model.showNearby, !resting, let a, a.hasLiveTime, let at = a.departure {
            // A guess counts down in minutes: its seconds would be false precision.
            let guess = a.card?.quality != nil
            out.status = (dotColor(a.quality), sure(Self.countdown(to: at, now: now, minutes: guess)), sure(Self.countdown(to: at, now: now, minutes: true)))
        } else if resting {
            out.status = (.brand, restStatus, restStatus)
        } else if let text = status(a) {
            out.status = (dotColor(model.showNearby ? nil : a?.quality), text, text)
        }
        return out
    }

    /// "D2 · 09:42", "A1 · ~09:11", or the label when there's no time: the
    /// card's title. An older server's answer, without one, is worded here.
    private func big(_ a: NextAnswer?) -> String {
        guard let a else { return L("Checking…") }
        if let title = a.card?.title { return title }
        guard a.hasLiveTime, let at = a.departure else { return a.label }
        // A timetable estimate is not a live time: mark it, as the widget does.
        return "\(a.service) · \(a.quality == "scheduled" ? L("~%@", campusTime(at)) : campusTime(at))"
    }

    /// "Leaves in 4 min 12 s", then "Left 1 min ago" until the answer is
    /// replaced or goes stale. To the minute ("Leaves in 4 min") when
    /// spoken, or for a guess.
    nonisolated static func countdown(to at: Date, now: Date, minutes: Bool = false) -> String {
        guard let left = secondsLeft(to: at, now: now) else {
            // Gone: a minute ago from the moment it left, never "0 min ago".
            return L("Left %@ min ago", "\(max(1, Int((now.timeIntervalSince(at) / 60).rounded(.up))))")
        }
        if minutes { return left >= 60 ? L("Leaves in %@ min", "\((left + 30) / 60)") : L("Leaves in under a minute") }
        return left >= 60 ? L("Leaves in %@ min %@ s", "\(left / 60)", "\(left % 60)") : L("Leaves in %@ s", "\(left)")
    }

    /// Whole seconds until `at`, at least 1 while it's still ahead (the last
    /// part of a second is "1 s", not "0 s"); nil once it has come, as the phone does.
    nonisolated static func secondsLeft(to at: Date, now: Date) -> Int? {
        let left = at.timeIntervalSince(now)
        return left > 0 ? max(1, Int(left)) : nil
    }

    /// The class's leave-by, beside the headline: "in 4 min" (rounded) from
    /// two minutes, then "in 1 min 5 s", then "in 45 s", as the phone counts down.
    nonisolated static func leaveIn(_ left: Int) -> String {
        if left >= 120 { return L("in %@ min", "\((left + 30) / 60)") }
        return left >= 60 ? L("in %@ min %@ s", "\(left / 60)", "\(left % 60)") : L("in %@ s", "\(left)")
    }

    private var restStatus: String { L("No buses until your day starts") + updatedAt }

    /// " · 09:24", when the last refresh came; nothing before one has.
    private var updatedAt: String { model.updated.map { " · \(campusTime($0))" } ?? "" }

    /// The card's heading ("Next class · GEA1000 @ UTown"), led by the phase
    /// on a trip under way ("On the bus · GEA1000 @ UTown"). Without one (a
    /// rest or free day, nowhere to go), what this view is.
    private func heading(_ a: NextAnswer?) -> String {
        if model.showNearby { return L("Nearby") }
        guard let a else { return L("Next bus") }
        if a.mode == "rest" { return L("Off hours") }
        if a.isFree { return L("Today") }
        // Under way: the phase leads ("On the bus · CS2030").
        if let p = a.card?.phaseText, let d = a.dest { return "\(p) · \(d.label)" }
        if let h = a.card?.heading { return h }
        if a.mode == "nearby" { return L("Nearby") }
        // A card with no heading has nowhere to go; the rest is for an older server's answer.
        if a.card != nil { return L("Next bus") }
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

    /// The error, or how sure the answer is, worded on the server (`card.quality`:
    /// "Timetable estimate", none for live times); nil for no line at all.
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

    /// The status line's dot: green only for live times; a quality this
    /// version doesn't know is grey, never called live.
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
            // Colour repeats what the text says; VoiceOver gets the text.
            Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true)
            Text(text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
    }
}
