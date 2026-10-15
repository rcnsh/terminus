import SwiftUI

/// What Now shows under the chips, worked out once a second from the
/// model: its top goes up in the sky ([NowHead]), the rest on the ground
/// under the horizon ([NowGround]).
enum NowShows {
    case nearby
    /// No answer yet: "Checking…", or "No answer yet".
    case waiting(String)
    /// Offline with the plan's answer stale: the next thing on the kept day plan.
    case offline(OfflineDay.Lines)
    /// Nothing to catch: the day's done, a free day, or you're there.
    case dayDone(NextAnswer)
    /// A trip by bus or on foot, in the card style chosen in Settings.
    case journey(NextAnswer, Journey)
    case classPlan(NextAnswer)
    /// Anything else, or a card past its staleAt (`old`), its times dimmed.
    case plain(NextAnswer, old: Bool)

    @MainActor static func of(_ app: AppModel, now: Date) -> NowShows {
        if app.showNearby { return .nearby }
        let a = app.answer
        // The last refresh failed: the day plan kept for it stands in for a stale answer.
        if app.target == .plan, app.paired, app.error != nil, !app.loading, a == nil || a!.isOld(at: now),
            let pick = OfflineDay.next(app.day, now: now)
        {
            return .offline(OfflineDay.lines(pick))
        }
        guard let a else { return .waiting(app.loading || app.error == nil ? L("Checking…") : L("No answer yet")) }
        if a.mode == "rest" || a.isFree || a.arrived { return .dayDone(a) }
        let old = a.isOld(at: now)
        if let j = a.card?.journey, !old { return .journey(a, j) }
        if a.isClassPlan && !old { return .classPlan(a) }
        return .plain(a, old: old)
    }

    /// The room above the words, for the stars and the moon at night.
    var room: CGFloat {
        switch self {
        case .nearby: 26
        case .dayDone: 72
        default: 34
        }
    }

    /// What's on the horizon's road.
    func road(now: Date) -> Road {
        if case .journey(_, let j) = self { return Road.of(j, now: now) }
        return Road()
    }
    var road: Road { road(now: ServerClock.now) }
}

// MARK: the top, in the sky

struct NowHead: View {
    let shows: NowShows
    let now: Date
    @Environment(\.inks) private var inks
    @Environment(Prefs.self) private var prefs

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch shows {
            case .nearby:
                EmptyView()
            case .waiting(let text):
                Text(text).font(.title2.weight(.semibold)).accessibilityIdentifier("now.waiting")
            case .offline(let lines):
                OfflinePlan(lines: lines)
            case .dayDone(let a):
                DayDoneHead(answer: a)
            case .journey(let a, let j):
                VStack(alignment: .leading, spacing: 4) {
                    CardLead(answer: a, now: now)
                    JourneyTop(answer: a, journey: j, style: JourneyStyle.of(prefs.cardStyle), now: now)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenCard(a, now: now, withLead: true))
                .accessibilityIdentifier("now.card")
            case .classPlan(let a):
                VStack(alignment: .leading, spacing: 4) {
                    CardLead(answer: a, now: now)
                    ClassPlan(answer: a, now: now)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenCard(a, now: now, withLead: true))
                .accessibilityIdentifier("now.card")
            case .plain(let a, let old):
                PlainCard(answer: a, old: old, now: now)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAction(named: L("Refresh")) { Task { await AppModel.shared.load(restart: true) } }
    }
}

/// The card as VoiceOver says it: the server's words as sentences, then how
/// long until it's time to go, to the minute.
func spokenCard(_ a: NextAnswer, now: Date, withLead: Bool) -> String {
    var parts: [String] = []
    if withLead {
        for s in [a.card?.notice, a.card?.warning].compactMap({ $0 }) { parts.append(Spoken.sentences(s)) }
    }
    parts.append(Spoken.summary(a, now: now, withHead: withLead))
    if let c = Spoken.countdown(a, now: now) { parts.append(Spoken.sentences(c)) }
    return parts.joined(separator: " ")
}

/// What comes before any answer: NUS's live times being down, where the
/// trip is, the ride's progress on the bus, and a warning.
struct CardLead: View {
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        if let notice = answer.card?.notice { ToneText(text: notice, color: inks.warn).font(.footnote) }
        if let phase = answer.card?.phaseText { SkyPill(text: phase, color: inks.smallAccent) }
        if answer.phase == "riding", let ride = answer.card?.ride { RideProgress(ride: ride, now: now) }
        if let warning = answer.card?.warning { ToneText(text: warning, color: inks.warn).font(.subheadline.weight(.semibold)) }
    }
}

/// Words in a colour of their own; in the sky, on its chip, so they read over any hour.
struct ToneText: View {
    let text: String
    let color: Color
    @Environment(\.inks) private var inks

    var body: some View {
        if let chip = inks.chip {
            Text(text).foregroundStyle(color)
                .padding(.horizontal, 10).padding(.vertical, 4)
                .background(chip, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        } else {
            Text(text).foregroundStyle(color)
        }
    }
}

/// A pill whose tint, in the sky, sits on the sky's chip so it reads over any hour.
struct SkyPill: View {
    let text: String
    let color: Color
    @Environment(\.inks) private var inks

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(inks.chip ?? color.opacity(0.12), in: Capsule())
    }
}

/// On the bus: a bar from boarding to getting off, and "Next: Opp NUSS · 3
/// stops to go"; on a trip that changes, the second bus under it.
struct RideProgress: View {
    let ride: Ride
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ProgressView(value: ride.progress(at: now))
                .tint(inks.accent)
                .padding(.top, 8)
            Text(ride.nextText(at: now, withChange: false)).font(.subheadline)
            if let change = ride.change { Text(change.text).font(.subheadline).foregroundStyle(inks.muted) }
        }
        .padding(.bottom, 4)
    }
}

/// "On time" in green, "tight" in amber (the one that must not look calm), late in red.
func timingColor(_ status: String?, _ inks: Inks) -> Color {
    switch status {
    case "late": inks.late
    case "tight": inks.warn
    default: inks.good
    }
}

/// The plain card: where to, the bus and its time, the countdown, the detail
/// and when to leave. Past its staleAt the times are dimmed and "Updating
/// times…" stands in until the refresh lands.
struct PlainCard: View {
    let answer: NextAnswer
    let old: Bool
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let a = answer
        CardLead(answer: a, now: now)
        // The server's ("Going to KR MRT", "Long gap · Home").
        let head =
            a.card?.heading
            ?? (a.mode == "nearby" ? L("Nearby") : a.dest?.why == "gap-home" ? L("%@ · long gap", a.dest?.label ?? "") : a.dest?.label)
        if let head { Text(head).foregroundStyle(inks.muted).accessibilityAddTraits(.isHeader) }
        VStack(alignment: .leading, spacing: 4) {
            Text(a.title)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(old ? inks.muted : inks.ink)
            if old {
                Text(L("Updating times…")).foregroundStyle(inks.muted)
            } else {
                Countdown(answer: a, now: now)
                if !a.detail.isEmpty { Text(a.detail) }
                if let leave = a.leaveText(now: now) {
                    Text(leave).font(.headline).padding(.top, 4)
                }
            }
            let pills = [
                (!old ? a.timing?.text : nil).map { ($0, timingColor(a.timing?.status, inks)) }, a.crowdText.map { ($0, inks.muted) },
            ].compactMap { $0 }
            if !pills.isEmpty {
                HStack(spacing: 6) { ForEach(pills, id: \.0) { SkyPill(text: $0.0, color: $0.1) } }.padding(.top, 4)
            }
            if let q = a.qualityText { Text(q).font(.footnote).foregroundStyle(inks.muted) }
        }
        .accessibilityElement(children: old ? .contain : .ignore)
        .accessibilityLabel(old ? "" : spokenCard(a, now: now, withLead: false))
        .accessibilityIdentifier("now.card")
    }
}

/// Ticks from `departsAt`, so the app never shows an old "4 min".
struct Countdown: View {
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        if let at = answer.departure {
            let left = Int(at.timeIntervalSince(now))
            let text =
                left > 60
                ? L("Leaves in %@ min %@ s", "\(left / 60)", "\(left % 60)")
                : left > 0
                    ? L("Leaves in %@ s", "\(left)")
                    : L("Left %@ min ago", "\((-left + 59) / 60)")
            Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(left > 0 ? inks.smallAccent : inks.muted).monospacedDigit()
        }
    }
}

/// A class: when to leave is the headline, the bus that goes with it and
/// when it gets you there underneath, and the next bus as the "or go now"
/// option. Every arrival sits next to the bus it belongs to.
struct ClassPlan: View {
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let a = answer
        if let at = a.leaveAt {
            let late = a.leaveLate
            Text([a.dest?.label, a.classAt.map { L("starts %@", campusTime($0)) }].compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(inks.muted)
            Text(a.leaveHeadline(now: now) ?? "")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(late ? inks.late : inks.ink)
            // Counting down to leaving; at the stop the headline is the bus and its time.
            let left = a.phase == "waiting" ? 0 : Int(at.timeIntervalSince(now))
            if left > 0 {
                Text(left >= 120 ? L("in %@ min", "\((left + 30) / 60)") : L("in %@ min %@ s", "\(left / 60)", "\(left % 60)"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(inks.smallAccent)
                    .monospacedDigit()
            }
            if let how = a.card?.catch {
                Text(how).font(.body.weight(.semibold)).foregroundStyle(late ? inks.late : inks.ink).padding(.top, 4)
            }
            if let arrive = a.card?.arrive { Text(arrive).font(.subheadline).foregroundStyle(late ? inks.late : inks.muted) }
            let small = [a.leaveNote, a.card?.estimate].compactMap { $0 }
            if !small.isEmpty { Text(small.joined(separator: " ")).font(.footnote).foregroundStyle(inks.muted).padding(.top, 4) }
            if let goNow = a.card?.goNow {
                Rectangle().fill(inks.line).frame(height: 1).padding(.vertical, 8)
                Text(goNow).font(.subheadline).foregroundStyle(inks.muted)
            }
            if let q = a.qualityText { Text(q).font(.footnote).foregroundStyle(inks.muted).padding(.top, 6) }
        }
    }
}

/// Offline, the next thing on the day plan kept for it, on glass in the sky.
struct OfflinePlan: View {
    let lines: OfflineDay.Lines
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(L("Offline")) · \(lines.head)").font(.subheadline.weight(.semibold)).foregroundStyle(inks.muted)
            Text(lines.big).font(.title2.weight(.bold))
            if let how = lines.how { Text(how) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .topLeading)
        .background(inks.pane, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(inks.line))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("now.offline")
    }
}

/// The day's done, or there's nothing to catch: the label large, and what's next on a card of its own.
struct DayDoneHead: View {
    let answer: NextAnswer
    @Environment(\.inks) private var inks

    var body: some View {
        let upcoming = answer.card?.upcoming
        let sub = upcoming?.off ?? (upcoming == nil && !answer.detail.isEmpty ? answer.detail : nil)
        Text(answer.label)
            .font(.system(size: 44, weight: .heavy))
            .tracking(-1)
            .lineSpacing(-4)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("now.label")
        if let sub { Text(sub).font(.body).foregroundStyle(inks.muted).padding(.top, 4) }
        if let upcoming { UpcomingCard(upcoming: upcoming) }
    }
}

/// The next class on a card of its own: when in the accent, what, then where. Glass over the sky.
struct UpcomingCard: View {
    let upcoming: Upcoming
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(upcoming.when, color: inks.smallAccent)
            Text(upcoming.title).font(.system(size: 22, weight: .bold)).padding(.top, 6)
            if !upcoming.where.isEmpty { Text(upcoming.where).font(.subheadline).foregroundStyle(inks.muted).padding(.top, 4) }
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(inks.pane, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(inks.line))
        .padding(.top, 18)
        .accessibilityElement(children: .combine)
    }
}

// MARK: the rest, on the ground

struct NowGround: View {
    let shows: NowShows
    let now: Date
    @Environment(AppModel.self) private var app
    @Environment(Prefs.self) private var prefs

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch shows {
            case .nearby:
                NearbyList()
            case .waiting, .offline:
                EmptyView()
            case .dayDone(let a):
                DayDoneGround(answer: a)
                CardActions(answer: a)
            case .journey(let a, let j):
                JourneyGround(answer: a, journey: j, style: JourneyStyle.of(prefs.cardStyle), now: now)
                CardActions(answer: a)
            case .classPlan(let a), .plain(let a, _):
                CardActions(answer: a)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Under a day that's done: your favourites to plan a trip to instead, or where to look.
struct DayDoneGround: View {
    let answer: NextAnswer
    @Environment(AppModel.self) private var app

    var body: some View {
        if answer.places.isEmpty {
            Text(
                answer.mode == "rest"
                    ? L("No buses are shown until your day starts. Tap Nearby to check anyway.") : L("Tap Nearby for buses around you.")
            )
            .font(.footnote)
            .foregroundStyle(Color.muted)
            .padding(.top, 4)
        } else {
            SectionLabel(L("Going somewhere anyway?"))
                .padding(.top, 4)
                .padding(.bottom, 10)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8, alignment: .top), count: 3), spacing: 8) {
                ForEach(answer.places, id: \.key) { p in
                    Button {
                        app.select(.place(key: p.key))
                    } label: {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(p.label).font(.subheadline.weight(.bold)).lineLimit(2).multilineTextAlignment(.leading)
                            Spacer(minLength: 18)
                            Text(L("Plan a trip")).font(.caption).foregroundStyle(Color.muted)
                        }
                        .foregroundStyle(Color.ink)
                        .padding(14)
                        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                        .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
                        .contentShape(RoundedRectangle(cornerRadius: 18))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(p.label), \(L("Plan a trip"))")
                }
            }
        }
    }
}

/// The server's buttons (plans only: "Not going", "Not on campus today",
/// "Back on campus", undo), in its order: the first one filled, the rest
/// outlined. Directions to the stop when there's one to walk to. Then
/// anything terminus has to suggest.
struct CardActions: View {
    let answer: NextAnswer
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL

    var body: some View {
        let busy = app.signalling
        // Undo once: on Today's row while it's there for this trip, not on the card as well.
        let undoing = app.removed.flatMap { $0.failed ? nil : $0.item.key }
        let all = (answer.card?.actions ?? []).filter { !($0.id == "reset" && $0.trip == undoing) }
        // "Not going" and "Not on campus today" are the same no, for this
        // class and for the whole day: with both, they share one menu.
        let both = all.filter { $0.id == "skipped" || $0.id == "away" }
        let skips = both.count > 1 ? both : []
        let actions = all.filter { a in !skips.contains(a) }
        let walkTo = answer.card?.walkTo
        VStack(alignment: .leading, spacing: 8) {
            if let w = walkTo {
                HStack(spacing: 8) {
                    Button {
                        if let u = w.mapsURL { openURL(u) }
                    } label: {
                        Label(L("Directions to %@", w.name), systemImage: "figure.walk").lineLimit(2)
                    }
                    .buttonStyle(ChipButtonStyle(filled: true))
                    .accessibilityIdentifier("directions")
                    if !skips.isEmpty {
                        SkipMenu(skips: skips, label: nil)
                    } else if let a = actions.first {
                        Button(a.label) { app.signal(a) }.buttonStyle(ChipButtonStyle()).disabled(busy)
                    }
                }
                .padding(.top, 14)
            }
            let rest = walkTo != nil && skips.isEmpty ? Array(actions.dropFirst()) : actions
            let skipButton = walkTo == nil && !skips.isEmpty
            if !rest.isEmpty || skipButton {
                FlowLayout(spacing: 8) {
                    ForEach(Array(rest.enumerated()), id: \.element) { i, a in
                        Button(a.label) { app.signal(a) }
                            .buttonStyle(ChipButtonStyle(filled: i == 0 && walkTo == nil && a.id != "skipped" && a.id != "reset"))
                            .disabled(busy)
                            .accessibilityIdentifier("action.\(a.id)")
                    }
                    if skipButton { SkipMenu(skips: skips, label: skips[0].label) }
                }
                .padding(.top, walkTo != nil ? 0 : 12)
            }
            if let s = answer.card?.suggestion {
                VStack(alignment: .leading, spacing: 8) {
                    Text(s.text).font(.subheadline)
                    FlowLayout(spacing: 8) {
                        Button(s.accept) { app.choose(s, accept: true) }.buttonStyle(ChipButtonStyle(filled: true)).disabled(busy)
                        Button(s.dismiss) { app.choose(s, accept: false) }.buttonStyle(ChipButtonStyle()).disabled(busy)
                    }
                }
                .cardStyle(padding: 14, radius: 16)
                .padding(.top, 14)
            }
        }
    }
}

/// The skips behind one button: ⋯ beside directions, or `label` on its own.
/// Each choice says underneath how much it skips.
struct SkipMenu: View {
    let skips: [CardAction]
    let label: String?
    @Environment(AppModel.self) private var app

    var body: some View {
        Menu {
            ForEach(skips, id: \.self) { a in
                Button {
                    app.signal(a)
                } label: {
                    Text(a.label)
                    if let hint = a.id == "skipped" ? L("Skip this class") : a.id == "away" ? L("Skip every trip left today") : nil {
                        Text(hint)
                    }
                }
            }
        } label: {
            if let label {
                Text(label)
            } else {
                Image(systemName: "ellipsis").frame(width: 16)
            }
        }
        .buttonStyle(ChipButtonStyle())
        .disabled(app.signalling)
        .accessibilityLabel(label ?? L("More options"))
        .accessibilityIdentifier("skips")
    }
}

/// Buttons in a row, wrapping onto the next when they don't fit.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let width = rows.map { r in r.reduce(0) { $0 + $1.width } + spacing * CGFloat(max(0, r.count - 1)) }.max() ?? 0
        let height = rows.map { $0.map(\.height).max() ?? 0 }.reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: min(width, proposal.width ?? width), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        var i = 0
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            let h = row.map(\.height).max() ?? 0
            for size in row {
                subviews[i].place(at: CGPoint(x: x, y: y + (h - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
                i += 1
            }
            y += h + spacing
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [[CGSize]] {
        var rows: [[CGSize]] = [[]]
        var x: CGFloat = 0
        for v in subviews {
            var s = v.sizeThatFits(.unspecified)
            s.width = min(s.width, width)
            if x > 0 && x + s.width > width {
                rows.append([])
                x = 0
            }
            rows[rows.count - 1].append(s)
            x += s.width + spacing
        }
        return rows
    }
}
