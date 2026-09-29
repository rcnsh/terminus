import SwiftUI
import os

// MARK: - Content

struct AnswerDetail: View {
    let answer: NextAnswer?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = answer {
                if a.isClassPlan {
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
                if !a.isClassPlan, a.timing?.text != nil || a.crowdText != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = t.text { Pill(text: text, color: t.status == "late" ? .red : t.status == "tight" ? .warn : .good) }
                        if let c = a.crowdText { Pill(text: c, color: .secondary) }
                    }
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
