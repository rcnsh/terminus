import SwiftUI

struct NearbyList: View {
    @Environment(AppModel.self) private var app
    private let model = NearbyTabModel.shared

    var body: some View {
        if let stops = model.stops {
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
                    if let foot = NearbyCells.foot(cells.flatMap { $0 }) {
                        Text(foot)
                            .font(.footnote)
                            .foregroundStyle(Color.muted)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 6)
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("nearbyFoot")
                    }
                }
            }
            .task(id: app.session) {
                BusesModel.shared.sync()
                await BusesModel.shared.loadProfile()
            }
        } else if model.loading || model.error == nil {
            VStack(spacing: 12) {
                ForEach(0..<2, id: \.self) { i in StopSignSkeleton(seed: i) }
            }
            .shimmering()
            .skeletonSpoken()
        } else {
            Text(L("Nothing yet")).font(.title3)
        }
    }
}

struct StopSignSkeleton: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    var seed = 0

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "bus.fill").font(.system(size: 14 * scale)).foregroundStyle(Color.brand)
                SkeletonLine(font: .system(size: 16 * scale, weight: .bold), fraction: SkeletonWidths.name(seed) * 0.7)
                Spacer(minLength: 4)
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Color.surface2)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.line).frame(height: 1) }
            StopSignSkeletonRows(seed: seed)
        }
        .foregroundStyle(Color.ink)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
    }
}

struct StopSignSkeletonRows: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    var services: [String] = []
    var colors: [String: String] = [:]
    var badgeWidth: CGFloat = 0
    var seed = 0

    private var widths: [CGFloat] { [52 * scale, 24 * scale, 24 * scale] }

    var body: some View {
        let rows: [String?] = services.isEmpty ? [nil, nil, nil] : services
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Spacer(minLength: 0)
                ForEach(Array([L("Next"), L("Then"), L("After")].enumerated()), id: \.offset) { k, title in
                    Text(title).font(.system(size: 10.5 * scale, weight: .semibold)).textCase(.uppercase).tracking(0.63 * scale)
                        .lineLimit(1).fixedSize().frame(minWidth: widths[k], alignment: .trailing)
                }
            }
            .foregroundStyle(Color.muted)
            .padding(.horizontal, NearbyColumns.inset)
            .padding(.top, 8)
            .padding(.bottom, 2)
            ForEach(Array(rows.enumerated()), id: \.offset) { j, svc in
                if j > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                HStack(spacing: NearbyColumns.gap) {
                    HStack(spacing: NearbyColumns.toDest) {
                        if let svc {
                            NearbyBadge(svc: svc, color: colors[svc], paid: false, width: badgeWidth)
                        } else {
                            SkeletonBar(width: 36 * scale, height: 28 * scale, radius: 8)
                        }
                        SkeletonLine(font: .system(size: 14.5 * scale), fraction: SkeletonWidths.sub(seed + j) * 1.2)
                    }
                    HStack(spacing: 14) {
                        SkeletonLine(font: .system(size: 21.5 * scale, weight: .bold), points: widths[0] * 0.8)
                            .frame(width: widths[0], alignment: .trailing)
                        SkeletonLine(font: .system(size: 16 * scale, weight: .semibold), points: widths[1] * 0.8)
                            .frame(width: widths[1], alignment: .trailing)
                        SkeletonLine(font: .system(size: 16 * scale, weight: .semibold), points: widths[2] * 0.8)
                            .frame(width: widths[2], alignment: .trailing)
                    }
                }
                .padding(.horizontal, NearbyColumns.inset)
                .padding(.vertical, 6)
                .frame(minHeight: 52)
            }
        }
    }
}

struct NearbySigns<Content: View>: View {
    var inset: CGFloat = 0
    @ViewBuilder let content: (NearbyColumns) -> Content
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

    private var columns: NearbyColumns {
        let badge = widest.badge.rounded(.up)
        let line = width - inset - 2 * NearbyColumns.inset - 2
        let room = line - badge - NearbyColumns.toDest - NearbyColumns.gap
        let layout = NearbyCells.layout(
            times: widest.times, heads: widest.heads, whole: widest.whole, need: widest.need, room: room, line: line)
        return NearbyColumns(badge: badge, layout: layout)
    }
}

struct NearbyWidths: Equatable {
    var badge: CGFloat = 0
    var times: [CGFloat] = [0, 0, 0]
    var heads: [CGFloat] = [0, 0, 0]
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

struct NearbyColumns: Equatable {
    static let inset: CGFloat = 14
    static let toDest: CGFloat = 8
    static let gap: CGFloat = 14
    var badge: CGFloat
    var layout: NearbyCells.Layout
}

extension View {
    fileprivate func measured(_ make: @escaping (CGFloat) -> NearbyWidths, _ content: some View) -> some View {
        background(alignment: .leading) {
            content.fixedSize().hidden()
                .background(GeometryReader { g in Color.clear.preference(key: NearbyWidths.Key.self, value: make(g.size.width)) })
                .accessibilityHidden(true)
        }
    }
}

struct StopSign: View {
    @ScaledMetric(relativeTo: .body) private var percent: CGFloat = 100
    private var scale: CGFloat { percent / 100 }
    let stop: NearbyStop
    let cells: [[NearbyCell]]
    let cols: NearbyColumns
    var note: String?
    var pending: [String]?
    var listsStopped = false
    let onStop: () -> Void
    let onRow: (String) -> Void

    private var walk: String? { stop.walkS.map { $0 < 60 ? L("here") : L("%@ min walk", "\(($0 + 30) / 60)") } }
    private var spoken: String { [stop.stop.name, walk].compactMap { $0 }.joined(separator: ", ") }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Button(action: onStop) {
                    HStack(spacing: 8) {
                        Image(systemName: "bus.fill").font(.system(size: 14 * scale)).foregroundStyle(Color.brand)
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
                .accessibilityRepresentation { Button(spoken, action: onStop) }
                .accessibilityHint(L("See this stop's buses"))
                .accessibilityIdentifier("nearby.\(stop.stop.code)")
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
            let rows = stop.board.filter(\.running)
            if stop.available, rows.isEmpty, let pending {
                StopSignSkeletonRows(services: pending, colors: BusesModel.shared.campus?.colors ?? [:], badgeWidth: cols.badge)
                    .shimmering().skeletonSpoken()
            } else if stop.available, rows.isEmpty, let note {
                Text(note).foregroundStyle(Color.muted).padding(14).frame(maxWidth: .infinity, alignment: .leading)
                if listsStopped {
                    ForEach(stop.board.filter { !$0.running }, id: \.svc) { row in
                        Rectangle().fill(Color.line).frame(height: 1)
                        BusBoardRowView(row: row, color: row.color, now: ServerClock.now, onTap: row.paid ? nil : { onRow(row.svc) })
                    }
                }
            }
            if !rows.isEmpty { heading }
            ForEach(Array(rows.enumerated()), id: \.offset) { j, row in
                if j > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                let cells = j < self.cells.count ? self.cells[j] : NearbyCells.cells(row)
                let id = "nearbyRow.\(stop.stop.code).\(row.svc)"
                let stacked = cols.layout.stacked
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

    private var heading: some View {
        HStack(spacing: cols.layout.between) {
            Spacer(minLength: 0)
            ForEach(Array([L("Next"), L("Then"), L("After")].enumerated()), id: \.offset) { k, title in
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
        .accessibilityRepresentation { EmptyView() }
    }
}

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
            .measured(
                { NearbyWidths(badge: $0) },
                VStack {
                    label
                    Text(verbatim: "D2").font(font).padding(.horizontal, 6)
                })
    }
}

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
        func place(_ text: (String) -> String = { $0 }) -> AttributedString {
            guard let p = d.place else { return AttributedString() }
            var a = AttributedString(text(p))
            a.foregroundColor = Color.ink
            a.font = .system(size: 14.5 * scale, weight: .semibold)
            return a + muted(text(d.after))
        }
        let whole = muted(d.before) + place()
        let before = d.before.trimmingCharacters(in: .whitespaces)
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
