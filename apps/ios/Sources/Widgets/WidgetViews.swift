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
    var refresh: Bool { entry.paired && !entry.sample }
    /// The words on the chosen chip over the sky, and on the ground.
    var onChosenSky: Color { look.palette.lightInk ? Color(rgb: 0x1C1917) : Color(rgb: 0xFAFAF9) }

    /// What VoiceOver says for the widget, as one sentence rather than fragments.
    var spoken: String {
        if mode == .nearby {
            guard let first = entry.slot?.nearby?.first else { return entry.slot?.error ?? L("Checking…") }
            return Spoken.sentences(
                L("Nearby"), first.stop.longName ?? first.stop.name,
                first.board.prefix(3).compactMap { r in r.etaText.map { "\(r.svc) \($0)" } }.joined(separator: " · "))
        }
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
        let left = h - skyH - bodyH - 12
        let rows = max(0, min(6, Int((left - 26) / 28)))
        let now = s.entry.serverNow
        let today =
            rows > 0
            ? (s.entry.day.flatMap { $0.date == nil || $0.date == OfflineDay.sgtDate(now) ? $0 : nil }?.items.filter {
                ["now", "next", "later"].contains($0.status)
            }.prefix(rows)).map(Array.init) ?? [] : []
        // A widget's size is fixed: what the steps and today leave over goes
        // to the sky, rather than blank ground under them.
        let todayH: CGFloat = today.isEmpty ? 0 : 8 + 17 + 28 * CGFloat(today.count)
        let tallSky = max(skyH, h - 6 - bodyH - todayH - 14)
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
/// where it goes, Live and how full it is, and its minutes big at the end.
struct BoardLayout: View {
    let s: Scene
    let w: CGFloat, h: CGFloat

    var body: some View {
        let sky = s.look.sky
        let ground = s.look.ground
        let slotState = s.entry.slot
        let now = s.entry.date
        let stops = slotState?.nearby.map { WidgetSwap.order($0, slotState?.swap, now: now) }
        let all = slotState?.nearby ?? []
        let age = slotState?.fetchedAt.map { now.timeIntervalSince($0) } ?? 0
        let old = age > WidgetMode.nearbyOld
        let error = slotState?.error
        let first = stops?.first
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
                    let walk = first.map { $0.walkS < 60 ? L("here") : L("%@ min walk", "\(($0.walkS + 30) / 60)") }
                    let other = first.flatMap { WidgetSwap.offer(all, slotState?.swap, now: now, onScreen: [$0.stop.code]) }
                    HStack(spacing: 6) {
                        small(([L("Nearby")] + [walk].compactMap { $0 }).joined(separator: " · "), sky.muted, 12, bold: true)
                        Spacer(minLength: 0)
                        if let other, let slot = s.slot, let nearest = all.first {
                            Button(intent: SwapIntent(slot: slot, from: nearest.stop.code, to: other.stop.code)) {
                                Image(systemName: "arrow.left.arrow.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(
                                    sky.ink
                                )
                                .frame(width: 28, height: 28).background(sky.chip ?? sky.raised, in: Circle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("Show %@ first", other.stop.name))
                        }
                        if !large, s.refresh { RefreshButton(slot: s.slot, inks: sky) }
                    }
                    .frame(height: 34)
                    let name: String = {
                        if let first { return first.stop.longName ?? first.stop.name }
                        if error == WidgetFace.updating || slotState?.json == nil { return L("Checking…") }
                        return error ?? L("No stops near you")
                    }()
                    Text(verbatim: name).font(.system(size: large ? 22 : 19, weight: .bold)).foregroundStyle(sky.ink).lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .padding(.top, 8)
                .frame(height: skyH, alignment: .topLeading)
                if let first {
                    let board = first.board.filter { $0.etaS != nil }
                    if error == WidgetFace.updating {
                        small(L("Updating…"), ground.muted).padding(.top, 8)
                    } else if old {
                        small(L("Times may be out of date · tap ↻ to refresh"), ground.muted).padding(.top, 8)
                    } else if board.isEmpty {
                        small(first.available ? L("No buses due") : L("No live data"), ground.muted).padding(.top, 8)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(Array(board.prefix(rows).enumerated()), id: \.offset) { i, r in
                                if i > 0 { Rectangle().fill(ground.line).frame(height: 1) }
                                BoardLine(row: r, ageS: Int(age), inks: ground)
                            }
                        }
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

/// The server's own words for a time are kept while they're this fresh; then the widget counts down itself.
private let serverEtaS = 30

/// One service at the stop: its badge, where it goes with Live and how full, and its minutes.
private struct BoardLine: View {
    let row: BoardRow
    let ageS: Int
    let inks: Inks

    var body: some View {
        let left = max(0, (row.etaS ?? 0) - ageS)
        let eta =
            ageS < serverEtaS
            ? row.etaText ?? ""
            : (left < BusTimes.arrivingS
                ? L("Arriving")
                : row.quality == "live" ? L("%@ min", "\(BusTimes.minutes(left))") : L("~%@ min", "\(BusTimes.minutes(left))"))
        let crowd: (String, Color)? =
            switch row.crowd {
            case "low": (L("Seats"), inks.good)
            case "medium": (L("Busy"), inks.muted)
            case "high": (L("Packed"), inks.late)
            default: nil
            }
        HStack(spacing: 8) {
            BusBadge(svc: row.svc, color: row.color, size: 14, paid: row.paid, even: true).frame(width: 46, alignment: .leading)
            VStack(alignment: .leading, spacing: 3) {
                small(
                    row.toText ?? (row.towards.isEmpty ? (row.endsHere ? L("Ends here") : row.svc) : row.towards.joined(separator: ", ")),
                    inks.ink, 13)
                HStack(spacing: 5) {
                    PillView(
                        pill: row.quality == "live"
                            ? WidgetPill(text: L("Live"), good: true) : WidgetPill(text: L("Scheduled"), good: false), inks: inks)
                    if let crowd {
                        Text(verbatim: crowd.0).font(.system(size: 11, weight: .medium)).foregroundStyle(crowd.1)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(inks.raised, in: Capsule())
                    }
                }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                Text(verbatim: eta).font(.system(size: 19, weight: .bold)).foregroundStyle(inks.ink).lineLimit(1)
                if ageS < serverEtaS, let later = row.thenText { small(later, inks.muted, 11) }
            }
        }
        .frame(height: 45)
        .accessibilityElement(children: .combine)
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
