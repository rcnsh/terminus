import SwiftUI

extension NowShows {
    @MainActor static func of(_ app: AppModel, now: Date) -> NowShows {
        of(
            nearby: false, answer: app.answer, onPlan: app.target == .plan, paired: app.paired, error: app.error,
            loading: app.loading, day: app.day, now: now)
    }
}

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
            case .checking:
                NowSkeletonHead()
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

func spokenCard(_ a: NextAnswer, now: Date, withLead: Bool) -> String {
    var parts: [String] = []
    if withLead {
        for s in [a.card?.notice, a.card?.warning].compactMap({ $0 }) { parts.append(Spoken.sentences(s)) }
    }
    parts.append(Spoken.summary(a, now: now, withHead: withLead))
    if let c = Spoken.countdown(a, now: now) { parts.append(Spoken.sentences(c)) }
    return parts.joined(separator: " ")
}

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

func timingColor(_ status: String?, _ inks: Inks) -> Color {
    switch status {
    case "late": inks.late
    case "tight": inks.warn
    default: inks.good
    }
}

struct PlainCard: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let answer: NextAnswer
    let old: Bool
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let a = answer
        CardLead(answer: a, now: now)
        if let head = a.plainHeading { Text(head).foregroundStyle(inks.muted).accessibilityAddTraits(.isHeader) }
        VStack(alignment: .leading, spacing: 4) {
            Text(a.title)
                .font(.system(size: 30 * scale, weight: .bold))
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
                (!old && a.card?.ride == nil ? a.timing?.text : nil).map { ($0, timingColor(a.timing?.status, inks)) },
                a.crowdText.map { ($0, inks.muted) },
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

struct Countdown: View {
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        if let at = answer.departure {
            let left = Int(at.timeIntervalSince(now))
            Text(Self.words(left: left)).font(.subheadline.weight(.semibold)).foregroundStyle(left > 0 ? inks.smallAccent : inks.muted)
                .monospacedDigit()
        }
    }

    nonisolated static func words(left: Int) -> String { JourneyText.leaves(left: left) }
}

struct ClassPlan: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let a = answer
        if let at = a.leaveAt {
            let late = a.leaveLate
            Text([a.dest?.label, a.classAt.map(a.startsAt)].compactMap { $0 }.joined(separator: " · "))
                .foregroundStyle(inks.muted)
            Text(a.leaveHeadline(now: now) ?? "")
                .font(.system(size: 30 * scale, weight: .bold))
                .foregroundStyle(late ? inks.late : inks.ink)
            let left = a.phase == "waiting" ? 0 : Int(at.timeIntervalSince(now))
            if left > 0 {
                Text(JourneyText.inTime(left))
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

struct DayDoneHead: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let answer: NextAnswer
    @Environment(\.inks) private var inks

    var body: some View {
        let upcoming = answer.card?.upcoming
        let sub = answer.doneSub
        Text(answer.label)
            .font(.system(size: 44 * scale, weight: .heavy))
            .tracking(-1)
            .lineSpacing(-4)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("now.label")
        if let sub { Text(sub).font(.body).foregroundStyle(inks.muted).padding(.top, 4) }
        if let upcoming { UpcomingCard(upcoming: upcoming) }
    }
}

struct UpcomingCard: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let upcoming: Upcoming
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(upcoming.when, color: inks.smallAccent)
            Text(upcoming.title).font(.system(size: 22 * scale, weight: .bold)).padding(.top, 6)
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

struct NowGround: View {
    let shows: NowShows
    let now: Date
    @Environment(AppModel.self) private var app
    @Environment(Prefs.self) private var prefs

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch shows {
            case .checking:
                NowSkeletonGround()
            case .nearby, .waiting, .offline:
                EmptyView()
            case .dayDone(let a):
                DayDoneGround(answer: a)
                CardActions(answer: a)
            case .journey(let a, let j):
                JourneyGround(answer: a, journey: j, style: JourneyStyle.of(prefs.cardStyle), now: now)
                StepBus(answer: a)
                CardActions(answer: a)
            case .classPlan(let a):
                StepBus(answer: a)
                CardActions(answer: a)
            case .plain(let a, let old):
                if !old { StepBus(answer: a) }
                CardActions(answer: a)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

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

struct StepBus: View {
    let answer: NextAnswer
    @Environment(AppModel.self) private var app

    var body: some View {
        if let s = answer.card?.step {
            HStack(spacing: 8) {
                button("‹ \(s.earlierLabel)", spoken: s.earlierLabel, id: "step.earlier", enabled: s.earlier != nil) {
                    app.step(s, to: s.earlier, dir: "earlier")
                }
                if s.moved {
                    button(s.bestLabel, spoken: s.bestLabel, id: "step.best", enabled: true) { app.step(s, to: nil, dir: nil) }
                }
                button("\(s.laterLabel) ›", spoken: s.laterLabel, id: "step.later", enabled: s.later != nil) {
                    app.step(s, to: s.later, dir: "later")
                }
            }
            .disabled(app.signalling)
            .padding(.top, 14)
        }
    }

    private func button(_ label: String, spoken: String, id: String, enabled: Bool, action: @escaping () -> Void)
        -> some View
    {
        Button(action: action) {
            Text(label).lineLimit(1).minimumScaleFactor(0.75)
        }
        .buttonStyle(ChipButtonStyle(even: true))
        .disabled(!enabled)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(id)
    }
}

struct CardActions: View {
    let answer: NextAnswer
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL

    var body: some View {
        let busy = app.signalling
        let undoing = app.removed.flatMap { $0.failed ? nil : $0.item.key }
        let all = (answer.card?.actions ?? []).filter { !($0.id == "reset" && $0.trip == undoing) }
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
                        Text(L("Directions to %@", w.name)).lineLimit(2)
                    }
                    .buttonStyle(ChipButtonStyle(filled: true, wide: true))
                    .accessibilityIdentifier("directions")
                    if !skips.isEmpty {
                        SkipMenu(skips: skips, label: nil)
                    } else if let a = actions.first {
                        Button(a.label) { app.signal(a) }.buttonStyle(ChipButtonStyle()).disabled(busy)
                            .accessibilityIdentifier("action.\(a.id)")
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
                Image(systemName: "ellipsis").frame(width: 16, height: 48)
            }
        }
        .buttonStyle(ChipButtonStyle())
        .disabled(app.signalling)
        .accessibilityLabel(label ?? L("More options"))
        .accessibilityIdentifier("skips")
    }
}

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
