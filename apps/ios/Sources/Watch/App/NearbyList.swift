import SwiftUI

/// The stops near you, as /me/nearby gives them to the phone: each stop's
/// name over a row per line, with where it's going, its next bus large and
/// the two after it, in the phone's words (NearbyCells). The times count
/// down from when they came, as a stop's board does (BusTimes.aged).
struct NearbyList: View {
    let now: Date
    @Environment(WatchModel.self) private var model

    var body: some View {
        if let stops = model.nearby {
            let shown = stops.map { $0.aged(got: model.nearbyAt, now: now) }
            let cells = shown.map { s in s.board.filter(\.running).map { ($0, NearbyCells.cells($0)) } }
            VStack(alignment: .leading, spacing: 10) {
                if stops.isEmpty { Text(L("Nothing yet")).foregroundStyle(Color.muted) }
                if let e = model.error { Text(e).font(.footnote).foregroundStyle(Color.warn) }
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, s in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Image(systemName: "bus.fill").font(.caption2).foregroundStyle(Color.brand)
                            Text(s.stop.name).font(.headline).lineLimit(2)
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(.isHeader)
                        if cells[i].isEmpty {
                            Text(s.available ? L("Nothing yet") : L("Offline")).font(.footnote).foregroundStyle(Color.muted)
                        }
                        ForEach(cells[i], id: \.0.svc) { row, c in Row(row: row, cells: c) }
                    }
                    .accessibilityIdentifier("nearby.stop.\(s.stop.code)")
                }
                if let foot = NearbyCells.foot(cells.flatMap { $0.map(\.1) }) {
                    Text(foot).font(.caption2).foregroundStyle(Color.muted)
                }
            }
        } else if model.loading || model.error == nil {
            HStack(spacing: 8) {
                ProgressView().frame(width: 20, height: 20)
                Text(L("Checking…")).foregroundStyle(Color.muted)
            }
        } else {
            Text(model.error ?? L("Nothing yet")).font(.footnote).foregroundStyle(Color.warn)
        }
    }

    /// One line at a stop: its badge, where it's going, then its next bus large and the two after it.
    private struct Row: View {
        let row: BoardRow
        let cells: [NearbyCell]

        var body: some View {
            HStack(alignment: .center, spacing: 6) {
                BusBadge(svc: row.svc, color: row.color, size: 13, paid: row.paid, even: true)
                Text(NearbyCells.destText(row)).font(.caption2).foregroundStyle(Color.muted).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 0) {
                    let next = cells[0]
                    (Text(next.mark + next.figure).font(.body.weight(.bold)) + Text(next.trail).font(.caption2))
                        .lineLimit(1).fixedSize()
                    let then = cells.dropFirst().filter(\.hasBus).map(\.text)
                    if !then.isEmpty {
                        Text(then.joined(separator: ", ")).font(.caption2).foregroundStyle(Color.muted).lineLimit(1).fixedSize()
                    }
                }
                .monospacedDigit()
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(NearbyCells.spoken(row, cells: cells))
        }
    }
}
