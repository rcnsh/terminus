import SwiftUI
import WidgetKit

struct NearbyWidgetView: View {
    let entry: NearbyEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let waiting = Self.waiting(entry)
        let v = Self.shown(entry, family: family).model
        let look = WidgetLook(date: entry.date, dark: scheme == .dark)
        Group {
            if family == .accessoryRectangular {
                NearbyRectangular(v: v)
            } else {
                GeometryReader { geo in
                    NearbyLayout(v: v, look: look, w: geo.size.width, h: geo.size.height, newcomer: entry.newcomer)
                        .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
                }
            }
        }
        .standingIn(waiting, spoken: L("Checking…"))
        .widgetURL(URL(string: entry.paired ? "terminus://nearby" : "terminus://plan"))
        .containerBackground(for: .widget) { family.isAccessory ? Color.clear : look.page }
    }

    static func waiting(_ entry: NearbyEntry) -> Bool {
        entry.paired && !entry.sample && (entry.stops?.isEmpty ?? true) && entry.error == WidgetFace.updating
    }

    static func shown(_ entry: NearbyEntry, family: WidgetFamily) -> NearbyEntry {
        guard waiting(entry) else { return entry }
        var e = entry
        e.stops = NearbyProvider.sampleEntry(family: family).stops
        e.fetchedAt = entry.date
        e.error = nil
        e.standIn = true
        return e
    }
}

private let pad: CGFloat = 14
private let skyH: CGFloat = 72
private let badgeW: CGFloat = 36
private let tileMax: CGFloat = 128
private let stopHead: CGFloat = 24

struct NearbyLayout: View {
    let v: NearbyModel
    let look: WidgetLook
    let w: CGFloat, h: CGFloat
    let newcomer: Bool

    var body: some View {
        let beside = v.stops.flatMap { NearbyBoard.beside($0) { v.busesAt($0) } }
        let sides = beside.flatMap { _ in NearbyFit.sides(width: w, height: h, sky: NearbyFit.sidesSky, newcomer: newcomer) }
        let sky = sides != nil ? NearbyFit.sidesSky : skyH
        let fit = sides ?? NearbyFit.of(width: w, height: h, sky: sky)
        NearbySky(v: v, look: look, w: w, h: h, skyH: sky, fit: fit, beside: sides != nil ? beside : nil, newcomer: newcomer)
    }
}

private struct NearbySky: View {
    let v: NearbyModel
    let look: WidgetLook
    let w: CGFloat, h: CGFloat
    let skyH: CGFloat
    let fit: NearbyFit
    let beside: NearbyStop?
    let newcomer: Bool

    var body: some View {
        let sky = look.sky
        let ground = look.ground
        let buses = v.buses
        let besideBuses = beside.map { v.busesAt($0) } ?? []
        let moon = w >= 300 && beside == nil ? CGPoint(x: 110, y: 20) : CGPoint(x: -100, y: -100)
        let other = beside == nil ? v.first.flatMap { WidgetSwap.offer(v.all ?? [], v.swap, now: v.now, onScreen: [$0.stop.code]) } : nil
        let area = h - skyH
        let message = v.problem(buses + besideBuses)
        let narrow = w < 220
        ZStack(alignment: .topLeading) {
            SkyBackdrop(look: look, height: skyH, scale: 15 / 92, road: Road(stop: true, shuttle: false), moon: moon)
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    if beside != nil {
                        HStack(spacing: 6) {
                            Text(verbatim: v.title).font(.system(size: 17, weight: .bold)).foregroundStyle(sky.ink).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .standInHidden()
                            HeadWords(v: v, buses: buses + besideBuses, inks: sky, walk: false).standInHidden()
                            if v.refresh { RefreshButton(slot: v.slot, inks: sky, side: 24) }
                        }
                        .frame(height: 30)
                    } else {
                        HStack(spacing: 6) {
                            HeadWords(v: v, buses: buses, inks: sky, walk: !narrow).frame(maxWidth: .infinity, alignment: .leading)
                                .standInHidden()
                            if let other, let slot = v.slot, let nearest = v.all?.first, !v.standIn {
                                NearbySwapButton(slot: slot, from: nearest.stop.code, other: other, inks: sky, side: 24)
                            }
                            if v.refresh { RefreshButton(slot: v.slot, inks: sky, side: 24) }
                        }
                        .frame(height: 30)
                        Text(verbatim: narrow ? v.shortTitle : v.title).font(.system(size: 18, weight: .bold)).foregroundStyle(sky.ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .standInHidden()
                    }
                }
                .padding(.horizontal, pad)
                .padding(.top, 4)
                .frame(height: skyH, alignment: .topLeading)
                Group {
                    if let message {
                        Text(verbatim: message).font(.system(size: 15, weight: .medium)).foregroundStyle(ground.muted)
                            .multilineTextAlignment(.center).lineLimit(3)
                            .frame(maxWidth: .infinity).frame(height: max(0, area - 8)).padding(.horizontal, pad)
                    } else if let beside {
                        NearbySides(
                            v: v, beside: beside, buses: buses, besideBuses: besideBuses, rows: fit.rows, inks: ground, newcomer: newcomer)
                    } else if fit.kind == .tiles {
                        NearbyTiles(v: v, buses: buses, fit: fit, inks: ground, area: area)
                    } else {
                        NearbyRows(v: v, buses: Array(buses.prefix(fit.rows)), inks: ground, area: area)
                    }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(v.spoken)
                Spacer(minLength: 0)
            }
        }
        .accessibilityElement(children: .contain)
    }
}

private struct HeadWords: View {
    let v: NearbyModel
    let buses: [StopBus]
    let inks: Inks
    let walk: Bool

    var body: some View {
        if v.error == WidgetFace.updating {
            small(L("Updating…"), inks.muted, 12)
        } else if let e = v.error, !buses.isEmpty {
            small(e, inks.late, 12)
        } else if v.old, !buses.isEmpty, let at = v.fetchedAt {
            small(L("Times may be old · %@", v.clock(at)), inks.late, 12)
        } else if let first = v.first {
            HStack(spacing: 0) {
                NowClock(inks: inks)
                if walk { small(" · " + NearbyModel.walk(first), inks.muted, 12) }
            }
        } else {
            small(L("Nearby"), inks.muted, 12)
        }
    }
}

struct NowClock: View {
    let inks: Inks
    var size: CGFloat = 12

    var body: some View {
        (Text(verbatim: L("Now") + " ").foregroundColor(inks.muted) + Text(Date(), style: .time).foregroundColor(inks.ink))
            .font(.system(size: size, weight: .medium))
            .lineLimit(1)
            .environment(\.timeZone, .campus)
            .environment(\.locale, Locale(identifier: (Lang.zh ? "zh-Hans" : "en") + (Clock.hour12 ? "-u-hc-h12" : "-u-hc-h23")))
    }
}

private struct NearbySides: View {
    let v: NearbyModel
    let beside: NearbyStop
    let buses: [StopBus]
    let besideBuses: [StopBus]
    let rows: Int
    let inks: Inks
    let newcomer: Bool

    var body: some View {
        if let first = v.first {
            let across = first.opposite == beside.stop.code && first.oppositeAcross
            HStack(alignment: .top, spacing: 0) {
                side(
                    head: across ? L("This side") : first.stop.name, sub: across ? first.stop.name : NearbyModel.walk(first), stop: first,
                    shown: Array(buses.prefix(rows)))
                VRule(inks: inks, inset: 4)
                side(
                    head: across ? L("Across the road") : beside.stop.name, sub: NearbyModel.walk(beside), stop: beside,
                    shown: Array(besideBuses.prefix(rows)))
            }
            .padding(.top, 2)
        }
    }

    private func side(head: String, sub: String, stop: NearbyStop, shown: [StopBus]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Text(verbatim: head).font(.system(size: 11, weight: .bold)).foregroundStyle(inks.ink).lineLimit(1).layoutPriority(1)
                Text(verbatim: " · \(sub)").font(.system(size: 10)).foregroundStyle(inks.muted).lineLimit(1)
            }
            .frame(height: 18)
            if newcomer { small(stop.viaText ?? "", inks.muted, 10).frame(height: 14) }
            if shown.isEmpty {
                small(stop.available ? L("No buses due") : L("No live data"), inks.muted, 12).padding(.top, 6)
            } else {
                ForEach(Array(shown.enumerated()), id: \.offset) { i, b in
                    if i > 0 { Rectangle().fill(inks.line).frame(height: 1) }
                    if newcomer { explained(b, shown) } else { plain(b) }
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func plain(_ b: StopBus) -> some View {
        HStack(spacing: 0) {
            Badge(b: b, size: 12).frame(width: badgeW, alignment: .leading)
            TimeText(v: v, b: b, inks: inks, size: 15)
            Spacer(minLength: 4)
            if let left = v.minutes(b) {
                MinutesChip(b: b, left: left, inks: inks, size: 11)
            } else if let next = b.later.first {
                small(v.clock(next), inks.muted, 11)
            }
        }
        .frame(height: NearbyFit.sideRow)
    }

    private func explained(_ b: StopBus, _ shown: [StopBus]) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 0) {
                Badge(b: b, size: 11).frame(width: badgeW, alignment: .leading)
                TimeText(v: v, b: b, inks: inks, size: 13)
                if let left = v.minutes(b) { MinutesChip(b: b, left: left, inks: inks, size: 10).padding(.leading, 6) }
                Spacer(minLength: 0)
            }
            HStack(spacing: 0) {
                small(b.via.isEmpty ? v.nextLine(b, shown) : b.via.joined(separator: " · "), inks.ink, 10, bold: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if b.first {
                    small(" " + v.firstLabel(b), inks.muted, 10)
                } else if b.crowd == "high" {
                    small(" " + L("Packed"), inks.late, 10, bold: true)
                } else if b.live {
                    small(" ● " + L("Live"), inks.good, 10)
                } else {
                    small(" " + L("Estimate"), inks.muted, 10)
                }
            }
        }
        .frame(height: NearbyFit.sideRowNew)
    }
}

private struct NearbyRows: View {
    let v: NearbyModel
    let buses: [StopBus]
    let inks: Inks
    let area: CGFloat

    var body: some View {
        let rowH = min(area / CGFloat(max(buses.count, 1)), 48)
        VStack(spacing: 0) {
            ForEach(Array(buses.enumerated()), id: \.offset) { i, b in
                if i > 0 { Rectangle().fill(inks.line).frame(height: 1) }
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Badge(b: b, size: 12)
                        TimeText(v: v, b: b, inks: inks, size: 17)
                        Spacer(minLength: 0)
                        if let left = v.minutes(b) { MinutesChip(b: b, left: left, inks: inks, size: 10) }
                    }
                    if b.first {
                        small(v.firstLabel(b), inks.muted, 12)
                    } else {
                        small(v.nextLine(b, buses), inks.ink, 12, bold: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: rowH)
            }
        }
        .padding(.horizontal, pad)
    }
}

private struct NearbyTiles: View {
    let v: NearbyModel
    let buses: [StopBus]
    let fit: NearbyFit
    let inks: Inks
    let area: CGFloat

    var body: some View {
        let cols = fit.cols
        let rows = min(fit.rows, (buses.count + cols - 1) / cols)
        let rest = Array(buses.dropFirst(rows * cols))
        let foot = fit.footer && !rest.isEmpty ? NearbyFit.footerH : 0
        let room = area - NearbyFit.bottom
        let spare = min(fit.rows - rows, Int((room - stopHead) / (NearbyFit.tile(cols) - 4)) - rows)
        let next: (NearbyStop, [StopBus])? =
            spare > 0 && rest.isEmpty
            ? v.stops?.dropFirst().lazy.compactMap { st -> (NearbyStop, [StopBus])? in
                let more = v.busesAt(st)
                return more.isEmpty ? nil : (st, Array(more.prefix(spare * cols)))
            }.first : nil
        let nextRows = next.map { ($0.1.count + cols - 1) / cols } ?? 0
        let rules = CGFloat(max(rows - 1, 0) + max(nextRows - 1, 0))
        let tileH = min((room - foot - rules - (next != nil ? stopHead : 0)) / CGFloat(max(rows + nextRows, 1)), tileMax)
        let shown = Array(buses.prefix(rows * cols))
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<rows, id: \.self) { r in
                if r > 0 { HRule(inks: inks) }
                TileRow(v: v, row: Array(shown.dropFirst(r * cols).prefix(cols)), shown: shown, cols: cols, inks: inks, height: tileH)
            }
            if foot > 0 {
                HStack(spacing: 10) {
                    ForEach(Array(rest.prefix(4).enumerated()), id: \.offset) { _, b in
                        HStack(spacing: 4) {
                            Badge(b: b, size: 11)
                            Text(verbatim: v.timeText(b)).font(.system(size: 12)).foregroundStyle(v.old ? inks.muted : inks.ink).lineLimit(
                                1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .frame(height: NearbyFit.footerH)
                .padding(.horizontal, pad)
            }
            if let (stop, more) = next {
                small("\(stop.stop.longName ?? stop.stop.name) · \(NearbyModel.walk(stop))", inks.muted, 12, bold: true)
                    .frame(maxWidth: .infinity, alignment: .bottomLeading).frame(height: stopHead).padding(.horizontal, pad)
                ForEach(0..<nextRows, id: \.self) { r in
                    if r > 0 { HRule(inks: inks) }
                    TileRow(v: v, row: Array(more.dropFirst(r * cols).prefix(cols)), shown: more, cols: cols, inks: inks, height: tileH)
                }
            }
        }
    }
}

struct TileRow: View {
    let v: NearbyModel
    let row: [StopBus]
    let shown: [StopBus]
    let cols: Int
    let inks: Inks
    let height: CGFloat

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<cols, id: \.self) { i in
                if i > 0 { VRule(inks: inks, inset: 8) }
                Group {
                    if i < row.count { NearbyTile(v: v, b: row[i], shown: shown, inks: inks, big: cols < 3) } else { Color.clear }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(height: height)
    }
}

private struct NearbyTile: View {
    let v: NearbyModel
    let b: StopBus
    let shown: [StopBus]
    let inks: Inks
    let big: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Badge(b: b, size: 14)
                TimeText(v: v, b: b, inks: inks, size: big ? 24 : 21)
                Spacer(minLength: 0)
                if let left = v.minutes(b) {
                    MinutesChip(b: b, left: left, inks: inks, size: 11)
                } else if big, let next = b.later.first {
                    VStack(alignment: .trailing, spacing: 0) {
                        small(L("then"), inks.muted, 10)
                        small(v.clock(next), inks.muted, 10)
                    }
                }
            }
            Text(verbatim: v.nextLine(b, shown)).font(.system(size: 13, weight: .medium)).foregroundStyle(inks.ink).lineLimit(2)
                .padding(.top, 2)
            if !big && !b.later.isEmpty { small(v.laterLine(b), inks.muted, 11) }
            Spacer(minLength: 0)
            NearbyPills(v: v, b: b, inks: inks)
        }
        .padding(.horizontal, 10)
        .padding(.top, 6)
        .padding(.bottom, 3)
    }
}

struct NearbyPills: View {
    let v: NearbyModel
    let b: StopBus
    let inks: Inks

    var body: some View {
        if b.first {
            PillView(pill: WidgetPill(text: v.firstLabel(b), good: false), inks: inks)
        } else {
            HStack(spacing: 4) {
                PillView(pill: b.live ? WidgetPill(text: L("Live"), good: true) : WidgetPill(text: L("Estimate"), good: false), inks: inks)
                if let crowd = crowdWords(b.crowd, inks) {
                    Text(verbatim: crowd.0).font(.system(size: 11, weight: .medium)).foregroundStyle(crowd.1).lineLimit(1)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(inks.chip ?? inks.raised, in: Capsule())
                }
            }
        }
    }
}

func crowdWords(_ crowd: String?, _ inks: Inks) -> (String, Color)? {
    switch crowd {
    case "low": (L("Seats"), inks.good)
    case "medium": (L("Busy"), inks.muted)
    case "high": (L("Packed"), inks.late)
    default: nil
    }
}

struct TimeText: View {
    let v: NearbyModel
    let b: StopBus
    let inks: Inks
    let size: CGFloat

    var body: some View {
        Text(verbatim: v.timeText(b)).font(.system(size: size, weight: .bold)).monospacedDigit()
            .foregroundStyle(v.old ? inks.muted : inks.ink).lineLimit(1).fixedSize()
    }
}

struct MinutesChip: View {
    let b: StopBus
    let left: Int
    let inks: Inks
    let size: CGFloat

    var body: some View {
        Text(verbatim: NearbyBoard.minutesText(left, live: b.live))
            .font(.system(size: size, weight: left == 0 ? .bold : .medium)).monospacedDigit()
            .foregroundStyle(left == 0 ? inks.good : inks.ink).lineLimit(1).fixedSize()
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(inks.chip ?? inks.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

private struct Badge: View {
    let b: StopBus
    let size: CGFloat

    var body: some View { BusBadge(svc: b.svc, color: b.color, size: size, paid: b.paid) }
}

struct VRule: View {
    let inks: Inks
    let inset: CGFloat

    var body: some View { Rectangle().fill(inks.line).frame(width: 1).padding(.vertical, inset) }
}

struct HRule: View {
    let inks: Inks

    var body: some View { Rectangle().fill(inks.line).frame(height: 1).padding(.horizontal, 12) }
}

struct NearbySwapButton: View {
    let slot: String
    let from: String
    let other: NearbyStop
    let inks: Inks
    var side: CGFloat = 28

    var body: some View {
        Button(intent: SwapIntent(slot: slot, from: from, to: other.stop.code)) {
            Image(systemName: "arrow.left.arrow.right").font(.system(size: side * 0.43, weight: .semibold)).foregroundStyle(inks.ink)
                .frame(width: side, height: side).background(inks.chip ?? inks.raised, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Show %@ first", other.stop.name))
    }
}

struct NearbyPair: View {
    static let head: CGFloat = 22
    static let tile: CGFloat = 106
    static let line: CGFloat = 28

    let v: NearbyModel
    let inks: Inks
    var rows = 1

    var body: some View {
        let buses = Array(v.buses.prefix(rows == 0 ? 3 : 2 * rows))
        if let first = v.first, !buses.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                small(
                    v.old
                        ? L("Times may be old · %@", v.clock(v.fetchedAt ?? v.now))
                        : L("Next buses · %@", first.stop.longName ?? first.stop.name),
                    v.old ? inks.late : inks.muted, 11, bold: true
                )
                .frame(height: Self.head, alignment: .bottomLeading)
                if rows == 0 { NearbyLine(v: v, buses: buses, inks: inks).frame(height: Self.line) }
                ForEach(0..<(buses.count + 1) / 2, id: \.self) { r in
                    if rows > 0 {
                        if r > 0 { HRule(inks: inks) }
                        TileRow(v: v, row: Array(buses.dropFirst(r * 2).prefix(2)), shown: buses, cols: 2, inks: inks, height: Self.tile)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(v.spoken)
        }
    }
}

struct NearbyLine: View {
    let v: NearbyModel
    let buses: [StopBus]
    let inks: Inks

    var body: some View {
        ViewThatFits(in: .horizontal) {
            ForEach(Array(stride(from: buses.count, to: 0, by: -1)), id: \.self) { n in line(Array(buses.prefix(n))) }
        }
    }

    private func line(_ shown: [StopBus]) -> some View {
        HStack(spacing: 14) {
            ForEach(Array(shown.enumerated()), id: \.offset) { _, b in
                HStack(spacing: 5) {
                    Badge(b: b, size: 12)
                    TimeText(v: v, b: b, inks: inks, size: 15)
                    if let left = v.minutes(b) { MinutesChip(b: b, left: left, inks: inks, size: 10) }
                }
                .fixedSize()
            }
            Spacer(minLength: 0)
        }
    }
}

private struct NearbyRectangular: View {
    let v: NearbyModel

    var body: some View {
        let buses = v.buses
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: v.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            if let problem = v.problem(buses) {
                Text(verbatim: problem).font(.system(size: 14, weight: .medium)).lineLimit(2)
            } else {
                ForEach(Array(buses.prefix(2).enumerated()), id: \.offset) { _, b in
                    HStack(spacing: 5) {
                        Text(verbatim: b.svc).font(.system(size: 12, weight: .heavy)).padding(.horizontal, 4)
                            .background(RoundedRectangle(cornerRadius: 4).strokeBorder(lineWidth: 1))
                        Text(verbatim: v.timeText(b)).font(.system(size: 15, weight: .bold)).monospacedDigit()
                        if b.first {
                            Text(verbatim: v.firstLabel(b)).font(.system(size: 12)).lineLimit(1)
                        } else if let left = v.minutes(b) {
                            Text(verbatim: NearbyBoard.minutesText(left, live: b.live)).font(.system(size: 13)).lineLimit(1)
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(v.spoken)
    }
}
