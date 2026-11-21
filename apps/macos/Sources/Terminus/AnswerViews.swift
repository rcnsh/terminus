import SwiftUI

struct AnswerDetail: View {
    let answer: NextAnswer?
    var busy = false
    var failed: String? = nil
    var undoShownFor: String? = nil
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
                    NextClass(answer: a)
                    Row(icon: "location", text: L("Buses near you are under Nearby.")).foregroundStyle(.secondary)
                } else if old {
                    EmptyView()
                } else if a.isClassPlan {
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
                    NextClass(answer: a)
                } else if let j = a.card?.journey {
                    JourneyRows(journey: j)
                } else {
                    Row(icon: a.mode == "rest" ? "calendar" : "text.alignleft", text: a.detail)
                    if let leave = a.leaveText() { Row(icon: "figure.walk", text: leave).fontWeight(.semibold) }
                }
                if !old, !a.isFree, let step = a.card?.step {
                    StepButtons(step: step, onStep: onStep).disabled(busy).padding(.top, 2)
                }
                let timing = a.card?.ride == nil ? a.timing?.text : nil
                if !old, !a.isClassPlan, !a.isFree, timing != nil || a.crowdText != nil {
                    HStack(spacing: 6) {
                        if let t = a.timing, let text = timing {
                            Pill(text: text, color: t.status == "late" ? .bad : t.status == "tight" ? .warn : .good)
                        }
                        if let c = a.crowdText { Pill(text: c, color: .secondary) }
                    }
                }
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
            } else if let failed {
                Text(failed).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<3, id: \.self) { i in
                        HStack(spacing: 8) {
                            SkeletonBar(width: 12, height: 12, radius: 6).frame(width: 14)
                            SkeletonLine(font: .callout, fraction: [0.8, 0.62, 0.5][i])
                        }
                    }
                }
                .shimmering()
                .skeletonSpoken()
            }
        }
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
        .card()
    }

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

    struct StepButtons: View {
        let step: NextAnswer.Step
        let onStep: (NextAnswer.Step, StepTarget?, StepDirection?) -> Void

        var body: some View {
            HStack(spacing: 6) {
                Button {
                    onStep(step, step.earlier, .earlier)
                } label: {
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
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            } else {
                Row(icon: "calendar", text: answer.detail)
            }
        }

        private struct Tight: LabelStyle {
            func makeBody(configuration: Configuration) -> some View {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    configuration.icon.font(.system(size: 10))
                    configuration.title
                }
            }
        }
    }

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
                    if let change = ride.change { Text(change.text).font(.caption).foregroundStyle(.secondary) }
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(L("Ride progress"))
                .accessibilityValue(
                    [Self.spoken(ride.stops.map(\.name), passed: passed), ride.change?.text].compactMap { $0 }.joined(separator: " "))
            }
        }

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

struct NearbyList: View {
    let stops: [NearbyStop]?
    @State private var rowWidth: CGFloat? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let all = stops {
                let layout = NearbyLayout(all, rowWidth: rowWidth)
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
                            NearbyBoard(rows: s.board, layout: layout)
                                .onGeometryChange(for: CGFloat.self) {
                                    $0.size.width
                                } action: {
                                    rowWidth = $0
                                }
                        }
                    }
                    .card(padding: 10)
                }
                let foot = NearbyBoard.foot(all)
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
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<2, id: \.self) { k in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                SkeletonLine(font: .system(size: 13, weight: .semibold), points: [70, 90][k])
                                Spacer()
                                SkeletonLine(font: .system(size: 11), points: 50)
                            }
                            .padding(.bottom, 4)
                            ForEach(0..<3, id: \.self) { i in
                                if i > 0 { Rectangle().fill(.primary.opacity(0.08)).frame(height: 1) }
                                HStack(spacing: 8) {
                                    SkeletonBar(width: 30, height: 18)
                                    SkeletonLine(font: Font(NearbyLayout.words()), fraction: SkeletonWidths.sub(k * 3 + i))
                                    SkeletonLine(font: .system(size: 17, weight: .bold), points: 38)
                                    SkeletonLine(font: .system(size: 13), points: 20)
                                    SkeletonLine(font: .system(size: 13), points: 20)
                                }
                                .padding(.vertical, 5)
                            }
                        }
                        .card(padding: 10)
                    }
                }
                .shimmering()
                .skeletonSpoken()
            }
        }
    }
}

struct NearbyLayout {
    var badge: CGFloat
    var columns: [CGFloat]
    var scale: CGFloat = 1
    var gap = Self.columnGap
    var stacks = false
    var rowWidth: CGFloat? = nil

    static let badgePadding: CGFloat = 6
    static let destGap: CGFloat = 8
    static let columnGap: CGFloat = 12
    static let tightGap: CGFloat = 8
    static let minScale: CGFloat = 0.85
    static let headingTracking: CGFloat = 0.6

    static func figures(pick: Bool, scale: CGFloat = 1) -> NSFont {
        let size = (pick ? 19 : 14) * scale
        let plain = NSFont.monospacedDigitSystemFont(ofSize: size, weight: pick ? .bold : .semibold)
        return plain.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: size) } ?? plain
    }
    static func unit(scale: CGFloat = 1) -> NSFont { .systemFont(ofSize: 10 * scale, weight: .medium) }
    static func badgeFont() -> NSFont {
        let plain = NSFont.systemFont(ofSize: 13, weight: .bold)
        return plain.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 13) } ?? plain
    }
    static func heading() -> NSFont { .systemFont(ofSize: 9.5, weight: .semibold) }
    static func words() -> NSFont { .systemFont(ofSize: 13) }
    static func place() -> NSFont { .systemFont(ofSize: 13, weight: .semibold) }
    static var badgeMin: CGFloat { width("D2", badgeFont()) + 2 * badgePadding }

    init(_ stops: [NearbyStop], rowWidth: CGFloat?) {
        let rows = stops.filter(\.available).flatMap(\.board)
        badge = max(Self.badgeMin, rows.map { Self.width($0.pillID, Self.badgeFont()) + 2 * Self.badgePadding }.max() ?? 0)
        let heads = [L("Next"), L("Then"), L("After")].map {
            Self.width($0.uppercased(with: Lang.locale), Self.heading(), tracking: Self.headingTracking)
        }
        let columns = { (scale: CGFloat) in
            (0..<3).map { i in
                rows.map { r in
                    let b = r.buses
                    return Self.width(NearbyBoard.cell(b[i], first: i == 0), pick: i == NearbyBoard.pick(b), scale: scale)
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
        self.columns = full
        scale = 1
        gap = Self.columnGap
        stacks = true
    }

    func destWidth(stacked: Bool) -> CGFloat {
        guard let rowWidth else { return .infinity }
        return rowWidth - badge - Self.destGap - (stacked ? 0 : columns.reduce(0, +) + 3 * gap)
    }

    static func fits(_ r: BoardRow, width: CGFloat) -> Bool {
        longestWord(r) <= width && lines(r, width: width) <= 2
    }

    static func longestWord(_ r: BoardRow) -> CGFloat {
        let d = NearbyBoard.dest(r)
        let words = (d.lead + d.trail).split(whereSeparator: \.isWhitespace).map { width(String($0), Self.words()) }
        let place = (d.place ?? "").split(whereSeparator: \.isWhitespace).map { width(String($0), Self.place()) }
        return (words + place).max() ?? 0
    }

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

    static func width(_ c: NearbyBoard.Cell, pick: Bool, scale: CGFloat = 1) -> CGFloat {
        let big = figures(pick: pick, scale: scale)
        let small = unit(scale: scale)
        let s = NSMutableAttributedString()
        for (text, font) in [(c.mark, big), (c.figure, big), (c.trail, small)] where !text.isEmpty {
            s.append(NSAttributedString(string: text, attributes: [.font: font]))
        }
        return ceil(s.size().width) + 1
    }

    static func width(_ text: String, _ font: NSFont, tracking: CGFloat = 0) -> CGFloat {
        ceil(NSAttributedString(string: text, attributes: [.font: font, .kern: tracking]).size().width) + 1
    }
}

struct NearbyBus: Hashable {
    let etaS: Int?
    let quality: String
    var eta: String? = nil

    init(etaS: Int?, quality: String, eta: String? = nil) {
        self.etaS = etaS
        self.quality = quality
        self.eta = eta
    }
    init(_ r: BoardRow) { self.init(etaS: r.etaS, quality: r.quality, eta: r.eta) }
    init(_ l: BoardRow.Later) { self.init(etaS: l.etaS, quality: l.quality, eta: l.eta) }

    var approx: Bool { quality == "scheduled" || quality == "stale" }
}

extension BoardRow {
    var pillID: String { paid == true ? "\(svc) $" : svc }
    var buses: [NearbyBus?] {
        let l = later ?? []
        return [NearbyBus(self), l.first.map(NearbyBus.init), l.count > 1 ? NearbyBus(l[1]) : nil]
    }
}

struct NearbyBoard: View {
    let rows: [BoardRow]
    let layout: NearbyLayout

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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.spoken(r))
    }

    private func times(_ r: BoardRow) -> some View {
        let buses = r.buses
        let pick = Self.pick(buses)
        return HStack(alignment: .lastTextBaseline, spacing: 0) {
            ForEach(0..<3, id: \.self) { i in
                time(Self.cell(buses[i], first: i == 0), pick: i == pick)
                    .fixedSize()
                    .frame(width: layout.columns[i], alignment: .trailing)
                    .padding(.leading, layout.gap)
            }
        }
    }

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

    static func destination(_ r: BoardRow, width: CGFloat) -> Text {
        let d = dest(r)
        guard let place = d.place.map({ keptWhole($0, width: width) }) else { return Text(d.lead).foregroundColor(.secondary) }
        return Text(d.lead).foregroundColor(.secondary) + Text(place).fontWeight(.semibold).foregroundColor(.primary)
            + Text(d.trail).foregroundColor(.secondary)
    }

    nonisolated static func keptWhole(_ place: String, width: CGFloat) -> String {
        NearbyLayout.width(place, NearbyLayout.place()) <= width
            ? place.replacingOccurrences(of: " ", with: "\u{00a0}") : place.replacingOccurrences(of: "\u{00a0}", with: " ")
    }

    private func time(_ c: Cell, pick: Bool) -> some View {
        let s = layout.scale
        let big = Font(NearbyLayout.figures(pick: pick, scale: s))
        let small = Font(NearbyLayout.unit(scale: s))
        return (Text(c.mark).font(big) + Text(c.figure).font(big) + Text(c.trail).font(small))
            .foregroundStyle(pick ? .primary : .secondary).lineLimit(1).contentTransition(.numericText())
    }

    struct Cell: Equatable {
        var mark = ""
        var figure: String
        var trail = ""
        var whole: String { mark + figure + trail }
    }

    nonisolated static func pick(_ buses: [NearbyBus?]) -> Int? {
        buses.first??.etaS != nil ? 0 : nil
    }

    nonisolated static func cell(_ bus: NearbyBus?, first: Bool) -> Cell {
        guard let b = bus, b.etaS != nil else { return Cell(figure: "–") }
        let mark = b.approx ? "~" : ""
        let words = words(b)
        guard let n = words.range(of: #"\d+"#, options: .regularExpression) else { return Cell(figure: words) }
        return Cell(mark: mark, figure: String(words[n]), trail: first ? String(words[n.upperBound...]) : "")
    }

    nonisolated static func dest(_ r: BoardRow) -> (lead: String, place: String?, trail: String) {
        guard let d = r.dest else { return (to(r), nil, "") }
        guard let p = r.destPlace, !p.isEmpty, let i = d.range(of: p) else { return (d, nil, "") }
        return (String(d[..<i.lowerBound]), p, String(d[i.upperBound...]))
    }

    nonisolated static func foot(_ stops: [NearbyStop]) -> [String] {
        let cells = stops.filter(\.available).flatMap(\.board).flatMap { r in
            let b = r.buses
            return (0..<3).map { cell(b[$0], first: $0 == 0) }
        }
        return cells.contains { $0.mark == "~" } ? [L("~ is a guess from the timetable, not a live time.")] : []
    }

    nonisolated static func pillIDs(_ rows: [BoardRow]) -> [String] {
        var seen: [String: Int] = [:]
        return rows.map { r in
            let n = seen[r.pillID, default: 0]
            seen[r.pillID] = n + 1
            return n == 0 ? r.pillID : "\(r.pillID)#\(n)"
        }
    }

    nonisolated static func eta(_ r: BoardRow) -> String { r.eta ?? eta(etaS: r.etaS, quality: r.quality) }

    nonisolated static func eta(etaS: Int?, quality: String) -> String {
        guard let s = etaS else { return quality == "ended" ? L("ended") : "–" }
        if s < 45 { return quality == "scheduled" || quality == "stale" ? L("~%@", L("%@ min", "1")) : L("now") }
        let m = L("%@ min", "\((s + 30) / 60)")
        return quality == "scheduled" || quality == "stale" ? L("~%@", m) : m
    }

    nonisolated static func words(_ b: NearbyBus) -> String {
        let w = b.eta ?? eta(etaS: b.etaS, quality: b.quality)
        guard b.approx, w.range(of: #"\d"#, options: .regularExpression) == nil else { return w }
        return L("~%@", L("%@ min", "1"))
    }

    nonisolated static func saidMinutes(_ seconds: Int) -> String {
        let m = (seconds + 30) / 60
        return m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
    }

    nonisolated static func said(_ b: NearbyBus, first: Bool) -> String? {
        guard let s = b.etaS else { return nil }
        if s < 45 && b.quality == "live" { return L("Arriving") }
        let m = saidMinutes(max(s, b.quality == "live" ? 0 : 60))
        return switch b.quality {
        case "scheduled": first ? L("about %@, estimated", m) : L("about %@", m)
        case "live": first ? L("%@, live", m) : m
        default: L("about %@", m)
        }
    }

    nonisolated static func to(_ r: BoardRow) -> String {
        if let end = r.towards?.last { return L("to %@", end) }
        return r.toText ?? L("Ends here")
    }

    nonisolated static func spoken(_ r: BoardRow) -> String {
        let d = dest(r)
        var parts = [r.paid == true ? L("Public bus %@, fare applies", r.svc) : L("Bus %@", r.svc), d.lead + (d.place ?? "") + d.trail]
        for (i, b) in r.buses.enumerated() {
            guard let b, let t = said(b, first: i == 0) else { continue }
            parts.append(i > 0 ? L("then %@", t) : t)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: L(", "))
    }
}

struct TodayList: View {
    let day: DayPlan
    var removed: DayPlan.Item? = nil
    var removedAt = 0
    var removedBefore: String? = nil
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

private struct TodayRow: View {
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
        .accessibilityElement(children: .combine)
        .accessibilityValue(status)
        .accessibilityActions {
            if item.removable == true { Button(L("Remove from today")) { onRemove(item) } }
        }
    }
}
