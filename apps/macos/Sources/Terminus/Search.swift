import SwiftUI

struct Search: View {
    @Bindable var model: AppModel
    @Binding var query: String
    /// The result Return goes to, moved with the arrow keys.
    @State private var highlighted = 0
    /// The number of results VoiceOver last heard, while something is typed.
    @State private var countSaid: Int?

    private var q: String { query.trimmingCharacters(in: .whitespaces) }
    private var matches: [Destination] { q.isEmpty ? [] : rankDestinations(model.destinations, q) }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(.secondary).accessibilityHidden(true)
                if model.isSnapshot {
                    Text(L("Go somewhere else")).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                } else {
                    TextField(L("Go somewhere else"), text: $query)
                        .textFieldStyle(.plain)
                        .onChange(of: query) { _, _ in
                            model.loadDestinations()
                            highlighted = 0
                        }
                        .onSubmit { if matches.indices.contains(highlighted) { go(matches[highlighted]) } }
                        .onKeyPress(.downArrow) { move(1) }
                        .onKeyPress(.upArrow) { move(-1) }
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

            let found = matches
            if !q.isEmpty, found.isEmpty, !model.destinations.isEmpty {
                Text(L("No matches")).font(.callout).foregroundStyle(.secondary).padding(.horizontal, 10)
            } else if !found.isEmpty {
                let stopName = { (code: String) in model.destinations.first { $0.kind == "stop" && $0.code == code }?.label ?? code }
                // Walk times at the user's pace, as the server last said it.
                let walkSpeed = model.plan?.walkSpeedMs ?? 1.3
                VStack(spacing: 0) {
                    ForEach(Array(found.enumerated()), id: \.element) { i, d in
                        Button {
                            go(d)
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: d.kind == "stop" ? "bus" : d.kind == "room" ? "door.left.hand.open" : d.kind == "landmark" ? "fork.knife" : "building.2")
                                    .foregroundStyle(.secondary).frame(width: 16)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(d.label)
                                    Text(d.kind == "stop" ? L("Bus stop") : d.kind == "landmark" ? "\(d.detail.map { "\($0) · " } ?? "")\(L("%@ stop", (d.stops ?? []).map(stopName).joined(separator: L(" or "))))" : "\(d.label != d.code ? "\(d.code) · " : "")\(L("%@ stop", stopName(d.stopCode)))\(d.walkM.map { L(", %@ min walk", "\(Swift.max(1, Int((Double($0) / walkSpeed / 60).rounded())))") } ?? "")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                            .padding(.vertical, 5)
                            .padding(.horizontal, 8)
                            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(i == highlighted ? AnyShapeStyle(.primary.opacity(0.08)) : AnyShapeStyle(.clear)))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(i == highlighted ? .isSelected : [])
                    }
                }
                .card(padding: 4)
                .transition(.opacity)
            }
        }
        // How many came up, said once typing settles (half a second after the
        // last key), and only when it's a different count from the last said.
        .task(id: "\(model.destinations.count)|\(q)") {
            guard !q.isEmpty else {
                countSaid = nil
                return
            }
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, !model.destinations.isEmpty else { return }
            let n = matches.count
            guard n != countSaid else { return }
            countSaid = n
            announce(n == 0 ? L("No matches") : n == 1 ? L("1 result") : L("%@ results", "\(n)"))
        }
    }

    private func go(_ d: Destination) {
        query = ""
        model.goSomewhere(code: d.code, label: d.kind == "stop" || d.kind == "landmark" ? d.label : d.code)
    }

    private func move(_ by: Int) -> KeyPress.Result {
        let n = matches.count
        guard n > 0 else { return .ignored }
        highlighted = (highlighted + by + n) % n
        return .handled
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
