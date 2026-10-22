import SwiftUI
import WidgetKit

/// A Buses near you widget at one moment: on the Home Screen the hour's sky
/// with the stop's name and the time now, then the buses by its size
/// (NearbyFit); on the Lock Screen, the next two buses plainly.
struct NearbyWidgetView: View {
    let entry: NearbyEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let v = entry.model
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
        .widgetURL(URL(string: entry.paired ? "terminus://nearby" : "terminus://plan"))
        .containerBackground(for: .widget) { family.isAccessory ? Color.clear : look.page }
    }
}

private let pad: CGFloat = 14
/// The sky over the buses: the line above (Now, the walk, ↻) and the stop's name.
private let skyH: CGFloat = 72
/// Wide enough for a badge and the gap after it ("R1"; a public bus's "95 $" a little over).
private let badgeW: CGFloat = 36
/// The biggest a tile grows: past this, the room is better spent on the next stop's buses.
private let tileMax: CGFloat = 128
private let stopHead: CGFloat = 24

/// Nearby, at any size: the nearest stop's services, each with its badge,
/// the time it's due as a clock time (and its minutes under 15), its next
/// stop, the buses after it, Live and how full. Both sides of the road where
/// there's a stop beside yours and room for them, under a slimmer sky.
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

/// The sky with the stop's name and Now, then the buses under it: both sides, rows, or tiles.
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
        // The moon clear of the words: right of the stop's name where it's wide; none in the slim sky over both sides.
        let moon = w >= 300 && beside == nil ? CGPoint(x: 110, y: 20) : CGPoint(x: -100, y: -100)
        // The stop across the road a tap away, unless it's shown already.
        let other = beside == nil ? v.first.flatMap { WidgetSwap.offer(v.all ?? [], v.swap, now: v.now, onScreen: [$0.stop.code]) } : nil
        let area = h - skyH
        let message = v.problem(buses + besideBuses)
        // The small square: the stop's short name, and Now without the walk, so neither is cut short.
        let narrow = w < 220
        ZStack(alignment: .topLeading) {
            SkyBackdrop(look: look, height: skyH, scale: 15 / 92, road: Road(stop: true, shuttle: false), moon: moon)
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    if beside != nil {
                        // Slim: the stop's name, Now and ↻ on one line; each side says how far it is.
                        HStack(spacing: 6) {
                            Text(verbatim: v.title).font(.system(size: 17, weight: .bold)).foregroundStyle(sky.ink).lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            HeadWords(v: v, buses: buses + besideBuses, inks: sky, walk: false)
                            if v.refresh { RefreshButton(slot: v.slot, inks: sky, side: 24) }
                        }
                        .frame(height: 30)
                    } else {
                        HStack(spacing: 6) {
                            HeadWords(v: v, buses: buses, inks: sky, walk: !narrow).frame(maxWidth: .infinity, alignment: .leading)
                            if let other, let slot = v.slot, let nearest = v.all?.first {
                                NearbySwapButton(slot: slot, from: nearest.stop.code, other: other, inks: sky, side: 24)
                            }
                            if v.refresh { RefreshButton(slot: v.slot, inks: sky, side: 24) }
                        }
                        .frame(height: 30)
                        Text(verbatim: narrow ? v.shortTitle : v.title).font(.system(size: 18, weight: .bold)).foregroundStyle(sky.ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
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

/// The line above the stop's name: "Now 9:41 · 2 min walk"; "Times may be
/// old · 9:39" once they are; "Updating…" or the last fetch's problem.
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

/// "Now 9:41", which WidgetKit keeps ticking by itself, in campus time and
/// the account's 12- or 24-hour style, as the bus times beside it.
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

/// Both sides of the road, a column each: your stop (or this side) and the
/// one beside it (across the road, or the next stop), each service a row with
/// the time it's due, up to `rows`. Which side a bus is on says which way it
/// goes. New to NUS heads each side with the places its buses go and gives
/// each bus the places it passes, Live or Scheduled in words, and Packed;
/// otherwise each row is the badge, the time and the bus after.
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
            // Under the sky's full name, each side goes by its short one ("PGP Foyer", "PGP").
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

    /// One side: its heading ("Across the road · 1 min walk"), where its buses go with New to NUS, then a row a bus.
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

    /// A bus on its side of the road: its badge, the time it's due, and its minutes or the one after.
    private func plain(_ b: StopBus) -> some View {
        HStack(spacing: 0) {
            Badge(b: b, size: 12).frame(width: badgeW, alignment: .leading)
            TimeText(v: v, b: b, inks: inks, size: 15)
            Spacer(minLength: 4)
            if let left = v.minutes(b) {
                // The bus after makes way for how long until this one.
                MinutesChip(b: b, left: left, inks: inks, size: 11)
            } else if let next = b.later.first {
                small(v.clock(next), inks.muted, 11)
            }
        }
        .frame(height: NearbyFit.sideRow)
    }

    /// New to NUS: a bus, its time and how long until it; under them, the
    /// places it passes (where it stops next when it passes none), then Live
    /// or Scheduled, or Packed (only a live bus says how full it is).
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

/// Narrow widgets: a service a row, its next stop over the buses after it, its time at the end with its minutes under it.
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
                HStack(spacing: 6) {
                    Badge(b: b, size: 12).frame(width: 34, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        small(v.nextLine(b, buses), inks.ink, 13, bold: true)
                        if !b.later.isEmpty || b.first { small(v.subLine(b), inks.muted, 11) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .trailing, spacing: 1) {
                        TimeText(v: v, b: b, inks: inks, size: 17)
                        if let left = v.minutes(b) { MinutesChip(b: b, left: left, inks: inks, size: 10) }
                    }
                }
                .frame(height: rowH)
            }
        }
        .padding(.horizontal, pad)
    }
}

/// The stop's services as tiles, `fit.cols` across, and the rest along the
/// bottom. Rows a stop with few services leaves empty go to the next stop's,
/// under its name.
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
        // Spare rows: the next stop with buses, as many as fit under its name
        // without squeezing a tile much below its smallest.
        let spare = min(fit.rows - rows, Int((room - stopHead) / (NearbyFit.tile(cols) - 4)) - rows)
        let next: (NearbyStop, [StopBus])? =
            spare > 0 && rest.isEmpty
            ? v.stops?.dropFirst().lazy.compactMap { st -> (NearbyStop, [StopBus])? in
                let more = v.busesAt(st)
                return more.isEmpty ? nil : (st, Array(more.prefix(spare * cols)))
            }.first : nil
        let nextRows = next.map { ($0.1.count + cols - 1) / cols } ?? 0
        // The 1 pt rules between rows count too.
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

/// A row of tiles, `cols` across, the rule between them; an empty cell where there's no bus.
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

/// One service: its badge and the time it's due, its minutes or the next bus
/// beside it, its next stop over up to two lines, and Live and how full.
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

/// Live or Scheduled, and how full; or which first bus it is.
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

/// "Seats", "Busy", "Packed", in the colour that goes with each.
func crowdWords(_ crowd: String?, _ inks: Inks) -> (String, Color)? {
    switch crowd {
    case "low": (L("Seats"), inks.good)
    case "medium": (L("Busy"), inks.muted)
    case "high": (L("Packed"), inks.late)
    default: nil
    }
}

/// The time a bus is due, big: "9:42", "~9:48" for a timetable's guess; muted once the times may be old.
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

/// How long until a bus, `left` whole minutes: "6 min", "~6 min" for a timetable's time, "now" in its last minute.
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

/// A rule between two columns, `inset` short of each end.
struct VRule: View {
    let inks: Inks
    let inset: CGFloat

    var body: some View { Rectangle().fill(inks.line).frame(width: 1).padding(.vertical, inset) }
}

struct HRule: View {
    let inks: Inks

    var body: some View { Rectangle().fill(inks.line).frame(height: 1).padding(.horizontal, 12) }
}

/// Shows the stop across the road first, or the nearest one again.
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

/// The nearest stop's services two by two under a heading, `rows` of them:
/// the large widget's next buses, under its trip. With no `rows`, where a
/// trip leaves no room for tiles, a line of the next three. The heading says
/// when the times may be old, as Buses near you's line above does.
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

/// Buses side by side on one line, each its badge, time and minutes, as
/// many as fit: where there's no room for more.
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

/// The Lock Screen: the stop, then its next two buses with their minutes, or why there are none.
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
