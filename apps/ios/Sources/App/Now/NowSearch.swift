import SwiftUI

/// "Go somewhere else", opened by the search button at the end of the
/// chips: a field under them, focused, with the results below. Picking one
/// shows its card under a chip of its own and closes the search.
struct NowSearch: View {
    let close: () -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.inks) private var inks
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(inks.muted)
                TextField(text: $query, prompt: Text(L("Stop, building or room")).foregroundStyle(inks.muted)) {
                    Text(L("Go somewhere else"))
                }
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit { if let first = rankDestinations(app.destinations, q).first { pick(first) } }
                .accessibilityIdentifier("search.field")
                if !query.isEmpty {
                    Button {
                        query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(inks.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Clear"))
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(inks.pane, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(inks.line))

            if !q.isEmpty { results(q) }
        }
        .onAppear {
            app.loadDestinations()
            focused = true
        }
    }

    @ViewBuilder private func results(_ q: String) -> some View {
        let matches = rankDestinations(app.destinations, q)
        if matches.isEmpty && !app.destinations.isEmpty {
            Text(L("No stop, building or room by that name")).foregroundStyle(inks.muted).padding(.vertical, 12)
        }
        VStack(alignment: .leading, spacing: 0) {
            // A stop and a building can share a code (COM3): keyed by both.
            ForEach(Array(matches.enumerated()), id: \.element.kindCode) { i, d in
                if i == 0 || matches[i - 1].kind != d.kind {
                    SectionLabel(group(d.kind), color: inks.muted).padding(.top, 14).padding(.bottom, 4)
                }
                Button {
                    pick(d)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.label)
                        Text(meta(d)).font(.footnote).foregroundStyle(inks.muted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("result.\(d.kindCode)")
                Rectangle().fill(inks.line).frame(height: 1)
            }
        }
    }

    private func pick(_ d: Destination) {
        query = ""
        app.select(.code(d.code, label: d.kind == "stop" || d.kind == "landmark" ? d.label : d.code))
        close()
    }

    private func group(_ kind: String) -> String {
        switch kind {
        case "stop": L("Stops")
        case "landmark": L("Food & places")
        case "building": L("Buildings")
        default: L("Rooms")
        }
    }

    private func stopName(_ code: String) -> String {
        app.destinations.first { $0.kind == "stop" && $0.code == code }?.label ?? code
    }

    private func meta(_ d: Destination) -> String {
        switch d.kind {
        case "stop": return L("Bus stop")
        // Served by more than one stop: the quicker one is used at the time.
        case "landmark":
            return [d.detail, L("%@ stop", d.stops.map(stopName).joined(separator: L(" or ")))].compactMap { $0 }.joined(separator: " · ")
        default:
            // Walk times at the user's pace, as the server last said it.
            let speed = app.answer?.walkSpeedMs ?? 1.3
            var s = d.label != d.code ? "\(d.code) · " : ""
            s += L("%@ stop", stopName(d.stopCode))
            if let m = d.walkM { s += L(", %@ min walk", "\(max(1, Int((Double(m) / speed / 60).rounded())))") }
            return s
        }
    }
}

extension Destination {
    var kindCode: String { "\(kind):\(code)" }
}
