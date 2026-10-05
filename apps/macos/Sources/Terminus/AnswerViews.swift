import SwiftUI
import os

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
                // On the bus: how far along, and the next stop, as the phone and the web show it.
                if let ride = a.card?.ride { RideProgress(ride: ride) }
                if let w = a.card?.warning { Row(icon: "exclamationmark.triangle.fill", text: w).fontWeight(.semibold).foregroundStyle(Color.warn) }
                if a.isFree {
                    // Nothing to catch: no bus to mistake for advice.
                    Row(icon: "calendar", text: a.detail)
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
                } else {
                Row(icon: a.mode == "rest" ? "calendar" : "text.alignleft", text: a.detail)
                if let leave = a.leaveText() { Row(icon: "figure.walk", text: leave).fontWeight(.semibold) }
                }
                if !a.isClassPlan, !a.isFree, a.timing?.text != nil || a.crowdText != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = t.text { Pill(text: text, color: t.status == "late" ? .red : t.status == "tight" ? .warn : .good) }
                        if let c = a.crowdText { Pill(text: c, color: .secondary) }
                    }
                }
                // The server's buttons (plans only: Not going, Not on campus today, undo), the first one prominent.
                if let actions = a.card?.actions?.filter({ !($0.id == "reset" && $0.trip == undoShownFor && undoShownFor != nil) }), !actions.isEmpty {
                    Flow(spacing: 6) {
                        ForEach(Array(actions.enumerated()), id: \.element) { i, action in
                            if i == 0 && action.id != "skipped" && action.id != "reset" {
                                Button(action.label) { onAction(action) }.buttonStyle(.borderedProminent).controlSize(.small)
                            } else {
                                Button(action.label) { onAction(action) }.buttonStyle(.bordered).controlSize(.small)
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

/// On the bus: a bar from boarding to getting off, and the next stop.
struct RideProgress: View {
    let ride: NextAnswer.Ride

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { t in
            VStack(alignment: .leading, spacing: 4) {
                // Drawn, not a ProgressView: the same in the popover and in snapshots.
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(.primary.opacity(0.1))
                        Capsule().fill(Color.brand).frame(width: max(6, g.size.width * ride.progress(t.date)))
                    }
                }
                .frame(height: 6)
                .accessibilityElement()
                .accessibilityLabel(L("Ride progress"))
                .accessibilityValue("\(Int(ride.progress(t.date) * 100))%")
                Text(ride.nextText(t.date)).font(.callout)
            }
        }
    }
}

struct NearbyList: View {
    let stops: [NearbyStop]?
    /// The stop across the road shown first: the nearest one by location can be the wrong side.
    var swap: Binding<(from: String, to: String, at: Date)?> = .constant(nil)

    /// The nearest stop's twin across the road, when the answer has it.
    private func twin(_ stops: [NearbyStop]) -> NearbyStop? {
        guard let code = stops.first?.opposite else { return nil }
        return stops.first { $0.stop.code == code }
    }

    /// Whether the swap still holds: the same nearest stop, for up to an hour.
    private func swapped(_ stops: [NearbyStop]) -> Bool {
        guard let s = swap.wrappedValue, let first = stops.first, let t = twin(stops) else { return false }
        return Date().timeIntervalSince(s.at) <= 3600 && s.from == first.stop.code && s.to == t.stop.code
    }

    private func order(_ stops: [NearbyStop]) -> [NearbyStop] {
        guard swapped(stops), let t = twin(stops), let first = stops.first else { return stops }
        return [t, first] + stops.dropFirst().filter { $0.stop.code != t.stop.code }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let all = stops {
                let shown = order(all)
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, s in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(s.stop.name).font(.system(size: 13, weight: .semibold))
                            Spacer()
                            Text(s.walkS < 60 ? L("You're here") : L("%@ min walk", "\((s.walkS + 30) / 60)"))
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                            if i == 0, let t = twin(all), let first = all.first {
                                let on = swapped(all)
                                let other = on ? first : t
                                Button {
                                    swap.wrappedValue = on ? nil : (first.stop.code, t.stop.code, Date())
                                } label: {
                                    Image(systemName: "arrow.left.arrow.right").font(.system(size: 11)).foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .help(L("Show %@ instead", other.stop.name))
                                .accessibilityLabel(L("Show %@ instead", other.stop.name))
                            }
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

/// One pill per service: "D2  4m". Wraps onto more lines instead of
/// squeezing when a stop has many services.
struct FlowPills: View {
    let rows: [BoardRow]
    var body: some View {
        Flow(spacing: 6) {
            ForEach(rows, id: \.self) { r in
                HStack(spacing: 5) {
                    // In the service's colour, as on the buses and the map.
                    if let c = r.color.flatMap(Color.init(hex:)) {
                        Text(r.svc).font(.system(size: 11, weight: .bold)).foregroundStyle(inkOn(r.color ?? ""))
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(c))
                    } else {
                        Text(r.svc).font(.system(size: 11, weight: .bold))
                    }
                    Text(eta(r))
                        .font(.system(size: 11, weight: .medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }
                .fixedSize()
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Capsule().fill(.primary.opacity(0.07)))
            }
        }
    }

    private func eta(_ r: BoardRow) -> String {
        guard let s = r.etaS else { return r.quality == "ended" ? L("ended") : "–" }
        return s < 45 ? L("now") : L("%@m", "\((s + 30) / 60)")
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
    var onRemove: (DayPlan.Item) -> Void = { _ in }
    var onUndo: () -> Void = {}

    var body: some View {
        let at = removedBefore.map { k in day.items.firstIndex { $0.key == k } ?? min(removedAt, day.items.count) } ?? day.items.count
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: L("Today"))
            ForEach(Array(day.items.enumerated()), id: \.element.id) { i, item in
                if i == at, let r = removed { RemovedRow(item: r, onUndo: onUndo) }
                TodayRow(item: item, onRemove: onRemove)
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
