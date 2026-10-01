import SwiftUI
import os

// MARK: - Content

struct AnswerDetail: View {
    let answer: NextAnswer?
    var busy = false
    var onAction: (CardAction) -> Void = { _ in }
    var onChoice: (Suggestion, Bool) -> Void = { _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = answer {
                if let w = a.card?.warning { Row(icon: "exclamationmark.triangle.fill", text: w).fontWeight(.semibold).foregroundStyle(Color.warn) }
                if a.isFree {
                    // Nothing to catch: no bus to mistake for advice.
                    Row(icon: "calendar", text: a.detail)
                    Row(icon: "location", text: "Buses near you are under Nearby.").foregroundStyle(.secondary)
                } else if a.isClassPlan {
                    // Each arrival next to the bus it belongs to.
                    // The bus to catch (it names the stop), then when it gets you there.
                    let tone = a.leaveLate ? Color.red : Color.good
                    if let c = a.catchHow { Row(icon: a.leave?.svc == nil ? "figure.walk" : "bus.fill", text: c).fontWeight(.semibold).foregroundStyle(tone) }
                    if let arrive = a.catchArrive { Row(icon: "flag.checkered", text: arrive).foregroundStyle(tone) }
                    if let note = a.card?.note { Row(icon: "person.3.fill", text: note).foregroundStyle(Color.warn) }
                    if let e = a.card?.estimate { Row(icon: "info.circle", text: e).foregroundStyle(.secondary) }
                    if let g = a.goNowLine { Row(icon: "bus", text: g) }
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
                if let actions = a.card?.actions, !actions.isEmpty {
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
                    Text("Checking…").foregroundStyle(.secondary)
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

struct NearbyList: View {
    let stops: [NearbyStop]?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let stops {
                ForEach(stops) { s in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(s.stop.name).font(.system(size: 13, weight: .semibold))
                            Spacer()
                            Text(s.walkS < 60 ? "You're here" : "\((s.walkS + 30) / 60) min walk")
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        if s.board.isEmpty || !s.available {
                            Text(s.available ? "Nothing due" : "No live data").font(.caption).foregroundStyle(.secondary)
                        } else {
                            FlowPills(rows: s.board)
                        }
                    }
                    .card(padding: 10)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(.secondary)
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
                    Text(r.svc).font(.system(size: 11, weight: .bold))
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
        guard let s = r.etaS else { return r.quality == "ended" ? "ended" : "–" }
        return s < 45 ? "now" : "\((s + 30) / 60)m"
    }
}

/// Today, from /me/day: each class with when to leave (or the bus you're
/// on), and the trips home. What's done is dimmed, a skipped class struck through.
struct TodayList: View {
    let day: DayPlan
    var removed: DayPlan.Item? = nil
    var onRemove: (DayPlan.Item) -> Void = { _ in }
    var onUndo: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: "Today")
            // Just taken off today: Undo, for a few seconds.
            if let r = removed {
                HStack {
                    Text("\(r.kind == "home" ? "The trip home" : r.label.components(separatedBy: " @ ")[0]) taken off today").font(.callout)
                    Spacer()
                    Button("Undo", action: onUndo).buttonStyle(.plain).foregroundStyle(.tint).fontWeight(.medium)
                }
                .padding(.vertical, 5).padding(.horizontal, 8)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
            }
            ForEach(day.items) { item in
                TodayRow(item: item, onRemove: onRemove)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                    .help("Remove from today")
                    .accessibilityLabel("Remove \(item.title) from today")
            }
        }
        .opacity(past ? 0.5 : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Remove from today") { if item.removable == true { onRemove(item) } }
    }
}
