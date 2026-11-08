import SwiftUI

/// "Stop, building or room": the same search as Now's, in a sheet, for where
/// a class or a favourite goes. `pinned` (the stops your classes use) comes
/// first, before anything is typed too. Calls `onPick` and closes.
struct SettingsWherePicker: View {
    let title: String
    let destinations: [Destination]
    var pinned: [WhereItem] = []
    let onPick: (WhereItem) -> Void
    @State private var query = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                let q = query.trimmingCharacters(in: .whitespaces)
                let top =
                    q.isEmpty
                    ? pinned
                    : SearchRank.rank(pinned, q, max: 6) { SearchRank.Key(kind: $0.kind, code: $0.code, label: $0.label, aliases: []) }
                let rest =
                    q.isEmpty
                    ? []
                    : rankDestinations(destinations, q, max: 12).map(WhereItem.init).filter { d in !top.contains { d.isPlace(of: $0) } }
                if !top.isEmpty {
                    Section(L("In your timetable")) { ForEach(top) { row($0) } }
                }
                if !rest.isEmpty {
                    Section { ForEach(rest) { row($0) } }
                }
                if top.isEmpty && rest.isEmpty {
                    if !q.isEmpty && destinations.isEmpty {
                        // The places to search are on their way: the results' rows in bars, read once as "Loading…".
                        Section {
                            ForEach(0..<6, id: \.self) { i in
                                VStack(alignment: .leading, spacing: 2) {
                                    SkeletonLine(font: .body, fraction: SkeletonWidths.name(i))
                                    SkeletonLine(font: .footnote, fraction: SkeletonWidths.sub(i) * 0.6)
                                }
                                .listRowBackground(Color.surface)
                                .skeletonSpoken(L("Loading…"))
                                .accessibilityHidden(i > 0)
                            }
                        }
                    } else {
                        Section {
                            Text(
                                q.isEmpty
                                    ? L("Type a stop, building or room, like COM3 or UTown.") : L("No stop, building or room by that name")
                            )
                            .foregroundStyle(Color.muted)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            // One sweep for the list's rows of bars, running only while they show.
            .shimmering(!query.trimmingCharacters(in: .whitespaces).isEmpty && destinations.isEmpty)
            .scrollContentBackground(.hidden)
            .background(Color.page)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: L("Stop, building or room"))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
            }
        }
        .centredSheet()
    }

    private func row(_ d: WhereItem) -> some View {
        Button {
            onPick(d)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(d.label).foregroundStyle(Color.ink)
                Text(kind(d)).font(.footnote).foregroundStyle(Color.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .listRowBackground(Color.surface)
        .accessibilityIdentifier("where.\(d.code)")
    }

    private func kind(_ d: WhereItem) -> String {
        switch d.kind {
        case "timetable": d.detail ?? ""
        case "stop": L("Bus stop")
        case "landmark": d.detail ?? L("Place")
        case "building": L("Building")
        default: L("Room %@", d.code)
        }
    }
}

/// One answer in the search: a destination, or one of your timetable's stops.
struct WhereItem: Hashable, Identifiable {
    let code: String
    let label: String
    let kind: String
    let detail: String?
    /// Where a favourite or a class goes: a landmark itself, anything else its stop.
    let goesTo: String

    init(code: String, label: String, kind: String, detail: String?, goesTo: String) {
        self.code = code
        self.label = label
        self.kind = kind
        self.detail = detail
        self.goesTo = goesTo
    }

    init(_ d: Destination) {
        self.init(code: d.code, label: d.label, kind: d.kind, detail: d.detail, goesTo: d.goesTo)
    }

    /// A stop and a building can share a code (COM3): the kind tells them apart.
    var id: String { "\(kind):\(code)" }

    /// Whether this is the place a timetable row stands for (its `code`, where
    /// its classes go): that stop or landmark itself, not a building sharing its code.
    func isPlace(of row: WhereItem) -> Bool { (kind == "stop" || kind == "landmark") && code == row.code }
}
