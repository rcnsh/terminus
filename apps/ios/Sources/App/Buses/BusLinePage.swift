import SwiftUI

/// A service's line, top to bottom in its colour: each stop, the buses at a
/// stop or between two, and the stop it was opened from with its time.
struct BusLinePage: View {
    let svc: String
    let from: String?
    @Environment(BusesModel.self) private var model
    @Environment(\.inks) private var inks
    @State private var scrolled = false
    @State private var pull = SkyPull()

    private var key: String { BusesModel.lineKey(svc, from) }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.now
            // Refreshes failing: your stop's time counted down, not passed off as live.
            let line = model.lines[key]?.aged(now)
            let color = line?.color ?? model.color(svc)
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        SkyBand(moonLow: true) {
                            VStack(alignment: .leading, spacing: 0) {
                                PullRoom(below: 8)
                                heading(line, color)
                            }
                        }
                        .busBandEnd()
                        content(line, color, now)
                            .padding(.horizontal, 16)
                            .padding(.bottom, 24)
                    }
                }
                .background(Color.page)
                // Opened from a stop: scrolled to it once, so your stop is in view with the buses coming to it.
                // Not running, the note at the top says it all: no scrolling past it.
                .onChange(of: line?.here?.index) { _, i in
                    guard let i, !scrolled, line?.running != false else { return }
                    scrolled = true
                    withAnimation(.snappy) { proxy.scrollTo("s\(i)", anchor: UnitPoint(x: 0.5, y: 0.35)) }
                }
            }
        }
        .skyPull(pull, livery: (model.lines[key]?.color ?? model.color(svc)).flatMap(hexRGB), scene: { .hill($0) }) {
            await model.pullLine(svc, from: from)
        }
        .busRefreshing("line:\(key)") { await model.refreshLine(svc, from: from) }
        .skyPage(title: svc)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    MapModel.shared.show(svc)
                    NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.map)
                } label: {
                    Label(L("Show on map"), systemImage: "map").labelStyle(.titleAndIcon)
                }
                .accessibilityIdentifier("line-show-on-map")
            }
        }
    }

    /// The service and how many buses it has out, in the sky.
    private func heading(_ line: Line?, _ color: String?) -> some View {
        SkyHeading(svc: svc, line: line, color: color)
            .padding(.horizontal, 16)
            .padding(.top, 8)
    }

    @ViewBuilder private func content(_ line: Line?, _ color: String?, _ now: Date) -> some View {
        if let line, let st = Stopped.of(running: line.running, why: line.stopped, resumesAt: line.resumesAt, now: now) {
            // Not running: why and when it's back, over the stops (it has no buses to show).
            let (why, back) = st.lines
            VStack(alignment: .leading, spacing: 2) {
                Text(why).font(.headline)
                if let back { Text(back).foregroundStyle(Color.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.top, 14)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("line-stopped")
        }
        Divider().overlay(Color.line).padding(.top, 16)
        if let line {
            HStack {
                SectionLabel(L("%@ stops", "\(line.stops.count)"))
                Spacer()
                if let asOf = line.asOf {
                    Text(BusWords.updated(asOf, now: now)).font(.footnote).foregroundStyle(Color.muted).monospacedDigit()
                }
            }
            .padding(.top, 14)
            .padding(.bottom, 8)
            LineList(line: line, color: color, colors: model.campus?.colors ?? [:]) { code in
                model.path.append(.stop(code))
            }
            if line.here != nil && line.running {
                Text(L("Times are shown for your stop only.")).font(.footnote).foregroundStyle(Color.muted).padding(.top, 12)
            }
        } else {
            Text(model.lineFailed.contains(key) ? L("This service's line isn't available.") : L("Checking…"))
                .foregroundStyle(Color.muted)
                .padding(.vertical, 16)
        }
    }
}

private struct SkyHeading: View {
    let svc: String
    let line: Line?
    let color: String?
    @Environment(\.inks) private var inks

    var body: some View {
        HStack(spacing: 14) {
            BusChip(svc: svc, color: color, big: true)
            if let line {
                VStack(alignment: .leading, spacing: 2) {
                    Text(BusWords.running(line)).font(.title3.weight(.semibold)).foregroundStyle(inks.ink)
                    if let end = line.endsAt.flatMap(parseISODate) {
                        Text(L("Runs until %@", campusTime(end))).foregroundStyle(inks.muted)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("line-running")
            }
        }
    }
}

/// The line top to bottom in the service's colour: a node per stop, the buses on it at a stop or between two.
private struct LineList: View {
    let line: Line
    let color: String?
    let colors: [String: String]
    let onStop: (String) -> Void

    var body: some View {
        let items = BusLineItem.of(line)
        let rgb = color.flatMap(hexRGB) ?? 0x8A847E
        VStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                let first = i == 0
                let last = i == items.count - 1
                switch item {
                case .stop(_, let stop, let buses, let here):
                    Button {
                        onStop(stop.code)
                    } label: {
                        stopRow(stop, buses: buses, here: here)
                            .padding(.leading, 48)
                            .padding(.trailing, 10)
                            .padding(.vertical, 10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(alignment: .leading) {
                                Rail(rgb: rgb, first: first, last: last, bus: !buses.isEmpty, here: here).frame(width: 48)
                            }
                            .background(here ? Color.brandSoft : .clear, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(L("See this stop's buses"))
                    .accessibilityIdentifier("line-stop-\(stop.code)")
                    .id(item.id)
                case .between(_, let buses):
                    BusesOnLine(buses: buses, where: L("On the way"))
                        .padding(.leading, 48)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(alignment: .leading) {
                            Rail(rgb: rgb, first: false, last: last, bus: true, here: false).frame(width: 48)
                        }
                        .accessibilityElement(children: .combine)
                        .id(item.id)
                }
            }
        }
    }

    private func stopRow(_ stop: Line.Stop, buses: [Line.Bus], here: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: stop.name).font(.headline).foregroundStyle(Color.ink)
                    if !stop.services.isEmpty {
                        BusFlow(spacing: 4) {
                            ForEach(stop.services, id: \.self) { BusBadge(svc: $0, color: colors[$0], size: 10, even: true) }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if here, let row = line.here?.row, row.running { HereTime(row: row) }
            }
            if here { BusTag(text: L("Your stop"), color: .brand) }
            if !buses.isEmpty { BusesOnLine(buses: buses, where: L("At stop")) }
        }
    }
}

/// Your stop's time on the line, from its board row: the only time on the page.
private struct HereTime: View {
    let row: BoardRow
    var body: some View {
        VStack(alignment: .trailing, spacing: 2) {
            BusBigTime(etaS: row.etaS, quality: row.quality, eta: row.eta)
            BusQualityTag(row: row)
            if let t = BusWords.then(row) {
                Text(verbatim: t).font(.footnote).foregroundStyle(Color.muted).accessibilityLabel(spokenTimes(t))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The plates and how full each bus is.
private struct BusesOnLine: View {
    let buses: [Line.Bus]
    let `where`: String
    var body: some View {
        BusFlow(spacing: 6) {
            ForEach(buses) { b in
                if let plate = b.plate { Plate(text: plate) }
                if let c = busCrowdWord(b.crowd) { BusCrowdPill(text: c, packed: b.crowd == "high") }
            }
            Text(`where`).font(.footnote).foregroundStyle(Color.muted)
        }
    }
}

private struct Plate: View {
    let text: String
    var body: some View {
        Text(verbatim: text).font(.subheadline.weight(.bold)).tracking(0.5).foregroundStyle(Color.ink)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.line))
    }
}

/// The line's stretch beside one row: the line through it, and its stop's node or a bus.
private struct Rail: View {
    let rgb: UInt32
    let first: Bool
    let last: Bool
    let bus: Bool
    let here: Bool

    var body: some View {
        let color = Color(rgb: rgb)
        return ZStack {
            Canvas { g, size in
                let x = size.width / 2
                let y = size.height / 2
                var p = Path()
                p.move(to: CGPoint(x: x, y: first ? y : 0))
                p.addLine(to: CGPoint(x: x, y: last ? y : size.height))
                g.stroke(p, with: .color(color), lineWidth: 6)
                if !bus {
                    if here {
                        g.fill(
                            Path(ellipseIn: CGRect(x: x - 13, y: y - 13, width: 26, height: 26)), with: .color(Color.brand.opacity(0.25)))
                    }
                    let node = CGRect(x: x - 7, y: y - 7, width: 14, height: 14)
                    g.fill(Path(ellipseIn: node), with: .color(.surface))
                    g.stroke(Path(ellipseIn: node.insetBy(dx: 1.5, dy: 1.5)), with: .color(color), lineWidth: 3)
                }
            }
            if bus {
                Image(systemName: "bus.fill")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(inkOn(rgb))
                    .frame(width: 28, height: 28)
                    .background(color, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.surface, lineWidth: 2))
            }
        }
        .accessibilityHidden(true)
    }
}

/// Views in rows, wrapping onto the next when the width runs out.
struct BusFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(proposal.width ?? .infinity, subviews)
        let w = rows.map(\.width).max() ?? 0
        let h = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(bounds.width, subviews) {
            var x = bounds.minX
            for i in row.items {
                let s = subviews[i].sizeThatFits(.unspecified)
                subviews[i].place(at: CGPoint(x: x, y: y + (row.height - s.height) / 2), proposal: ProposedViewSize(s))
                x += s.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for (i, v) in subviews.enumerated() {
            let s = v.sizeThatFits(.unspecified)
            let extra = rows[rows.count - 1].items.isEmpty ? s.width : rows[rows.count - 1].width + spacing + s.width
            if extra > width, !rows[rows.count - 1].items.isEmpty {
                rows.append(Row(items: [i], width: s.width, height: s.height))
            } else {
                rows[rows.count - 1].items.append(i)
                rows[rows.count - 1].width = extra
                rows[rows.count - 1].height = max(rows[rows.count - 1].height, s.height)
            }
        }
        return rows
    }
}
