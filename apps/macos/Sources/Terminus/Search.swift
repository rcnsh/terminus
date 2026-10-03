import SwiftUI
import os

struct Search: View {
    @Bindable var model: AppModel
    @Binding var query: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(.secondary)
                if model.isSnapshot {
                    Text(L("Go somewhere else")).foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                } else {
                    TextField(L("Go somewhere else"), text: $query)
                        .textFieldStyle(.plain)
                        .onChange(of: query) { _, _ in model.loadDestinations() }
                }
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("Clear search"))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.primary.opacity(0.08)))

            let q = query.trimmingCharacters(in: .whitespaces)
            if !q.isEmpty {
                let matches = rankDestinations(model.destinations, q)
                let stopName = { (code: String) in model.destinations.first { $0.kind == "stop" && $0.code == code }?.label ?? code }
                // Walk times at the user's pace, as the server last said it.
                let walkSpeed = model.plan?.walkSpeedMs ?? 1.3
                VStack(spacing: 0) {
                    ForEach(Array(matches), id: \.self) { d in
                        Button {
                            query = ""
                            model.select(.code(d.code, label: d.kind == "stop" || d.kind == "landmark" ? d.label : d.code))
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: d.kind == "stop" ? "bus" : d.kind == "room" ? "door.left.hand.open" : d.kind == "landmark" ? "fork.knife" : "building.2")
                                    .foregroundStyle(.secondary).frame(width: 16)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(d.label)
                                    Text(d.kind == "stop" ? L("Bus stop") : d.kind == "landmark" ? "\(d.detail.map { "\($0) · " } ?? "")\(L("%@ stop", (d.stops ?? []).map(stopName).joined(separator: L(" or "))))" : "\(d.label != d.code ? "\(d.code) · " : "")\(L("%@ stop", stopName(d.stopCode)))\(d.walkM.map { L(", %@ min walk", "\(Swift.max(1, Int((Double($0) / walkSpeed / 60).rounded())))") } ?? "")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .card(padding: 4)
                .transition(.opacity)
            }
        }
    }
}

/// Left-to-right layout that wraps to a new line when the next item
/// wouldn't fit.
struct Flow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, widest: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += s.width + spacing
            line = max(line, s.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}
