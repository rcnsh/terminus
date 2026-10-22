import SwiftUI
import WidgetKit

/// A widget at one moment, drawn as Now is: the hour's sky over the top with
/// the campus's hills, your stop and your bus on the horizon. It lays itself
/// out by its size: a small square counting to the time to leave, the trip
/// across a medium one, and on a large one your day: the trip's steps and
/// what's left of today. On the Lock Screen, the same words plainly.
struct BusWidgetView: View {
    let entry: BusEntry
    let kind: String
    @Environment(\.widgetFamily) private var family
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let s = Scene(entry: entry, kind: kind, family: family, dark: scheme == .dark)
        Group {
            switch family {
            case .accessoryRectangular: RectangularView(s: s)
            case .accessoryCircular: CircularView(s: s)
            case .accessoryInline: InlineView(s: s)
            default:
                GeometryReader { geo in
                    let w = geo.size.width
                    let h = geo.size.height
                    let sc = s.withChips(width: w)
                    Group {
                        if sc.mode == .nearby {
                            BoardLayout(s: sc, w: w, h: h)
                        } else if family == .systemSmall {
                            SquareLayout(s: sc, w: w, h: h)
                        } else if family == .systemLarge {
                            DayLayout(s: sc, w: w, h: h)
                        } else {
                            TripLayout(s: sc, w: w, h: h)
                        }
                    }
                    .frame(width: w, height: h, alignment: .topLeading)
                }
            }
        }
        .widgetURL(s.link)
        .containerBackground(for: .widget) { family.isAccessory ? Color.clear : s.look.page }
    }
}

extension WidgetFamily {
    var isAccessory: Bool { self == .accessoryCircular || self == .accessoryInline || self == .accessoryRectangular }
}

/// Everything a layout needs, worked out once.
struct Scene {
    let entry: BusEntry
    let look: WidgetLook
    let slot: String?
    var chips: [WidgetMode] = []
    var mode: WidgetMode = .timetable
    var answer: NextAnswer?
    var face: WidgetFace
    /// The card style chosen in Settings: steps or route.
    let style: String

    init(entry: BusEntry, kind: String, family: WidgetFamily, dark: Bool) {
        self.entry = entry
        look = WidgetLook(date: entry.date, dark: dark)
        slot = entry.slotID
        style = Shared.defaults.string(forKey: "cardStyle") ?? "steps"
        answer = entry.plan
        face = WidgetFace.of(paired: entry.paired, mode: .timetable, answer: nil, error: nil, offline: nil, now: entry.serverNow)
        apply()
    }

    /// The chips for a widget `width` across (the large one shares its row with ↻), and what's shown by them.
    func withChips(width: CGFloat) -> Scene {
        guard entry.paired, slot != nil, !entry.sample else { return self }
        var s = self
        s.chips = WidgetMode.chips(places: entry.plan?.places ?? [], added: entry.added, width: width - 28 - 40)
        s.apply()
        return s
    }

    private mutating func apply() {
        let now = entry.serverNow
        mode = WidgetMode.effective(
            entry.slot?.chosen ?? .timetable, at: entry.slot?.at, plan: entry.plan, rowShown: !chips.isEmpty, now: now)
        let onTimetable = mode == .timetable
        if case .to = mode { answer = entry.slot?.answer } else { answer = onTimetable ? entry.plan : nil }
        let error = onTimetable ? entry.error : entry.slot?.error
        // Offline (the last refresh failed) with the plan gone stale, or none
        // kept: the next thing on the day plan kept for it.
        var offline: OfflineDay.Pick?
        if onTimetable, entry.paired, let e = error, e != WidgetFace.updating, answer.map({ WidgetFace.isOld($0, now: now) }) ?? true {
            offline = OfflineDay.next(entry.day, now: now)
        }
        face = WidgetFace.of(paired: entry.paired, mode: mode, answer: answer, error: error, offline: offline, now: now)
    }

    var link: URL { entry.paired ? mode.link : URL(string: "terminus://plan")! }

    /// The shared board of buses near you as this widget shows it: its own
    /// swap, and `error` (Nearby's last fetch; none under the trip).
    func nearbyModel(error: String?) -> NearbyModel {
        NearbyModel(
            paired: entry.paired, all: entry.nearby, swap: entry.slot?.swap, fetchedAt: entry.nearbyAt, error: error, now: entry.date,
            skew: ServerClock.skew, slot: slot, refresh: refresh)
    }
    var refresh: Bool { entry.paired && !entry.sample }
    /// The words on the chosen chip over the sky, and on the ground.
    var onChosenSky: Color { look.palette.lightInk ? Color(rgb: 0x1C1917) : Color(rgb: 0xFAFAF9) }

    /// What VoiceOver says for the widget, as one sentence rather than fragments.
    var spoken: String {
        if mode == .nearby { return nearbyModel(error: entry.slot?.error).spoken }
        if let a = answer, entry.paired, !WidgetFace.isOld(a, now: entry.serverNow) { return Spoken.summary(a, now: entry.serverNow) }
        return Spoken.sentences(face.heading, face.headline, face.sub)
    }
}

private let pad: CGFloat = 14

/// The line above the headline, with ↻ at its end.
private struct HeadRow: View {
    let text: String?
    let s: Scene
    let inks: Inks
    var side: CGFloat = 26

    var body: some View {
        HStack(spacing: 6) {
            small(text ?? "", inks.muted, 12, bold: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if s.refresh { RefreshButton(slot: s.slot, inks: inks, side: side) }
        }
        .frame(height: side + 6)
    }
}

/// Under the headline: what it gets you ("Arrive 9:52"), with how sure its time is.
private struct SubLine: View {
    let s: Scene
    let inks: Inks
    var withSub = true

    var body: some View {
        let f = s.face
        HStack(spacing: 6) {
            if withSub, let sub = f.sub {
                small(sub, inks.muted, 12)
            }
            if let pill = f.pill { PillView(pill: pill, inks: inks).layoutPriority(1) }
            Spacer(minLength: 0)
        }
    }
}

/// The small square: the time to leave, big, with what it is ("Leave by");
/// the countdown; the hills; then the bus and its stop along the ground.
struct SquareLayout: View {
    let s: Scene
    let w: CGFloat, h: CGFloat

    var body: some View {
        let f = s.face
        let sky = s.look.sky
        let footH: CGFloat = 30
        let skyH = h - footH - 2
        let strip = min(max(skyH * 0.3, 24), 40)
        let color = f.dim ? sky.muted : f.late ? sky.late : sky.ink
        // The bus and where to catch it; else the leg's words, or the next class.
        let foot =
            f.journey?.bus.map { WidgetLeg(svc: $0.svc, color: $0.color, paid: $0.paid, text: "\($0.stop) \($0.board)") } ?? f.leg
            ?? f.tile.map { WidgetLeg(text: $0.title) }
        // Narrow: where you're going, short ("GEA1000"), when the headline has no label of its own.
        let head = f.big != nil && !f.bigFirst ? f.bigLabel : f.tile?.label ?? f.journey?.place ?? f.heading
        ZStack(alignment: .topLeading) {
            SkyBackdrop(look: s.look, height: skyH, scale: strip / 92, road: f.road, moon: CGPoint(x: 28, y: 92))
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HeadRow(text: head, s: s, inks: sky, side: 24)
                    if let big = f.big {
                        HStack(alignment: .lastTextBaseline, spacing: 4) {
                            Text(verbatim: big).font(.system(size: big.count > 6 ? 28 : 34, weight: .bold)).foregroundStyle(color)
                                .lineLimit(1).minimumScaleFactor(0.6)
                            if f.bigFirst, let label = f.bigLabel { small(label, sky.muted, 13) }
                        }
                    } else {
                        // No time in it ("Leave now", "No classes today"): the headline itself, as big as fits.
                        Text(verbatim: f.headline).font(.system(size: f.headline.count <= 12 ? 24 : 18, weight: .bold)).foregroundStyle(
                            color
                        ).lineLimit(2).minimumScaleFactor(0.7)
                    }
                    if foot == nil, let sub = f.sub {
                        small(sub, sky.muted, 12, lines: 2).padding(.top, 2)
                    }
                }
                .frame(height: skyH, alignment: .topLeading)
                if let foot { LegRow(leg: foot, inks: s.look.ground, size: 12).frame(height: footH) }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(s.spoken)
    }
}

/// The trip across a medium widget: the line above, the headline and how it
/// gets you there in the sky, the hills with your stop and your bus, then the
/// leg along the ground and, on the favourites widget, the chips.
struct TripLayout: View {
    let s: Scene
    let w: CGFloat, h: CGFloat

    var body: some View {
        let f = s.face
        let sky = s.look.sky
        let chipsH: CGFloat = s.chips.isEmpty ? 0 : 42
        let tileH: CGFloat = f.tile == nil ? 0 : 50
        // As much as fits, the leg first to go, then the line under the headline.
        let textFull: CGFloat = 6 + 32 + 32
        var leg = f.leg != nil
        var sub = f.sub != nil || f.pill != nil
        let need = { textFull + (sub ? 20 : 0) + tileH + 26 + (leg ? 26 : 0) + chipsH + 6 }
        if need() > h { leg = false }
        if need() > h { sub = false }
        let groundH = (leg ? 26 : 0) + chipsH + 6
        let skyH = h - groundH
        let textH = textFull + (sub ? 20 : 0) + tileH
        let strip = min(max(skyH - textH + 8, 24), 48)
        return ZStack(alignment: .topLeading) {
            SkyBackdrop(look: s.look, height: skyH, scale: strip / 92, road: f.road, moon: CGPoint(x: 70, y: 22))
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HeadRow(text: f.heading, s: s, inks: sky)
                    Headline(face: f, inks: sky, size: 24)
                    if sub { SubLine(s: s, inks: sky).padding(.top, 2) }
                    if let tile = f.tile { TileView(tile: tile, inks: sky).padding(.top, 6) }
                }
                .padding(.top, 6)
                .frame(height: skyH, alignment: .topLeading)
                if leg, let l = f.leg { LegRow(leg: l, inks: s.look.ground).frame(height: 26) }
                if let slot = s.slot, !s.chips.isEmpty {
                    ModeChips(chips: s.chips, showing: s.mode, slot: slot, inks: s.look.ground, onChosen: s.look.page).frame(height: chipsH)
                }
            }
            .padding(.horizontal, pad)
        }
        .accessibilityElement(children: .contain)
    }
}

/// The large widget: the chips across the sky's top, the headline, then on
/// the ground the trip's steps in the card style chosen in Settings and
/// what's left of today's timetable.
struct DayLayout: View {
    let s: Scene
    let w: CGFloat, h: CGFloat

    var body: some View {
        let f = s.face
        let sky = s.look.sky
        let ground = s.look.ground
        let sub = f.sub != nil || f.pill != nil
        let textH: CGFloat = 8 + 36 + (f.heading != nil ? 18 : 0) + 34 + (sub ? 22 : 0) + (f.tile != nil ? 56 : 0)
        let skyH = textH + 40
        let journey = s.answer?.phase == "riding" ? nil : f.journey
        let bodyH: CGFloat = journey.map { JourneyView.height($0, style: s.style) } ?? (f.leg != nil ? 30 : 0)
        var left = h - skyH - bodyH - 12
        // The nearest stop's next two buses, under the trip, when they fit
        // and the shared board is from the last half hour; then today's timetable.
        // Under a trip there's seldom room for their tiles: then a line of them.
        let tiles = left >= NearbyPair.head + NearbyPair.tile
        let pairH = NearbyPair.head + (tiles ? NearbyPair.tile : NearbyPair.line)
        let fresh = s.entry.nearbyAt.map { s.entry.date.timeIntervalSince($0) <= NearbyShared.keep } ?? false
        let nearby =
            left >= pairH && fresh && !s.entry.sample ? Optional(s.nearbyModel(error: nil)).flatMap { $0.buses.isEmpty ? nil : $0 } : nil
        if nearby != nil { left -= pairH }
        let rows = max(0, min(6, Int((left - 26) / 28)))
        let now = s.entry.serverNow
        let today =
            rows > 0
            ? (s.entry.day.flatMap { $0.date == nil || $0.date == OfflineDay.sgtDate(now) ? $0 : nil }?.items.filter {
                ["now", "next", "later"].contains($0.status)
            }.prefix(rows)).map(Array.init) ?? [] : []
        // Nothing left of today: the room goes to two more of the stop's buses.
        let pairRows = !tiles ? 0 : nearby.map { today.isEmpty && left >= NearbyPair.tile + 1 && $0.buses.count > 2 } == true ? 2 : 1
        let nearbyH: CGFloat = nearby == nil ? 0 : pairH + (pairRows == 2 ? NearbyPair.tile + 1 : 0)
        // A widget's size is fixed: what the steps and today leave over goes
        // to the sky, rather than blank ground under them.
        let todayH: CGFloat = today.isEmpty ? 0 : 8 + 17 + 28 * CGFloat(today.count)
        let tallSky = max(skyH, h - 6 - bodyH - nearbyH - todayH - 14)
        return ZStack(alignment: .topLeading) {
            SkyBackdrop(look: s.look, height: tallSky, scale: 48 / 92, road: f.road, moon: CGPoint(x: 34, y: 66))
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        if let slot = s.slot, !s.chips.isEmpty {
                            ModeChips(chips: s.chips, showing: s.mode, slot: slot, inks: sky, onChosen: s.onChosenSky)
                        } else {
                            Wordmark(size: 15, accent: sky.accent).foregroundStyle(sky.ink)
                        }
                        Spacer(minLength: 0)
                        if s.refresh { RefreshButton(slot: s.slot, inks: sky, side: 30) }
                    }
                    .frame(height: 36)
                    if let heading = f.heading { small(heading, sky.muted, 12, bold: true).padding(.top, 2) }
                    Headline(face: f, inks: sky, size: 26)
                    if sub { SubLine(s: s, inks: sky).padding(.top, 3) }
                    if let tile = f.tile { TileView(tile: tile, inks: sky).padding(.top, 8) }
                }
                .padding(.top, 8)
                .frame(height: tallSky, alignment: .topLeading)
                Spacer().frame(height: 6)
                if let journey, let a = s.answer {
                    JourneyView(answer: a, journey: journey, style: s.style, inks: ground, page: s.look.page, now: now)
                } else if let leg = f.leg {
                    LegRow(leg: leg, inks: ground)
                }
                if let nearby { NearbyPair(v: nearby, inks: ground, rows: pairRows) }
                if !today.isEmpty { TodayList(items: today, inks: ground).padding(.top, 8) }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, pad)
        }
        .accessibilityElement(children: .contain)
    }
}

/// What's left of today, from the day plan: a line each.
private struct TodayList: View {
    let items: [DayPlan.Item]
    let inks: Inks

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            small(L("Today").uppercased(with: Lang.locale), inks.muted, 11, bold: true).padding(.bottom, 2)
            ForEach(items) { item in
                Rectangle().fill(inks.line).frame(height: 1)
                HStack(spacing: 8) {
                    Text(verbatim: item.starts.map(campusTime) ?? "").font(.system(size: 13, weight: .bold)).foregroundStyle(inks.ink)
                        .frame(width: 64, alignment: .leading)
                    Text(verbatim: item.title).font(.system(size: 13)).foregroundStyle(inks.ink).lineLimit(1)
                    if let line = item.line { Text(verbatim: line).font(.system(size: 12)).foregroundStyle(inks.muted).lineLimit(1) }
                }
                .frame(height: 27)
            }
        }
    }
}

/// Nearby, as the Buses tab's board: the nearest stop's name big on the sky
/// (the one across the road a tap away), then each service with its badge,
/// where it stops next, Live and how full it is, and the time it's due at
/// the end, with its minutes under 15. From the board every widget showing
/// buses near you shares (NearbyShared), as Buses near you draws it.
struct BoardLayout: View {
    let s: Scene
    let w: CGFloat, h: CGFloat

    var body: some View {
        let sky = s.look.sky
        let ground = s.look.ground
        let slotState = s.entry.slot
        let v = s.nearbyModel(error: slotState?.error)
        let all = v.all ?? []
        let first = v.first
        let buses = v.buses
        let large = h >= 290
        let chipsH: CGFloat = s.chips.isEmpty || large ? 0 : 42
        let skyH: CGFloat = 10 + (large ? 40 : 0) + 34 + (large ? 28 : 24) + 22
        let rows = max(0, Int((h - skyH - chipsH - 8) / 46))
        return ZStack(alignment: .topLeading) {
            SkyBackdrop(
                look: s.look, height: skyH, scale: 34 / 92, road: Road(stop: true, shuttle: false),
                moon: CGPoint(x: large ? 90 : 120, y: large ? 64 : 24))
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    if large, let slot = s.slot {
                        HStack(spacing: 6) {
                            ModeChips(chips: s.chips, showing: s.mode, slot: slot, inks: sky, onChosen: s.onChosenSky)
                            Spacer(minLength: 0)
                            if s.refresh { RefreshButton(slot: s.slot, inks: sky, side: 30) }
                        }
                        .frame(height: 40)
                    }
                    let other = first.flatMap { WidgetSwap.offer(all, v.swap, now: v.now, onScreen: [$0.stop.code]) }
                    HStack(spacing: 6) {
                        // Once the times may be old, the line says so, and when they came.
                        if v.old, !buses.isEmpty, let at = v.fetchedAt {
                            small(L("Nearby") + " · " + L("Times may be old · %@", v.clock(at)), sky.late, 12, bold: true)
                        } else {
                            small(
                                ([L("Nearby")] + [first.map(NearbyModel.walk)].compactMap { $0 }).joined(separator: " · "), sky.muted, 12,
                                bold: true)
                        }
                        Spacer(minLength: 0)
                        if let other, let slot = s.slot, let nearest = all.first {
                            NearbySwapButton(slot: slot, from: nearest.stop.code, other: other, inks: sky)
                        }
                        if !large, s.refresh { RefreshButton(slot: s.slot, inks: sky) }
                    }
                    .frame(height: 34)
                    let name: String = {
                        if let first { return first.stop.longName ?? first.stop.name }
                        if v.error == WidgetFace.updating || v.all == nil { return L("Checking…") }
                        return v.error ?? L("No stops near you")
                    }()
                    Text(verbatim: name).font(.system(size: large ? 22 : 19, weight: .bold)).foregroundStyle(sky.ink).lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .padding(.top, 8)
                .frame(height: skyH, alignment: .topLeading)
                if let first {
                    if v.error == WidgetFace.updating {
                        small(L("Updating…"), ground.muted).padding(.top, 8)
                    } else if buses.isEmpty {
                        small(first.available ? L("No buses due") : L("No live data"), ground.muted).padding(.top, 8)
                    } else {
                        let shown = Array(buses.prefix(rows))
                        VStack(spacing: 0) {
                            // The medium widget, under its chips: no room for a row, so a line of the next three.
                            if rows == 0 { NearbyLine(v: v, buses: Array(buses.prefix(3)), inks: ground).frame(height: 34) }
                            ForEach(Array(shown.enumerated()), id: \.offset) { i, b in
                                if i > 0 { Rectangle().fill(ground.line).frame(height: 1) }
                                BoardLine(v: v, b: b, shown: shown, inks: ground)
                            }
                        }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(v.spoken)
                    }
                }
                if chipsH > 0, let slot = s.slot {
                    Spacer(minLength: 0)
                    ModeChips(chips: s.chips, showing: s.mode, slot: slot, inks: ground, onChosen: s.look.page).frame(height: chipsH)
                } else {
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, pad)
        }
        .accessibilityElement(children: .contain)
    }
}

/// One service at the stop: its badge, where it stops next with Live and how
/// full, and the time it's due with its minutes (or the bus after) under it.
private struct BoardLine: View {
    let v: NearbyModel
    let b: StopBus
    let shown: [StopBus]
    let inks: Inks

    var body: some View {
        HStack(spacing: 8) {
            BusBadge(svc: b.svc, color: b.color, size: 14, paid: b.paid, even: true).frame(width: 46, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                small(v.nextLine(b, shown).isEmpty ? b.svc : v.nextLine(b, shown), inks.ink, 13)
                NearbyPills(v: v, b: b, inks: inks)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                TimeText(v: v, b: b, inks: inks, size: 19)
                if let left = v.minutes(b) {
                    MinutesChip(b: b, left: left, inks: inks, size: 11)
                } else if let next = b.later.first {
                    small(L("then %@", v.clock(next)), inks.muted, 11)
                }
            }
        }
        .frame(height: 45)
    }
}

// MARK: the Lock Screen

/// Three lines: what it's for, the headline, and the countdown (else the line under it).
struct RectangularView: View {
    let s: Scene

    var body: some View {
        let f = s.face
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                if let svc = f.journey?.bus?.svc ?? f.leg?.svc {
                    Text(verbatim: svc).font(.system(size: 12, weight: .heavy)).padding(.horizontal, 4).background(
                        RoundedRectangle(cornerRadius: 4).strokeBorder(lineWidth: 1))
                }
                Text(verbatim: f.journey?.place ?? f.heading ?? "terminus").font(.system(size: 13, weight: .semibold)).lineLimit(1)
            }
            .foregroundStyle(.secondary)
            Text(verbatim: f.headline).font(.system(size: 16, weight: .bold)).lineLimit(1).minimumScaleFactor(0.7)
            if let line = f.leg?.text ?? f.sub {
                Text(verbatim: line).font(.system(size: 13)).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(s.spoken)
    }
}

/// The bus and the time that matters: to leave, or to get off.
struct CircularView: View {
    let s: Scene

    var body: some View {
        let f = s.face
        let svc = f.journey?.bus?.svc ?? f.leg?.svc
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let svc {
                    Text(verbatim: svc).font(.system(size: 12, weight: .heavy))
                } else {
                    Image(systemName: "bus.fill").font(.system(size: 12))
                }
                Text(verbatim: f.big ?? f.journey?.leave ?? f.journey?.bus?.board ?? "–").font(.system(size: 14, weight: .bold))
                    .minimumScaleFactor(0.6).lineLimit(1)
            }
            .padding(4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(s.spoken)
    }
}

/// One line above the clock: the card's glance ("Leave 09:38").
struct InlineView: View {
    let s: Scene

    var body: some View {
        let text = s.answer?.card?.glance ?? s.face.headline
        Label {
            Text(verbatim: text)
        } icon: {
            Image(systemName: "bus.fill")
        }
        .accessibilityLabel(s.spoken)
    }
}
