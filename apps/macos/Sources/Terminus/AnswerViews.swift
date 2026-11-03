import SwiftUI

// MARK: - Content

struct AnswerDetail: View {
    let answer: NextAnswer?
    var busy = false
    /// Today's entry just taken off, whose row has Undo: the card doesn't offer it as well.
    var undoShownFor: String? = nil
    /// Past the card's staleAt (AppModel.isOld): its times may be gone, so
    /// they're left out until the refresh lands, as on the phone and the
    /// web; the header says "Updating times…" meanwhile.
    var old = false
    var onAction: (CardAction) -> Void = { _ in }
    var onChoice: (Suggestion, Bool) -> Void = { _, _ in }
    var onStep: (NextAnswer.Step, StepTarget?, StepDirection?) -> Void = { _, _, _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let a = answer {
                if let n = a.card?.notice { Row(icon: "antenna.radiowaves.left.and.right.slash", text: n).foregroundStyle(Color.warn) }
                if let w = a.card?.warning {
                    Row(icon: "exclamationmark.triangle.fill", text: w).fontWeight(.semibold).foregroundStyle(Color.warn)
                }
                if let ride = a.card?.ride { RideLine(ride: ride, color: a.card?.journey?.bus?.color) }
                if a.isFree {
                    // Nothing to catch: no bus to mistake for advice.
                    NextClass(answer: a)
                    Row(icon: "location", text: L("Buses near you are under Nearby.")).foregroundStyle(.secondary)
                } else if old {
                    // Nothing timed: an old "by 4:01 PM" would pass for current.
                    EmptyView()
                } else if a.isClassPlan {
                    // The bus to catch (it names the stop), then when it gets you there.
                    // One colour for "go" (the countdown in the header); red only when it's late.
                    if let c = a.catchHow {
                        Row(icon: a.leave?.svc == nil ? "figure.walk" : "bus.fill", text: c).fontWeight(.semibold).foregroundStyle(
                            a.leaveLate ? Color.bad : Color.primary)
                    }
                    if let arrive = a.catchArrive {
                        Row(icon: "flag.checkered", text: arrive).foregroundStyle(a.leaveLate ? Color.bad : Color.secondary)
                    }
                    if let note = a.card?.note { Row(icon: "person.3.fill", text: note).foregroundStyle(.secondary) }
                    if let e = a.card?.estimate { Row(icon: "info.circle", text: e).foregroundStyle(.secondary) }
                    if let g = a.goNowLine { Row(icon: "bus", text: g).foregroundStyle(.secondary) }
                } else if a.card?.upcoming != nil {
                    // After your day, or at home: what's next.
                    NextClass(answer: a)
                } else if let j = a.card?.journey {
                    JourneyRows(journey: j)
                } else {
                    Row(icon: a.mode == "rest" ? "calendar" : "text.alignleft", text: a.detail)
                    if let leave = a.leaveText() { Row(icon: "figure.walk", text: leave).fontWeight(.semibold) }
                }
                // Under the bus it's about, as on the web: the bus before or after it.
                if !old, !a.isFree, let step = a.card?.step {
                    StepButtons(step: step, onStep: onStep).disabled(busy).padding(.top, 2)
                }
                // On a ride, the detail already says when you get there, with
                // its "~" on an estimate; the timing pill would say it again.
                let timing = a.card?.ride == nil ? a.timing?.text : nil
                if !old, !a.isClassPlan, !a.isFree, timing != nil || a.crowdText != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = timing {
                            Pill(text: text, color: t.status == "late" ? .bad : t.status == "tight" ? .warn : .good)
                        }
                        if let c = a.crowdText { Pill(text: c, color: .secondary) }
                    }
                }
                // The server's buttons (plans only: Not going, Not on campus today, undo), the first one prominent.
                if let actions = a.card?.actions?.filter({ !($0.id == "reset" && $0.trip == undoShownFor && undoShownFor != nil) }),
                    !actions.isEmpty
                {
                    Flow(spacing: 6) {
                        ForEach(Array(Self.grouped(actions).enumerated()), id: \.offset) { i, group in
                            if group.count > 1 {
                                SkipMenu(skips: group, onAction: onAction)
                            } else if let action = group.first {
                                if i == 0 && action.id != "skipped" && action.id != "reset" {
                                    Button(action.label) { onAction(action) }.buttonStyle(.borderedProminent).controlSize(.small)
                                } else {
                                    Button(action.label) { onAction(action) }.buttonStyle(.bordered).controlSize(.small)
                                }
                            }
                        }
                    }
                    .disabled(busy)
                    .padding(.top, 2)
                }
                if let s = a.card?.suggestion {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(s.text).font(.callout).fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: 6) {
                            Button(s.accept) { onChoice(s, true) }.buttonStyle(.borderedProminent).controlSize(.small)
                            Button(s.dismiss) { onChoice(s, false) }.buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                    .disabled(busy)
                    .padding(8)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("Checking…")).foregroundStyle(.secondary)
                }
            }
        }
        // Fill the area's fixed height (120 with the card's padding), so a
        // short answer centres in the card instead of leaving a gap under it.
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .card()
    }

    /// The card's buttons, one to a group, except "Not going" and "Not on
    /// campus today": the same no, for this class and for the whole day, so
    /// with both they share one menu where the first of them was (as on Android).
    nonisolated static func grouped(_ actions: [CardAction]) -> [[CardAction]] {
        let isSkip = { (a: CardAction) in a.id == "skipped" || a.id == "away" }
        let skips = actions.filter(isSkip)
        guard skips.count > 1 else { return actions.map { [$0] } }
        var groups: [[CardAction]] = []
        for a in actions {
            if !isSkip(a) { groups.append([a]) } else if a == skips[0] { groups.append(skips) }
        }
        return groups
    }

    /// "‹ Earlier bus", "Best bus" (once moved off it), "Later bus ›", the
    /// same width each. One with no bus that way is greyed, not hidden, so
    /// the other keeps its side.
    struct StepButtons: View {
        let step: NextAnswer.Step
        let onStep: (NextAnswer.Step, StepTarget?, StepDirection?) -> Void

        var body: some View {
            HStack(spacing: 6) {
                Button {
                    onStep(step, step.earlier, .earlier)
                } label: {
                    // One Text, chevron and all, so its baseline is Best bus's.
                    Text("\(Image(systemName: "chevron.left")) \(step.earlierLabel)")
                        .frame(maxWidth: .infinity)
                }
                .disabled(step.earlier == nil)
                .accessibilityLabel(step.earlierLabel)
                if step.moved {
                    Button {
                        onStep(step, nil, nil)
                    } label: {
                        Text(step.bestLabel).frame(maxWidth: .infinity)
                    }
                }
                Button {
                    onStep(step, step.later, .later)
                } label: {
                    Text("\(step.laterLabel) \(Image(systemName: "chevron.right"))")
                        .frame(maxWidth: .infinity)
                }
                .disabled(step.later == nil)
                .accessibilityLabel(step.laterLabel)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .lineLimit(1)
        }
    }

    /// "Not going ▾": each choice says underneath how much it skips.
    private struct SkipMenu: View {
        let skips: [CardAction]
        let onAction: (CardAction) -> Void

        var body: some View {
            Menu {
                ForEach(skips, id: \.self) { s in
                    Button {
                        onAction(s)
                    } label: {
                        Text(s.label)
                        Text(s.id == "skipped" ? L("Skip this class") : L("Skip every trip left today"))
                    }
                }
            } label: {
                Text(skips[0].label)
            }
            .menuStyle(.button)
            .buttonStyle(.bordered)
            .controlSize(.small)
            .fixedSize()
        }
    }

    /// The next class on a block of its own (`card.upcoming`): when in the
    /// accent, what, then where, as the web and Android show it. Why today has
    /// none on a break goes above it. One line, worked out here for an older server.
    private struct NextClass: View {
        let answer: NextAnswer

        var body: some View {
            if let u = answer.card?.upcoming {
                if let off = u.off { Row(icon: "calendar", text: off) }
                HStack(alignment: .top, spacing: 10) {
                    Capsule().fill(Color.brand).frame(width: 3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(u.when).font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.brand)
                        Text(u.title).font(.callout.weight(.semibold))
                        Label(u.where, systemImage: "mappin.and.ellipse")
                            .labelStyle(Tight())
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                // The bar as tall as the words, not the card.
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            } else {
                Row(icon: "calendar", text: answer.detail)
            }
        }

        /// An icon a few points from its words, the way Row sets them.
        private struct Tight: LabelStyle {
            func makeBody(configuration: Configuration) -> some View {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    configuration.icon.font(.system(size: 10))
                    configuration.title
                }
            }
        }
    }

    /// The journey's title, then a row a step: the walk (and by when), the
    /// ride, the walk at the end, getting there, and the bus to fall back on.
    /// A trip that changes buses has the first ride, the change and the
    /// second ride in place of the one. Every word is the server's.
    struct JourneyRows: View {
        let journey: NextAnswer.Journey

        var body: some View {
            let j = journey
            Text(j.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            if let walk = j.walkText { Row(icon: "figure.walk", text: [walk, j.byText].compactMap { $0 }.joined(separator: " · ")) }
            if let c = j.change {
                Row(icon: "bus.fill", text: [j.bus?.svc, c.firstRideText].compactMap { $0 }.joined(separator: " · ")).fontWeight(.semibold)
                Row(icon: "arrow.triangle.swap", text: c.changeText)
                Row(icon: "bus.fill", text: [c.bus.svc, c.rideText].joined(separator: " · ")).fontWeight(.semibold)
            } else if let ride = j.rideText {
                Row(icon: "bus.fill", text: [j.bus?.svc, ride].compactMap { $0 }.joined(separator: " · ")).fontWeight(.semibold)
            }
            if let end = j.walkEndText { Row(icon: "figure.walk", text: end) }
            if let arrive = j.arriveText {
                Row(icon: "flag.checkered", text: [arrive, j.arriveWhere].compactMap { $0 }.joined(separator: " · "))
            }
            if let backup = j.backupText { Row(icon: "bus", text: backup).foregroundStyle(.secondary) }
        }
    }

    /// The ride as a line of its stops, the passed ones filled, with the bus
    /// where the clock puts it (stops evenly spaced between the board and
    /// arrival times, as the phone and the web take them). Boarding stop on
    /// the left, the one to get off at on the right, the next one under the bus.
    struct RideLine: View {
        let ride: NextAnswer.Ride
        var color: String?
        @Environment(\.colorScheme) private var scheme

        var body: some View {
            Ticking(every: 5) { now in
                let hops = ride.stops.count - 1
                let done = ride.progress(at: now)
                let passed = ride.passed(at: now)
                let tint = color.flatMap(Color.init(hex:)) ?? .brand
                VStack(alignment: .leading, spacing: 4) {
                    GeometryReader { g in
                        let w = g.size.width - 8
                        ZStack(alignment: .leading) {
                            Capsule().fill(.primary.opacity(0.12)).frame(height: 3).padding(.horizontal, 4)
                            Capsule().fill(tint).frame(width: max(0, w * done), height: 3).padding(.leading, 4)
                            ForEach(0...hops, id: \.self) { i in
                                Circle()
                                    .fill(i <= passed ? tint : Color.secondary.opacity(0.35))
                                    .frame(width: 6, height: 6)
                                    .offset(x: w * Double(i) / Double(max(1, hops)) + 1)
                            }
                            Image(systemName: "bus.fill")
                                .font(.system(size: 10, weight: .bold))
                                // With no service colour, or one that can't be read, the disc
                                // is the brand's (Color.brand), in this appearance: ink for that.
                                .foregroundStyle(
                                    inkOn(rgb: color.flatMap(hexRGB) ?? (scheme == .dark ? Color.brandRGB.dark : Color.brandRGB.light))
                                )
                                .frame(width: 16, height: 16)
                                .background(Circle().fill(tint))
                                .offset(x: w * done - 4)
                        }
                    }
                    .frame(height: 16)
                    HStack(spacing: 6) {
                        Text(ride.stops[0].name)
                        Spacer(minLength: 4)
                        if passed + 1 < hops { Text(ride.stops[passed + 1].name).fontWeight(.semibold) }
                        Spacer(minLength: 4)
                        Text(ride.stops[hops].name).fontWeight(.semibold)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    // A trip that changes: the second bus, where this one drops you.
                    if let change = ride.change { Text(change.text).font(.caption).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L("Ride progress"))
                .accessibilityValue(
                    [Self.spoken(ride.stops.map(\.name), passed: passed), ride.change?.text].compactMap { $0 }.joined(separator: " "))
            }
        }

        /// "Next stop: COM 3. 2 more stops, getting off at UTown.": where the
        /// bus is and how far is left, not every stop's name.
        nonisolated static func spoken(_ stops: [String], passed: Int) -> String {
            let last = stops.count - 1
            guard last > 0 else { return stops.first ?? "" }
            let next = min(passed + 1, last)
            let left = last - min(passed, last - 1)
            return left <= 1
                ? L("Next stop: %@, where you get off.", stops[last])
                : L("Next stop: %@. %@ stops to go, getting off at %@.", stops[next], "\(left)", stops[last])
        }
    }

    private struct Row: View {
        let icon: String
        let text: String
        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                // The words say it all; the icon is only for the eye.
                Image(systemName: icon).font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 14).accessibilityHidden(true)
                Text(text).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spokenTimes(text))
        }
    }
}

struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(color.opacity(0.14)))
    }
}

/// Nearby: the stops around you, each with a row per service read like a
/// stop's board, as on the web: where it's going and its next three buses,
/// in minutes or as clock times (the switch above the stops, for every stop
/// at once and kept on this Mac). The next bus is the large one. Under the
/// stops, what a "~" means.
struct NearbyList: View {
    let stops: [NearbyStop]?
    @AppStorage(NearbyBoard.clockKey) private var asClock = false
    /// The width of a stop's rows, for [NearbyLayout]: nil until it's laid out.
    @State private var rowWidth: CGFloat? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let all = stops {
                let layout = NearbyLayout(all, clock: asClock, rowWidth: rowWidth)
                if !all.isEmpty {
                    Picker(L("Show times"), selection: $asClock) {
                        Text(L("In minutes")).tag(false)
                        Text(L("Clock time")).tag(true)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: .infinity)
                }
                ForEach(all) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(s.stop.name).font(.system(size: 13, weight: .semibold)).accessibilityAddTraits(.isHeader)
                            Spacer()
                            Text(s.walkS < 60 ? L("You're here") : L("%@ min walk", "\((s.walkS + 30) / 60)"))
                                .font(.system(size: 11)).foregroundStyle(.secondary)
                        }
                        .padding(.bottom, 4)
                        if s.board.isEmpty || !s.available {
                            Text(s.available ? L("Nothing due") : L("No live data")).font(.caption).foregroundStyle(.secondary)
                        } else {
                            NearbyBoard(rows: s.board, asClock: asClock, layout: layout)
                                .onGeometryChange(for: CGFloat.self) {
                                    $0.size.width
                                } action: {
                                    rowWidth = $0
                                }
                        }
                    }
                    .card(padding: 10)
                }
                let foot = NearbyBoard.foot(all, clock: asClock)
                if !foot.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(foot, id: \.self) { Text($0) }
                    }
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                }
            } else {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(L("Checking…")).foregroundStyle(.secondary)
                }
                .card()
            }
        }
    }
}

/// Nearby's type and its columns, measured in the fonts it's drawn in: every
/// badge as wide as the widest, each time column as wide as its widest time
/// (or heading) on every stop, so the figures line up down the list and none
/// spills into the next column. Each destination must fit in its two lines
/// beside the times, its place kept whole where that fits and broken between
/// words where it doesn't; where one won't, for the whole screen at once:
/// the gaps between the times close up, then the times shrink (to
/// `minScale` at most). Only when that isn't enough does every row put its
/// times on a line of their own, at full size (`stacks`): all of them, as
/// the columns are shared.
struct NearbyLayout {
    var badge: CGFloat
    var columns: [CGFloat]
    var scale: CGFloat = 1
    /// Between two time columns.
    var gap = Self.columnGap
    /// Even shrunk, the times leave no room: every row has them on a second line.
    var stacks = false
    /// The width of a row; nil until it's laid out.
    var rowWidth: CGFloat? = nil

    static let badgePadding: CGFloat = 6
    static let destGap: CGFloat = 8
    static let columnGap: CGFloat = 12
    static let tightGap: CGFloat = 8
    static let minScale: CGFloat = 0.85
    static let headingTracking: CGFloat = 0.6

    /// The figures, in the board's rounded face: the next bus larger and bold.
    static func figures(pick: Bool, clock: Bool, scale: CGFloat = 1) -> NSFont {
        let size = (pick ? (clock ? 15.5 : 19) : (clock ? 13 : 14)) * scale
        let plain = NSFont.monospacedDigitSystemFont(ofSize: size, weight: pick ? .bold : .semibold)
        return plain.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size) } ?? plain
    }
    /// "min", "PM", "下午": small, beside the figures.
    static func unit(scale: CGFloat = 1) -> NSFont { .systemFont(ofSize: 10 * scale, weight: .medium) }
    /// A service's name on its badge, in the board's face.
    static func badgeFont() -> NSFont {
        let plain = NSFont.systemFont(ofSize: 13, weight: .bold)
        return plain.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 13) } ?? plain
    }
    static func heading() -> NSFont { .systemFont(ofSize: 9.5, weight: .semibold) }
    static func words() -> NSFont { .systemFont(ofSize: 13) }
    static func place() -> NSFont { .systemFont(ofSize: 13, weight: .semibold) }
    /// No badge narrower than a two-letter line's ("D2").
    static var badgeMin: CGFloat { width("D2", badgeFont()) + 2 * badgePadding }

    /// The layout for `stops`' boards, in rows `rowWidth` wide (nil: not laid out yet, so at full size).
    init(_ stops: [NearbyStop], clock: Bool, rowWidth: CGFloat?) {
        let rows = stops.filter(\.available).flatMap(\.board)
        badge = max(Self.badgeMin, rows.map { Self.width($0.pillID, Self.badgeFont()) + 2 * Self.badgePadding }.max() ?? 0)
        let heads = [L("Next"), L("Then"), L("After")].map {
            Self.width($0.uppercased(with: Lang.locale), Self.heading(), tracking: Self.headingTracking)
        }
        let columns = { (scale: CGFloat) in
            (0..<3).map { i in
                rows.map { r in
                    let b = r.buses
                    let c = NearbyBoard.cell(b[i], prev: i > 0 ? b[i - 1] : nil, first: i == 0, clock: clock)
                    return Self.width(c, pick: i == NearbyBoard.pick(b), clock: clock, scale: scale)
                }
                .reduce(heads[i], max)
            }
        }
        let full = columns(1)
        self.columns = full
        self.rowWidth = rowWidth
        guard rowWidth != nil else { return }
        func fit(_ width: CGFloat) -> Bool { rows.allSatisfy { Self.fits($0, width: width) } }
        if fit(destWidth(stacked: false)) { return }
        gap = Self.tightGap
        if fit(destWidth(stacked: false)) { return }
        for p in stride(from: 99, through: Int(Self.minScale * 100), by: -1) {
            scale = CGFloat(p) / 100
            self.columns = columns(scale)
            if fit(destWidth(stacked: false)) { return }
        }
        // As small as they go and a destination still won't fit its two lines: cut, it would lose its place.
        self.columns = full
        scale = 1
        gap = Self.columnGap
        stacks = true
    }

    /// The room for a row's destination: beside its times, or the row's whole width past the badge when stacked.
    func destWidth(stacked: Bool) -> CGFloat {
        guard let rowWidth else { return .infinity }
        return rowWidth - badge - Self.destGap - (stacked ? 0 : columns.reduce(0, +) + 3 * gap)
    }

    /// Whether `r`'s destination fits in its two lines of `width`, breaking only between words.
    static func fits(_ r: BoardRow, width: CGFloat) -> Bool {
        longestWord(r) <= width && lines(r, width: width) <= 2
    }

    /// The widest word of `r`'s destination: narrower than that, a word itself breaks.
    static func longestWord(_ r: BoardRow) -> CGFloat {
        let d = NearbyBoard.dest(r)
        let words = (d.lead + d.trail).split(whereSeparator: \.isWhitespace).map { width(String($0), Self.words()) }
        let place = (d.place ?? "").split(whereSeparator: \.isWhitespace).map { width(String($0), Self.place()) }
        return (words + place).max() ?? 0
    }

    /// How many lines `r`'s destination takes in `width`, as it's drawn: its place kept whole where that fits.
    static func lines(_ r: BoardRow, width: CGFloat) -> Int {
        let d = NearbyBoard.dest(r)
        let s = NSMutableAttributedString(string: d.lead, attributes: [.font: words()])
        if let p = d.place {
            s.append(NSAttributedString(string: NearbyBoard.keptWhole(p, width: width), attributes: [.font: place()]))
        }
        s.append(NSAttributedString(string: d.trail, attributes: [.font: words()]))
        let h = s.boundingRect(with: CGSize(width: width, height: 10_000), options: [.usesLineFragmentOrigin]).height
        return Int((h / NSLayoutManager().defaultLineHeight(for: place())).rounded())
    }

    /// A cell's width as drawn, a point over for rounding.
    static func width(_ c: NearbyBoard.Cell, pick: Bool, clock: Bool, scale: CGFloat = 1) -> CGFloat {
        let big = figures(pick: pick, clock: clock, scale: scale)
        let small = unit(scale: scale)
        let s = NSMutableAttributedString()
        for (text, font) in [(c.mark, big), (c.lead, small), (c.figure, big), (c.trail, small)] where !text.isEmpty {
            s.append(NSAttributedString(string: text, attributes: [.font: font]))
        }
        return ceil(s.size().width) + 1
    }

    static func width(_ text: String, _ font: NSFont, tracking: CGFloat = 0) -> CGFloat {
        ceil(NSAttributedString(string: text, attributes: [.font: font, .kern: tracking]).size().width) + 1
    }
}

/// One of a row's three buses: the row's own, or one of the two in `later`.
struct NearbyBus: Hashable {
    let etaS: Int?
    let quality: String
    var eta: String? = nil
    var at: String? = nil

    init(etaS: Int?, quality: String, eta: String? = nil, at: String? = nil) {
        self.etaS = etaS
        self.quality = quality
        self.eta = eta
        self.at = at
    }
    init(_ r: BoardRow) { self.init(etaS: r.etaS, quality: r.quality, eta: r.eta, at: r.at) }
    init(_ l: BoardRow.Later) { self.init(etaS: l.etaS, quality: l.quality, eta: l.eta, at: l.at) }

    /// A timetable guess or an old live time: marked "~".
    var approx: Bool { quality == "scheduled" || quality == "stale" }
}

extension BoardRow {
    /// One row per service; a public bus is its own even under a shuttle's name.
    var pillID: String { paid == true ? "\(svc) $" : svc }
    /// Next, Then and After: this bus and the two after it, nil where there's none.
    var buses: [NearbyBus?] {
        let l = later ?? []
        return [NearbyBus(self), l.first.map(NearbyBus.init), l.count > 1 ? NearbyBus(l[1]) : nil]
    }
}

/// A stop's rows in Nearby: the service in its colour, where it's going, and
/// its next three buses under a small heading, in [NearbyLayout]'s columns.
struct NearbyBoard: View {
    let rows: [BoardRow]
    let asClock: Bool
    let layout: NearbyLayout

    /// Where the choice of minutes or clock times is kept.
    nonisolated static let clockKey = "nearbyClock"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Spacer(minLength: 0)
                ForEach(Array([L("Next"), L("Then"), L("After")].enumerated()), id: \.offset) { i, s in
                    Text(s.uppercased(with: Lang.locale))
                        .font(Font(NearbyLayout.heading()))
                        .tracking(NearbyLayout.headingTracking)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .frame(width: layout.columns[i], alignment: .trailing)
                        .padding(.leading, layout.gap)
                }
            }
            .padding(.bottom, 2)
            .accessibilityHidden(true)
            // By service, not by the whole row: a new time is the same row
            // counting down (.numericText), not a new one replacing it.
            ForEach(Array(zip(Self.pillIDs(rows), rows).enumerated()), id: \.element.0) { n, pair in
                if n > 0 { Rectangle().fill(.primary.opacity(0.08)).frame(height: 1) }
                row(pair.1)
            }
        }
    }

    private func row(_ r: BoardRow) -> some View {
        let stacked = layout.stacks
        let place = Self.destination(r, width: layout.destWidth(stacked: stacked))
            .font(Font(NearbyLayout.words()))
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, NearbyLayout.destGap)
        return Group {
            if stacked {
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 0) {
                        badge(r)
                        place
                    }
                    .frame(minHeight: 44)
                    times(r)
                }
                .padding(.bottom, 8)
            } else {
                HStack(spacing: 0) {
                    badge(r)
                    place
                    times(r)
                }
                .frame(minHeight: 44)
            }
        }
        // The whole row, its second line too, is one element.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(r, clock: asClock))
    }

    /// Next, Then and After, on one baseline, so a large figure sits level with the small ones.
    private func times(_ r: BoardRow) -> some View {
        let buses = r.buses
        let pick = Self.pick(buses)
        return HStack(alignment: .lastTextBaseline, spacing: 0) {
            ForEach(0..<3, id: \.self) { i in
                time(Self.cell(buses[i], prev: i > 0 ? buses[i - 1] : nil, first: i == 0, clock: asClock), pick: i == pick)
                    .fixedSize()
                    .frame(width: layout.columns[i], alignment: .trailing)
                    .padding(.leading, layout.gap)
            }
        }
    }

    /// In the service's colour, as on the buses and the map, every badge the
    /// same width. A public bus carries a $ so the fare is never a surprise.
    private func badge(_ r: BoardRow) -> some View {
        let fill = r.color.flatMap(Color.init(hex:))
        return Text(r.pillID)
            .font(Font(NearbyLayout.badgeFont()))
            .fixedSize()
            .frame(width: layout.badge, height: 24)
            .foregroundStyle(fill != nil ? inkOn(r.color ?? "") : Color.primary)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous).fill(
                    fill.map(AnyShapeStyle.init) ?? AnyShapeStyle(.primary.opacity(0.1))))
    }

    /// The place in ink, the words around it ("to", "via") muted. A place
    /// that fits on a line of `width` is kept whole, so it moves to the next
    /// line rather than breaking ("to / Buona Vista Int").
    static func destination(_ r: BoardRow, width: CGFloat) -> Text {
        let d = dest(r)
        guard let place = d.place.map({ keptWhole($0, width: width) }) else { return Text(d.lead).foregroundColor(.secondary) }
        return Text(d.lead).foregroundColor(.secondary) + Text(place).fontWeight(.semibold).foregroundColor(.primary)
            + Text(d.trail).foregroundColor(.secondary)
    }

    /// `place` with non-breaking spaces when it fits on a line of `width`
    /// whole, so it moves to the next line rather than breaking; with
    /// ordinary ones otherwise (the server's too), so it breaks rather than being cut.
    nonisolated static func keptWhole(_ place: String, width: CGFloat) -> String {
        NearbyLayout.width(place, NearbyLayout.place()) <= width
            ? place.replacingOccurrences(of: " ", with: "\u{00a0}") : place.replacingOccurrences(of: "\u{00a0}", with: " ")
    }

    /// One bus's time, as `cell` words it: the figures in the board's font and
    /// the words small; the next bus large and in ink.
    private func time(_ c: Cell, pick: Bool) -> some View {
        let s = layout.scale
        let big = Font(NearbyLayout.figures(pick: pick, clock: asClock, scale: s))
        let small = Font(NearbyLayout.unit(scale: s))
        return (Text(c.mark).font(big) + Text(c.lead).font(small) + Text(c.figure).font(big) + Text(c.trail).font(small))
            .foregroundStyle(pick ? .primary : .secondary).lineLimit(1).contentTransition(.numericText())
    }

    /// A time as Nearby sets it: `mark` ("~") and `figure` ("4", "6:02")
    /// large, `lead` ("下午 ") and `trail` (" min", " PM") small around the figure.
    struct Cell: Equatable {
        var mark = ""
        var lead = ""
        var figure: String
        var trail = ""
        var whole: String { mark + lead + figure + trail }
    }

    /// The bus set large: Next, when it has a time; nil when it hasn't.
    nonisolated static func pick(_ buses: [NearbyBus?]) -> Int? {
        buses.first??.etaS != nil ? 0 : nil
    }

    /// One cell of Next, Then or After. Only Next (`first`) carries a unit
    /// ("4 min", "6:02 PM"); Then and After are figures ("16", "~28"), with
    /// AM/PM where the half of the day changes from the cell before (`prev`),
    /// as a printed timetable does. An estimate is "~" in both languages: in
    /// a column of figures "约" reads as part of the next. A dash with no bus.
    nonisolated static func cell(_ bus: NearbyBus?, prev: NearbyBus?, first: Bool, clock: Bool) -> Cell {
        guard let b = bus, b.etaS != nil else { return Cell(figure: "–") }
        let mark = b.approx ? "~" : ""
        if clock, let d = b.at.flatMap(parseISODate) {
            let whole = campusTime(d).trimmingCharacters(in: .whitespaces)
            let (figure, half) = clockParts(whole)
            // By the hour, not the words: Chinese names more parts of the day (中午, 晚上) than two halves.
            let changed = prev?.at.flatMap(parseISODate).map { isPM($0) != isPM(d) } ?? true
            guard !half.isEmpty, first || changed else { return Cell(mark: mark, figure: figure) }
            // Chinese writes 下午 before the time, English PM after it.
            return whole.hasPrefix(half)
                ? Cell(mark: mark, lead: half + " ", figure: figure)
                : Cell(mark: mark, figure: figure, trail: " " + half)
        }
        let words = words(b)
        // "now": no figure to set large; shown as it is.
        guard let n = words.range(of: #"\d+"#, options: .regularExpression) else { return Cell(figure: words) }
        return Cell(mark: mark, figure: String(words[n]), trail: first ? String(words[n.upperBound...]) : "")
    }

    /// A clock time's figures ("6:02", "18.02" where the Mac's region writes
    /// a dot) and the words round them ("PM", "下午"): none in 24-hour time.
    nonisolated static func clockParts(_ time: String) -> (figure: String, half: String) {
        guard let r = time.range(of: #"\d+(?:[:.]\d+)*"#, options: .regularExpression) else { return (time, "") }
        return (String(time[r]), (time[..<r.lowerBound] + time[r.upperBound...]).trimmingCharacters(in: .whitespaces))
    }

    /// Whether `d` is after noon on campus.
    nonisolated static func isPM(_ d: Date) -> Bool {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = .campus
        return c.component(.hour, from: d) >= 12
    }

    /// Where a row's bus is going, as the server words it ("to PGP Foyer",
    /// "via UTown"), split round the place in it; an older server's end of
    /// the line, all muted, otherwise.
    nonisolated static func dest(_ r: BoardRow) -> (lead: String, place: String?, trail: String) {
        guard let d = r.dest else { return (to(r), nil, "") }
        guard let p = r.destPlace, !p.isEmpty, let i = d.range(of: p) else { return (d, nil, "") }
        return (String(d[..<i.lowerBound]), p, String(d[i.upperBound...]))
    }

    /// Under the stops: what a "~" means, only when one is showing.
    nonisolated static func foot(_ stops: [NearbyStop], clock: Bool) -> [String] {
        let cells = stops.filter(\.available).flatMap(\.board).flatMap { r in
            let b = r.buses
            return (0..<3).map { cell(b[$0], prev: $0 > 0 ? b[$0 - 1] : nil, first: $0 == 0, clock: clock) }
        }
        return cells.contains { $0.mark == "~" } ? [L("~ is a guess from the timetable, not a live time.")] : []
    }

    /// Each row's id: its service, and a repeat numbered (a two-way public
    /// bus, 151/1 and 151/2, is two rows named 151 at one stop), so ids are
    /// unique yet stay put from one refresh to the next.
    nonisolated static func pillIDs(_ rows: [BoardRow]) -> [String] {
        var seen: [String: Int] = [:]
        return rows.map { r in
            let n = seen[r.pillID, default: 0]
            seen[r.pillID] = n + 1
            return n == 0 ? r.pillID : "\(r.pillID)#\(n)"
        }
    }

    /// The server's "4 min"; worked out here for an older server.
    nonisolated static func eta(_ r: BoardRow) -> String { r.eta ?? eta(etaS: r.etaS, quality: r.quality) }

    /// "4 min", "~6 min" for an estimate, "now", or "ended", as the server words it
    /// ("4m" would be read as metres); worked out here for an older server.
    /// A guess is never "now": under a minute it's "~1 min".
    nonisolated static func eta(etaS: Int?, quality: String) -> String {
        guard let s = etaS else { return quality == "ended" ? L("ended") : "–" }
        if s < 45 { return quality == "scheduled" || quality == "stale" ? L("~%@", L("%@ min", "1")) : L("now") }
        let m = L("%@ min", "\((s + 30) / 60)")
        return quality == "scheduled" ? L("~%@", m) : m
    }

    /// A bus's minutes as words: the server's ("4 min", "约 6 分钟"), or
    /// worked out here. A guess is never "now", whoever worded it: "~1 min".
    nonisolated static func words(_ b: NearbyBus) -> String {
        let w = b.eta ?? eta(etaS: b.etaS, quality: b.quality)
        guard b.approx, w.range(of: #"\d"#, options: .regularExpression) == nil else { return w }
        return L("~%@", L("%@ min", "1"))
    }

    /// A wait in words, from its seconds: "1 minute", "6 minutes", "under a minute", as the iPhone and Android say it.
    nonisolated static func saidMinutes(_ seconds: Int) -> String {
        if seconds < 30 { return L("under a minute") }
        let m = (seconds + 30) / 60
        return m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
    }

    /// "~09:42" as it's said: "about 09:42".
    nonisolated static func spell(_ text: String) -> String {
        text.replacingOccurrences(of: #"~\s?"#, with: L("about") + (Lang.zh ? "" : " "), options: .regularExpression)
    }

    /// One bus as VoiceOver says it, worded as Android and the iPhone word it:
    /// in minutes "13 minutes", "about 25 minutes" for a guess, "Arriving" for
    /// a live bus under 45 s, and the first bus (`first`) with how sure it is
    /// ("1 minute, live", "about 6 minutes, estimated"); in clock times
    /// "12:20 PM", "about 12:20 PM", the first with its wait ("12:09 PM, in
    /// 13 minutes"). Nil with no bus. Minutes from an older server that sends no clock time.
    nonisolated static func said(_ b: NearbyBus, clock: Bool, first: Bool) -> String? {
        guard let s = b.etaS else { return nil }
        if clock, let d = b.at.flatMap(parseISODate) {
            let t = spell((b.approx ? "~" : "") + campusTime(d))
            // A guess is never under a minute away.
            let wait = b.quality == "live" ? saidMinutes(s) : L("about %@", saidMinutes(max(s, 60)))
            return first ? L("%@, in %@", t, wait) : t
        }
        if s < 45 && b.quality == "live" { return L("Arriving") }
        let m = saidMinutes(max(s, b.quality == "live" ? 0 : 60))
        return switch b.quality {
        case "scheduled": first ? L("about %@, estimated", m) : L("about %@", m)
        case "live": first ? L("%@, live", m) : m
        // Any other quality is no live time either: never said as one.
        default: L("about %@", m)
        }
    }

    /// Where a row's bus is going, "to Kent Ridge MRT", or that this is the
    /// end of its line: an older server's, which sends no `dest`.
    nonisolated static func to(_ r: BoardRow) -> String {
        if let end = r.towards?.last { return L("to %@", end) }
        return r.toText ?? L("Ends here")
    }

    /// "Bus D2, via PGP, 2 minutes, live, then 14 minutes, then about 26
    /// minutes", as Android reads a row: the line, where it's going, then each
    /// bus in order. Chinese punctuation in Chinese.
    nonisolated static func spoken(_ r: BoardRow, clock: Bool) -> String {
        let d = dest(r)
        var parts = [r.paid == true ? L("Public bus %@, fare applies", r.svc) : L("Bus %@", r.svc), d.lead + (d.place ?? "") + d.trail]
        for (i, b) in r.buses.enumerated() {
            guard let b, let t = said(b, clock: clock, first: i == 0) else { continue }
            parts.append(i > 0 ? L("then %@", t) : t)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: L(", "))
    }
}

/// Today, from /api/me/day: each class with when to leave (or the bus you're
/// on), and the trips home. What's done is dimmed, a skipped class struck through.
struct TodayList: View {
    let day: DayPlan
    var removed: DayPlan.Item? = nil
    /// Where `removed` was: above the entry that followed it (nil at the end),
    /// or at `removedAt` should that one go too. Its row stays there, so nothing moves.
    var removedAt = 0
    var removedBefore: String? = nil
    /// An entry the server wouldn't take off, back in its place, and why.
    var failed: (key: String, message: String)? = nil
    var onRemove: (DayPlan.Item) -> Void = { _ in }
    var onUndo: () -> Void = {}

    var body: some View {
        let at = removedBefore.map { k in day.items.firstIndex { $0.key == k } ?? min(removedAt, day.items.count) } ?? day.items.count
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: L("Today"))
            ForEach(Array(day.items.enumerated()), id: \.element.id) { i, item in
                if i == at, let r = removed { RemovedRow(item: r, onUndo: onUndo) }
                TodayRow(item: item, onRemove: onRemove)
                if let f = failed, f.key == item.key {
                    Label(f.message, systemImage: "exclamationmark.circle")
                        .font(.caption)
                        .foregroundStyle(Color.bad)
                        .padding(.leading, 68)
                        .fixedSize(horizontal: false, vertical: true)
                        .announced(f.message)
                }
            }
            if at == day.items.count, let r = removed { RemovedRow(item: r, onUndo: onUndo) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Where an entry was just taken off: "GEA1000 removed from today", with Undo for a few seconds.
private struct RemovedRow: View {
    let item: DayPlan.Item
    let onUndo: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(parseISODate(item.startsAt).map(campusTime) ?? "")
                .font(.callout.monospacedDigit())
                .frame(width: 58, alignment: .leading)
            Text(L("%@ removed from today", item.kind == "home" ? L("The trip home") : item.label.components(separatedBy: " @ ")[0])).font(
                .callout)
            Spacer(minLength: 0)
            Button(L("Undo"), action: onUndo).buttonStyle(.plain).foregroundStyle(.tint).fontWeight(.medium)
        }
        .foregroundStyle(.secondary)
    }
}

/// One of today's entries; anything still to come has an × on hover to take it off today.
private struct TodayRow: View {
    /// Its status in words: what the dimming, the strike and the bold say.
    private var status: String {
        switch item.status {
        case "done": L("Over")
        case "skipped": L("Skipped")
        case "next", "now": L("Next")
        default: ""
        }
    }

    let item: DayPlan.Item
    let onRemove: (DayPlan.Item) -> Void
    @State private var hovering = false
    @FocusState private var removeFocused: Bool
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        let past = item.status == "done" || item.status == "skipped"
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(parseISODate(item.startsAt).map(campusTime) ?? "")
                .font(.callout.monospacedDigit().weight(item.status == "next" || item.status == "now" ? .semibold : .regular))
                .frame(width: 58, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(item.title).font(.callout).strikethrough(item.status == "skipped")
                if let sub = item.sub { Text(sub).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 0)
            if item.removable == true {
                // Shown on hover, and when the keyboard reaches it. VoiceOver
                // has the row's action instead, so it isn't offered twice.
                Button {
                    onRemove(item)
                } label: {
                    Image(systemName: "xmark").font(.caption.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .focused($removeFocused)
                .opacity(hovering || removeFocused ? 1 : 0)
                .help(L("Remove from today"))
                .accessibilityHidden(true)
            }
        }
        .opacity(past ? (contrast == .increased ? 0.7 : 0.5) : 1)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        // One element per row; the hover-only × is its "Remove from today" action.
        .accessibilityElement(children: .combine)
        // Dimmed or struck through on screen: said in words.
        .accessibilityValue(status)
        .accessibilityActions {
            if item.removable == true { Button(L("Remove from today")) { onRemove(item) } }
        }
    }
}
