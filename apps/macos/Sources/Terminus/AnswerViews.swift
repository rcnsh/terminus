import SwiftUI

// MARK: - Content

struct AnswerDetail: View {
    let answer: NextAnswer?
    var busy = false
    /// Today's entry just taken off, whose row has Undo: the card doesn't offer it as well.
    var undoShownFor: String? = nil
    var onAction: (CardAction) -> Void = { _ in }
    var onChoice: (Suggestion, Bool) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = answer {
                if let n = a.card?.notice { Row(icon: "antenna.radiowaves.left.and.right.slash", text: n).foregroundStyle(Color.warn) }
                if let w = a.card?.warning { Row(icon: "exclamationmark.triangle.fill", text: w).fontWeight(.semibold).foregroundStyle(Color.warn) }
                // On the bus: how far along, from the stop you got on at to the one you get off at.
                if let ride = a.card?.ride { RideLine(ride: ride, color: a.card?.journey?.bus?.color) }
                if a.isFree {
                    // Nothing to catch: no bus to mistake for advice.
                    NextClass(answer: a)
                    Row(icon: "location", text: L("Buses near you are under Nearby.")).foregroundStyle(.secondary)
                } else if a.isClassPlan {
                    // Each arrival next to the bus it belongs to.
                    // The bus to catch (it names the stop), then when it gets you there.
                    // One colour for "go" (the countdown in the header); red only when it's late.
                    if let c = a.catchHow { Row(icon: a.leave?.svc == nil ? "figure.walk" : "bus.fill", text: c).fontWeight(.semibold).foregroundStyle(a.leaveLate ? Color.red : Color.primary) }
                    if let arrive = a.catchArrive { Row(icon: "flag.checkered", text: arrive).foregroundStyle(a.leaveLate ? Color.red : Color.secondary) }
                    if let note = a.card?.note { Row(icon: "person.3.fill", text: note).foregroundStyle(.secondary) }
                    if let e = a.card?.estimate { Row(icon: "info.circle", text: e).foregroundStyle(.secondary) }
                    if let g = a.goNowLine { Row(icon: "bus", text: g).foregroundStyle(.secondary) }
                } else if a.card?.upcoming != nil {
                    // After your day, or at home: what's next.
                    NextClass(answer: a)
                } else if let j = a.card?.journey {
                    // The trip as steps, as the phone and the web show them.
                    JourneyRows(journey: j)
                } else {
                    Row(icon: a.mode == "rest" ? "calendar" : "text.alignleft", text: a.detail)
                    if let leave = a.leaveText() { Row(icon: "figure.walk", text: leave).fontWeight(.semibold) }
                }
                // On a ride, the detail already says when you get there, with
                // its "~" on an estimate; the timing pill would say it again.
                let timing = a.card?.ride == nil ? a.timing?.text : nil
                if !a.isClassPlan, !a.isFree, timing != nil || a.crowdText != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = timing { Pill(text: text, color: t.status == "late" ? .red : t.status == "tight" ? .warn : .good) }
                        if let c = a.crowdText { Pill(text: c, color: .secondary) }
                    }
                }
                // The server's buttons (plans only: Not going, Not on campus today, undo), the first one prominent.
                if let actions = a.card?.actions?.filter({ !($0.id == "reset" && $0.trip == undoShownFor && undoShownFor != nil) }), !actions.isEmpty {
                    Flow(spacing: 6) {
                        ForEach(Array(Self.grouped(actions).enumerated()), id: \.offset) { i, group in
                            if group.count > 1 {
                                SkipMenu(skips: group, onAction: onAction)
                            } else if let action = group.first {
                                if i == 0 && action.id != "skipped" && action.id != "reset" {
                                    Button(action.label) { onAction(action) }.buttonStyle(.borderedProminent).controlSize(.small)
                                } else {
                                    Button(action.label) { onAction(action) }.buttonStyle(.bordered).controlSize(.small)
                                }
                            }
                        }
                    }
                    .disabled(busy)
                    .padding(.top, 2)
                }
                if let s = a.card?.suggestion {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(s.text).font(.callout).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            Button(s.accept) { onChoice(s, true) }.buttonStyle(.borderedProminent).controlSize(.small)
                            Button(s.dismiss) { onChoice(s, false) }.buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                    .disabled(busy)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("Checking…")).foregroundStyle(.secondary)
                }
            }
        }
        // Fill the area's fixed height (120 with the card's padding), so a
        // short answer centres in the card instead of leaving a gap under it.
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .card()
    }

    /// The card's buttons, one to a group, except "Not going" and "Not on
    /// campus today": the same no, for this class and for the whole day, so
    /// with both they share one menu where the first of them was (as on Android).
    nonisolated static func grouped(_ actions: [CardAction]) -> [[CardAction]] {
        let isSkip = { (a: CardAction) in a.id == "skipped" || a.id == "away" }
        let skips = actions.filter(isSkip)
        guard skips.count > 1 else { return actions.map { [$0] } }
        var groups: [[CardAction]] = []
        for a in actions {
            if !isSkip(a) { groups.append([a]) } else if a == skips[0] { groups.append(skips) }
        }
        return groups
    }

    /// "Not going ▾": each choice says underneath how much it skips.
    private struct SkipMenu: View {
        let skips: [CardAction]
        let onAction: (CardAction) -> Void

        var body: some View {
            Menu {
                ForEach(skips, id: \.self) { s in
                    Button { onAction(s) } label: {
                        Text(s.label)
                        Text(s.id == "skipped" ? L("Skip this class") : L("Skip every trip left today"))
                    }
                }
            } label: {
                Text(skips[0].label)
            }
            .menuStyle(.button)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        }
    }

    /// The next class on a block of its own (`card.upcoming`): when in the
    /// accent, what, then where, as the web and Android show it. Why today has
    /// none on a break goes above it. An older server's one line otherwise.
    private struct NextClass: View {
        let answer: NextAnswer

        var body: some View {
            if let u = answer.card?.upcoming {
                if let off = u.off { Row(icon: "calendar", text: off) }
                HStack(alignment: .top, spacing: 10) {
                    Capsule().fill(Color.brand).frame(width: 3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(u.when).font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.brand)
                        Text(u.title).font(.callout.weight(.semibold))
                        Label(u.where, systemImage: "mappin.and.ellipse")
                            .labelStyle(Tight())
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                // The bar as tall as the words, not the card.
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            } else {
                Row(icon: "calendar", text: answer.detail)
            }
        }

        /// An icon a few points from its words, the way Row sets them.
        private struct Tight: LabelStyle {
            func makeBody(configuration: Configuration) -> some View {
                HStack(alignment: .firstTextBaseline, spacing: 4) { configuration.icon.font(.system(size: 10)); configuration.title }
            }
        }
    }

    /// The journey's title, then a row a step: the walk (and by when), the
    /// ride, the walk at the end, getting there, and the bus to fall back on.
    /// Every word is the server's.
    struct JourneyRows: View {
        let journey: NextAnswer.Journey

        var body: some View {
            let j = journey
            Text(j.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if let walk = j.walkText { Row(icon: "figure.walk", text: [walk, j.byText].compactMap { $0 }.joined(separator: " · ")) }
            if let ride = j.rideText { Row(icon: "bus.fill", text: [j.bus?.svc, ride].compactMap { $0 }.joined(separator: " · ")).fontWeight(.semibold) }
            if let end = j.walkEndText { Row(icon: "figure.walk", text: end) }
            if let arrive = j.arriveText { Row(icon: "flag.checkered", text: [arrive, j.arriveWhere].compactMap { $0 }.joined(separator: " · ")) }
            if let backup = j.backupText { Row(icon: "bus", text: backup).foregroundStyle(.secondary) }
        }
    }

    /// The ride as a line of its stops, the passed ones filled, with the bus
    /// where the clock puts it (stops evenly spaced between the board and
    /// arrival times, as the phone and the web take them). Boarding stop on
    /// the left, the one to get off at on the right, the next one under the bus.
    struct RideLine: View {
        let ride: NextAnswer.Ride
        var color: String?

        var body: some View {
            Ticking(every: 5) { now in
                let hops = ride.stops.count - 1
                let done = ride.progress(at: now)
                let passed = ride.passed(at: now)
                let tint = color.flatMap(Color.init(hex:)) ?? .brand
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        let w = g.size.width - 8
                        ZStack(alignment: .leading) {
                            Capsule().fill(.primary.opacity(0.12)).frame(height: 3).padding(.horizontal, 4)
                            Capsule().fill(tint).frame(width: max(0, w * done), height: 3).padding(.leading, 4)
                            ForEach(0...hops, id: \.self) { i in
                                Circle()
                                    .fill(i <= passed ? tint : Color.secondary.opacity(0.35))
                                    .frame(width: 6, height: 6)
                                    .offset(x: w * Double(i) / Double(max(1, hops)) + 1)
                            }
                            Image(systemName: "bus.fill")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(inkOn(color ?? "#000000"))
                                .frame(width: 16, height: 16)
                                .background(Circle().fill(tint))
                                .offset(x: w * done - 4)
                        }
                    }
                    .frame(height: 16)
                    HStack(spacing: 6) {
                        Text(ride.stops[0].name)
                        Spacer(minLength: 4)
                        if passed + 1 < hops { Text(ride.stops[passed + 1].name).fontWeight(.semibold) }
                        Spacer(minLength: 4)
                        Text(ride.stops[hops].name).fontWeight(.semibold)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L("Ride progress"))
                .accessibilityValue(ride.stops.map(\.name).joined(separator: ", "))
            }
        }
    }

    private struct Row: View {
        let icon: String
        let text: String
        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: icon).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 14)
                Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.14)))
    }
}

struct NearbyList: View {
    let stops: [NearbyStop]?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let all = stops {
                ForEach(all) { s in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(s.stop.name).font(.system(size: 13, weight: .semibold))
                            Spacer()
                            Text(s.walkS < 60 ? L("You're here") : L("%@ min walk", "\((s.walkS + 30) / 60)"))
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        if s.board.isEmpty || !s.available {
                            Text(s.available ? L("Nothing due") : L("No live data")).font(.caption).foregroundStyle(.secondary)
                        } else {
                            FlowPills(rows: s.board)
                        }
                    }
                    .card(padding: 10)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("Checking…")).foregroundStyle(.secondary)
                }
                .card()
            }
        }
    }
}

/// One pill per service: "D2  4 min · 14 min", the next bus solid and the
/// ones after it faded, as on the web and Android. The times are the
/// server's words ("~6 min" for a timetable guess).
/// Wraps onto more lines instead of squeezing when a stop has many services.
struct FlowPills: View {
    let rows: [BoardRow]
    /// At most this many after the next one: a pill, not a timetable.
    nonisolated static let laterShown = 2

    var body: some View {
        Flow(spacing: 6) {
            ForEach(rows, id: \.self) { r in
                HStack(spacing: 5) {
                    // In the service's colour, as on the buses and the map. A
                    // public bus carries a $ so the fare is never a surprise.
                    let name = r.paid == true ? "\(r.svc) $" : r.svc
                    if let c = r.color.flatMap(Color.init(hex:)) {
                        Text(name).font(.system(size: 11, weight: .bold)).foregroundStyle(inkOn(r.color ?? ""))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(c))
                    } else {
                        Text(name).font(.system(size: 11, weight: .bold))
                    }
                    let later = Self.later(r)
                    (Text(Self.eta(r)).foregroundColor(.secondary)
                        + Text(later.isEmpty ? "" : " · " + later.joined(separator: " · ")).foregroundColor(Color.secondary.opacity(0.55)))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .contentTransition(.numericText())
                }
                .fixedSize()
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(.primary.opacity(0.07)))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Self.spoken(r))
            }
        }
    }

    /// The server's "4 min"; worded here only for an older server's row.
    nonisolated static func eta(_ r: BoardRow) -> String { r.eta ?? eta(etaS: r.etaS, quality: r.quality) }

    /// An older server's row: "4m", "~6m" for a timetable guess, "now", or
    /// "ended". Spoken, "4 min": VoiceOver reads "4m" as metres.
    nonisolated static func eta(etaS: Int?, quality: String, spoken: Bool = false) -> String {
        guard let s = etaS else { return quality == "ended" ? L("ended") : "–" }
        if s < 45 { return L("now") }
        let n = "\((s + 30) / 60)"
        let m = spoken ? L("%@ min", n) : L("%@m", n)
        return quality == "scheduled" ? L("~%@", m) : m
    }

    nonisolated static func later(_ r: BoardRow, spoken: Bool = false) -> [String] {
        (r.later ?? []).filter { $0.etaS != nil || $0.eta != nil }.prefix(laterShown).map { $0.eta ?? eta(etaS: $0.etaS, quality: $0.quality, spoken: spoken) }
    }

    /// "D2, public bus, fare applies: 4 min, 14 min", with Chinese punctuation in Chinese.
    nonisolated static func spoken(_ r: BoardRow) -> String {
        let who = r.paid == true ? r.svc + L(", ") + L("Public bus, fare applies") : r.svc
        let times = [r.eta ?? eta(etaS: r.etaS, quality: r.quality, spoken: true)] + later(r, spoken: true)
        return L("%@: %@", who, times.joined(separator: L(", ")))
    }
}

/// Today, from /me/day: each class with when to leave (or the bus you're
/// on), and the trips home. What's done is dimmed, a skipped class struck through.
struct TodayList: View {
    let day: DayPlan
    var removed: DayPlan.Item? = nil
    /// Where `removed` was: above the entry that followed it (nil at the end),
    /// or at `removedAt` should that one go too. Its row stays there, so nothing moves.
    var removedAt = 0
    var removedBefore: String? = nil
    /// An entry the server wouldn't take off, back in its place, and why.
    var failed: (key: String, message: String)? = nil
    var onRemove: (DayPlan.Item) -> Void = { _ in }
    var onUndo: () -> Void = {}

    var body: some View {
        let at = removedBefore.map { k in day.items.firstIndex { $0.key == k } ?? min(removedAt, day.items.count) } ?? day.items.count
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: L("Today"))
            ForEach(Array(day.items.enumerated()), id: \.element.id) { i, item in
                if i == at, let r = removed { RemovedRow(item: r, onUndo: onUndo) }
                TodayRow(item: item, onRemove: onRemove)
                if let f = failed, f.key == item.key {
                    Label(f.message, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.leading, 68)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if at == day.items.count, let r = removed { RemovedRow(item: r, onUndo: onUndo) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Where an entry was just taken off: "GEA1000 removed from today", with Undo for a few seconds.
private struct RemovedRow: View {
    let item: DayPlan.Item
    let onUndo: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(parseISODate(item.startsAt).map(campusTime) ?? "")
                .font(.callout.monospacedDigit())
                .frame(width: 58, alignment: .leading)
            Text(L("%@ removed from today", item.kind == "home" ? L("The trip home") : item.label.components(separatedBy: " @ ")[0])).font(.callout)
            Spacer(minLength: 0)
            Button(L("Undo"), action: onUndo).buttonStyle(.plain).foregroundStyle(.tint).fontWeight(.medium)
        }
        .foregroundStyle(.secondary)
    }
}

/// One of today's entries; anything still to come has an × on hover to take it off today.
private struct TodayRow: View {
    let item: DayPlan.Item
    let onRemove: (DayPlan.Item) -> Void
    @State private var hovering = false

    var body: some View {
        let past = item.status == "done" || item.status == "skipped"
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(parseISODate(item.startsAt).map(campusTime) ?? "")
                .font(.callout.monospacedDigit().weight(item.status == "next" || item.status == "now" ? .semibold : .regular))
                .frame(width: 58, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.callout).strikethrough(item.status == "skipped")
                if let sub = item.sub { Text(sub).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if item.removable == true {
                Button { onRemove(item) } label: { Image(systemName: "xmark").font(.caption.weight(.semibold)) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
                    .opacity(hovering ? 1 : 0)
                    .help(L("Remove from today"))
                    .accessibilityLabel(L("Remove %@ from today", item.title))
            }
        }
        .opacity(past ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        // One element per row; the hover-only × is its "Remove from today" action.
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if item.removable == true { Button(L("Remove from today")) { onRemove(item) } }
        }
    }
}
