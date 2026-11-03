import SwiftUI

/// The stops near you as their signs: the name plate with the walk there
/// and the stop's star, then a row per service read like a stop's board:
/// where it's going and its next three buses, in minutes, the first set
/// large. Every sign has the same columns, each as wide as its widest value
/// on any of them, so the figures line up down the page. The plate opens the
/// stop's board on the Stops tab, a row its service's line from there; under
/// the signs, what a "~" means, and a way to any other stop or line. As Android's NearbyList and the web app (NearbyCells has the words).
struct NearbyList: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let stops = app.nearby {
            if stops.isEmpty {
                Text(L("Nothing yet")).foregroundStyle(Color.muted)
            }
            let cells = stops.map { s in s.board.filter(\.running).map(NearbyCells.cells) }
            NearbySigns { cols in
                VStack(spacing: 12) {
                    ForEach(Array(stops.enumerated()), id: \.element.id) { i, s in
                        let code = s.stop.code
                        StopSign(stop: s, cells: cells[i], cols: cols, onStop: { app.showInBuses([.stop(code)]) }) { svc in
                            app.showInBuses([.line(svc: svc, from: code)])
                        }
                    }
                    if !stops.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(NearbyCells.foot(cells.flatMap { $0 }), id: \.self) { Text($0) }
                        }
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 6)
                        .accessibilityElement(children: .combine)
                        .accessibilityIdentifier("nearbyFoot")
                    }
                    StopsLink { app.showInBuses([]) }
                }
            }
            // The stars need the account's pins, which the Stops tab keeps.
            .task(id: app.session) {
                BusesModel.shared.sync()
                await BusesModel.shared.loadProfile()
            }
        } else {
            Text(app.loading ? L("Checking…") : L("Nothing yet")).font(.title3)
        }
    }
}

/// Stop signs drawn together, as Nearby and the Stops tab's pinned stops do:
/// it measures the widest of each thing on every sign inside it, and the
/// room it has, and gives `content` the columns they all share.
struct NearbySigns<Content: View>: View {
    /// How much narrower a sign is than this (the pinned pages' gutters).
    var inset: CGFloat = 0
    @ViewBuilder let content: (NearbyColumns) -> Content
    /// The widest badge, times and destination line on every sign, as drawn.
    @State private var widest = NearbyWidths()
    @State private var width: CGFloat = 0

    var body: some View {
        content(columns)
            .onPreferenceChange(NearbyWidths.Key.self) { widest = $0 }
            .onGeometryChange(for: CGFloat.self) {
                $0.size.width
            } action: {
                width = $0
            }
    }

    /// The columns every sign draws: the widest badge (never narrower than
    /// "D2"), and the time columns as NearbyCells.layout gives way to fit.
    private var columns: NearbyColumns {
        let badge = widest.badge.rounded(.up)
        // A point spare, for the rounding.
        let line = width - inset - 2 * NearbyColumns.inset - 2
        let room = line - badge - NearbyColumns.toDest - NearbyColumns.gap
        let layout = NearbyCells.layout(
            times: widest.times, heads: widest.heads, whole: widest.whole, need: widest.need, room: room, line: line)
        return NearbyColumns(badge: badge, layout: layout)
    }
}

/// The widest of each thing on every sign, each reported as it's laid out.
struct NearbyWidths: Equatable {
    var badge: CGFloat = 0
    /// Each time column's widest time, and its heading, at full size.
    var times: [CGFloat] = [0, 0, 0]
    var heads: [CGFloat] = [0, 0, 0]
    /// The most any row's destination needs in its two lines (NearbyCells.lines),
    /// and to keep its place whole (NearbyCells.wholeLines).
    var need: CGFloat = 0
    var whole: CGFloat = 0

    func merged(_ o: NearbyWidths) -> NearbyWidths {
        NearbyWidths(
            badge: max(badge, o.badge), times: zip(times, o.times).map { max($0, $1) }, heads: zip(heads, o.heads).map { max($0, $1) },
            need: max(need, o.need), whole: max(whole, o.whole))
    }

    struct Key: PreferenceKey {
        static let defaultValue = NearbyWidths()
        static func reduce(value: inout NearbyWidths, nextValue: () -> NearbyWidths) { value = value.merged(nextValue()) }
    }
}

/// The widths the signs' rows and headings share.
struct NearbyColumns: Equatable {
    static let inset: CGFloat = 14
    static let toDest: CGFloat = 8
    static let gap: CGFloat = 14
    var badge: CGFloat
    var layout: NearbyCells.Layout
}

extension View {
    /// Reports `content`'s own width, as wide as it would be on one line, whatever room it's given.
    fileprivate func measured(_ make: @escaping (CGFloat) -> NearbyWidths, _ content: some View) -> some View {
        background(alignment: .leading) {
            content.fixedSize().hidden()
                .background(GeometryReader { g in Color.clear.preference(key: NearbyWidths.Key.self, value: make(g.size.width)) })
                .accessibilityHidden(true)
        }
    }
}

/// A stop's sign: its plate, then its running services' rows. On Nearby,
/// and a page each for the Stops tab's pinned stops.
struct StopSign: View {
    /// Scaled from 100, not 1: a scaled metric is rounded to the pixel, so 1
    /// would stay 1 a text size or two up.
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    /// How much larger than at the usual text size, as the phone is set.
    private var scale: CGFloat { percent / 100 }
    let stop: NearbyStop
    let cells: [[NearbyCell]]
    let cols: NearbyColumns
    /// Under the plate when nothing is running: why (still asking, offline, none now).
    var note: String?
    let onStop: () -> Void
    let onRow: (String) -> Void

    /// Without a location (a pinned stop's), no walk.
    private var walk: String? { stop.walkS.map { $0 < 60 ? L("here") : L("%@ min walk", "\(($0 + 30) / 60)") } }
    /// The plate as VoiceOver reads it.
    private var spoken: String { [stop.stop.name, walk].compactMap { $0 }.joined(separator: ", ") }

    var body: some View {
        VStack(spacing: 0) {
            // The plate, as on the pole: a shade off the card, the bus mark in the accent.
            HStack(spacing: 0) {
                Button(action: onStop) {
                    HStack(spacing: 8) {
                        Image(systemName: "bus.fill").font(.system(size: 14 * scale)).foregroundStyle(Color.brand)
                        // The name opens the stop's board: the chevron says so, as on the Stops tab.
                        HStack(spacing: 4) {
                            Text(stop.stop.name).font(.system(size: 16 * scale, weight: .bold)).lineLimit(1)
                            Image(systemName: "chevron.right").font(.system(size: 12 * scale, weight: .semibold)).foregroundStyle(
                                Color.muted)
                        }
                        Spacer(minLength: 4)
                        if let walk {
                            Text(walk)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(Color.muted)
                        }
                    }
                    .padding(.leading, 14)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BusRowPress())
                // One element in its own words, its icon, chevron and walk not each their own.
                .accessibilityRepresentation { Button(spoken, action: onStop) }
                .accessibilityHint(L("See this stop's buses"))
                .accessibilityIdentifier("nearby.\(stop.stop.code)")
                // Only once the pins have come: before, a pinned stop's star would
                // read hollow, and a tap on it would unpin it.
                if BusesModel.shared.pinsState == .ready {
                    BusStar(code: stop.stop.code, name: stop.stop.name).padding(.trailing, 2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: 44)
            .background(Color.surface2)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.line).frame(height: 1) }

            if !stop.available {
                Text(L("No live data")).foregroundStyle(Color.muted).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            // Running now: the board comes with the rest too, for the widgets' first buses.
            let rows = stop.board.filter(\.running)
            if stop.available, rows.isEmpty, let note {
                Text(note).foregroundStyle(Color.muted).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            if !rows.isEmpty { heading }
            ForEach(Array(rows.enumerated()), id: \.offset) { j, row in
                if j > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                let cells = j < self.cells.count ? self.cells[j] : NearbyCells.cells(row)
                let id = "nearbyRow.\(stop.stop.code).\(row.svc)"
                let stacked = cols.layout.stacked
                // A public bus has no line here (/line is the shuttles'), as on a board.
                Button {
                    onRow(row.svc)
                } label: {
                    let head = HStack(spacing: NearbyColumns.toDest) {
                        NearbyBadge(svc: row.svc, color: row.color, paid: row.paid, width: cols.badge)
                        NearbyDest(row: row)
                    }
                    let times = HStack(spacing: cols.layout.between) {
                        ForEach(0..<3, id: \.self) { k in
                            NearbyTimeView(
                                cell: cells[k], col: k, width: cols.layout.widths[k], zoom: stacked ? 1 : cols.layout.zoom
                            )
                        }
                    }
                    // Too little room beside the times on some row: every row's times
                    // go under it, at full size, in the same columns.
                    let layout =
                        stacked
                        ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4)) : AnyLayout(HStackLayout(spacing: NearbyColumns.gap))
                    layout {
                        head
                        times
                    }
                    .padding(.horizontal, NearbyColumns.inset)
                    .padding(.vertical, 6)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BusRowPress())
                .disabled(row.paid)
                // Read as one, in the row's own words: not its badge, place and times one by one.
                .accessibilityRepresentation {
                    Button(NearbyCells.spoken(row, cells: cells)) { onRow(row.svc) }.disabled(row.paid)
                }
                .accessibilityHint(row.paid ? "" : L("See the %@ line", row.svc))
                .accessibilityAddTraits(row.paid ? [] : .isButton)
                .accessibilityIdentifier(id)
            }
        }
        .foregroundStyle(Color.ink)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(spoken)
    }

    /// NEXT, THEN, AFTER over the time columns; the rows read their own times out.
    private var heading: some View {
        HStack(spacing: cols.layout.between) {
            Spacer(minLength: 0)
            ForEach(Array([L("Next"), L("Then"), L("After")].enumerated()), id: \.offset) { k, title in
                // Never shrunk: its column is at least as wide (NearbyCells.layout).
                let label = Text(title).font(.system(size: 10.5 * scale, weight: .semibold)).textCase(.uppercase).tracking(0.63 * scale)
                label
                    .lineLimit(1)
                    .frame(width: cols.layout.widths[k] > 0 ? cols.layout.widths[k] : nil, alignment: .trailing)
                    .measured(
                        { w in
                            var m = NearbyWidths()
                            m.heads[k] = w
                            return m
                        }, label)
            }
        }
        .foregroundStyle(Color.muted)
        .padding(.horizontal, NearbyColumns.inset)
        .padding(.top, 8)
        .padding(.bottom, 2)
        // Not read: each row says which of its times is which.
        .accessibilityRepresentation { EmptyView() }
    }
}

/// A service's badge on a Nearby row: every one on the screen as wide as the widest.
private struct NearbyBadge: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    let svc: String
    let color: String?
    let paid: Bool
    let width: CGFloat

    var body: some View {
        let rgb = color.flatMap(hexRGB) ?? 0x8A847E
        let font = Font.system(size: 14.5 * scale, weight: .bold)
        let label = Text(verbatim: paid ? "\(svc) $" : svc).font(font).padding(.horizontal, 6)
        label
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .foregroundStyle(inkOn(rgb))
            .frame(width: width > 0 ? width : nil, height: 28 * scale)
            .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            // Never narrower than two characters' badge, so a one-letter line's isn't a sliver.
            .measured(
                { NearbyWidths(badge: $0) },
                VStack {
                    label
                    Text(verbatim: "D2").font(font).padding(.horizontal, 6)
                })
    }
}

/// Where a row's bus is going: the place in ink, the words around it muted.
private struct NearbyDest: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    let row: BoardRow

    var body: some View {
        let d = NearbyCells.dest(row)
        let font = Font.system(size: 14.5 * scale)
        func muted(_ s: String) -> AttributedString {
            var a = AttributedString(s)
            a.foregroundColor = Color.muted
            return a
        }
        /// The place in ink, the words after it muted; `text` rewrites each piece's words.
        func place(_ text: (String) -> String = { $0 }) -> AttributedString {
            guard let p = d.place else { return AttributedString() }
            var a = AttributedString(text(p))
            a.foregroundColor = Color.ink
            a.font = .system(size: 14.5 * scale, weight: .semibold)
            return a + muted(text(d.after))
        }
        let whole = muted(d.before) + place()
        let before = d.before.trimmingCharacters(in: .whitespaces)
        // The place whole on a line of its own when it doesn't fit beside "to" or
        // "via"; broken inside it, at its no-break spaces too, only when it
        // can't fit whole.
        let plain = { (s: String) in s.replacingOccurrences(of: "\u{00A0}", with: " ") }
        let breakable = muted(plain(d.before)) + place(plain)
        return ViewThatFits(in: .horizontal) {
            Text(whole).lineLimit(1)
            if d.place != nil && !before.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    Text(muted(before)).lineLimit(1)
                    Text(place()).lineLimit(1)
                }
            }
            Text(breakable).lineLimit(2)
        }
        .font(font)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        // As if all of it were the place's weight: a little more room than it needs, never less.
        .measured({ NearbyWidths(need: $0) }, lines(NearbyCells.lines(row)))
        .measured({ NearbyWidths(whole: $0) }, lines(NearbyCells.wholeLines(row)))
    }

    private func lines(_ text: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(text, id: \.self) { Text(verbatim: $0) }
        }
        .font(.system(size: 14.5 * scale, weight: .semibold))
    }
}

/// One bus's cell (NearbyCell has what it says): the figures in the board's
/// display weights, the unit small.
private struct NearbyTimeView: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    let cell: NearbyCell
    let col: Int
    let width: CGFloat
    let zoom: CGFloat

    var body: some View {
        styled(zoom)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .frame(width: width > 0 ? width : nil, alignment: .trailing)
            // Measured at its own size, so the columns don't chase their own shrinking.
            .measured(
                { w in
                    var m = NearbyWidths()
                    m.times[col] = w
                    return m
                }, styled(1))
    }

    private func styled(_ zoom: CGFloat) -> Text {
        let scale = scale * zoom
        let size: CGFloat = cell.pick ? 21.5 : 16
        let big = Font.system(size: size * scale, weight: cell.pick ? .bold : .semibold).monospacedDigit()
        let small = Font.system(size: 11 * scale, weight: .medium)
        func run(_ s: String, _ f: Font) -> AttributedString {
            var a = AttributedString(s)
            a.font = f
            return a
        }
        var a = run(cell.mark, big) + run(cell.figure, big) + run(cell.trail, small)
        a.foregroundColor = cell.pick ? Color.ink : Color.muted
        return Text(a).tracking(cell.pick ? -0.02 * size * scale : -0.01 * size * scale)
    }
}

/// Under the signs: what the Stops tab is for, and the way there.
private struct StopsLink: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image("StopSign").renderingMode(.template).foregroundStyle(Color.brand).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Another stop, or a whole line")).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                    Text(L("Search, pinned stops and services are in Stops.")).font(.subheadline).foregroundStyle(Color.muted)
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint).accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(BusRowPress())
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("nearbyStops")
    }
}
