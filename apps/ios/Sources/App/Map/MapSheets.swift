import SwiftUI
import UIKit

// The sheets over the bottom of the map: a tapped stop's times, and a tapped
// bus's card. As Android's StopSheet and BusSheet, which share a frame so the
// two read alike.

/// The rows a stop's sheet shows before "Show more", so the map stays in view.
private let peekRows = 3

/// The frame a stop's sheet and a bus's share: a grab handle; a `lead` tile
/// beside the title, `sub` and close; a line of `facts`; then `content` (a
/// SectionBand and its rows), edge to edge; then the `footer`'s buttons under
/// a divider, which stay in view while the rows scroll.
///
/// The grab handle does what it promises: dragged down, the sheet follows
/// the finger and closes. `handle`, when set, comes first: a drag up or a tap
/// on the handle opens what it holds (true, or nil to toggle), and a drag
/// down closes that (false) before the sheet, returning whether it changed anything.
private struct SheetFrame<Lead: View, Facts: View, Content: View, Footer: View>: View {
    let title: String
    let sub: String?
    let close: () -> Void
    /// Back to the bus this stop was opened from; nil when it wasn't.
    var back: (() -> Void)? = nil
    var handle: ((Bool?) -> Bool)? = nil
    /// Buttons under the rows; without them the rows end the sheet.
    var footerShown = true
    @ViewBuilder let lead: () -> Lead
    @ViewBuilder let facts: () -> Facts
    @ViewBuilder let content: () -> Content
    @ViewBuilder let footer: () -> Footer

    @State private var dragged: CGFloat = 0
    /// How tall the header and rows are, for the sheet to be no taller.
    @State private var contentHeight: CGFloat = 200
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AccessibilityFocusState private var titleFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            // Taller than the room it has, the header and rows scroll; the
            // footer's buttons stay in view under them.
            ScrollView(.vertical) {
                scrolled.onGeometryChange(for: CGFloat.self) {
                    $0.size.height
                } action: {
                    contentHeight = $0
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .noScrollEdgeEffect()
            .frame(height: min(contentHeight, maxHeight))
            if footerShown {
                Divider().overlay(Color.line)
                HStack(spacing: 8) { footer() }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
            }
        }
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20, style: .continuous))
        // The shadow is the sheet's own, not cast by each band and row inside it.
        .background {
            UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20, style: .continuous)
                .fill(Color.surface)
                .shadow(color: .black.opacity(0.16), radius: 12, y: -2)
        }
        .overlay(
            UnevenRoundedRectangle(topLeadingRadius: 20, topTrailingRadius: 20, style: .continuous).strokeBorder(Color.line, lineWidth: 0.5)
        )
        .offset(y: max(0, dragged))
        // VoiceOver moves to its title when it opens, or shows another stop or bus.
        .onAppear { titleFocused = true }
    }

    /// No taller than about half the screen, so the map stays in view above it.
    private var maxHeight: CGFloat {
        let h = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.screen.bounds.height ?? 800
        return min(460, h * 0.5)
    }

    private var scrolled: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                grabber
                HStack(alignment: .center, spacing: 12) {
                    if let back {
                        Button(action: back) {
                            Image(systemName: "chevron.backward")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Color.ink)
                                .frame(width: 32, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(L("Back"))
                        .accessibilityIdentifier("map.sheet.back")
                    }
                    lead()
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: title)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityFocused($titleFocused)
                            .accessibilityIdentifier("map.sheet.title")
                        if let sub {
                            Text(verbatim: sub).font(.subheadline).foregroundStyle(Color.muted)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(action: close) {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(Color.muted)
                            .frame(width: 30, height: 30)
                            .background(Color.surface2, in: Circle())
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("Close"))
                    .accessibilityIdentifier("map.sheet.close")
                }
                .padding(.leading, back == nil ? 16 : 6)
                .padding(.trailing, 6)
                facts().padding(.horizontal, 16).padding(.top, 10)
            }
            .contentShape(Rectangle())
            .gesture(drag)
            content().padding(.top, 12)
            if !footerShown { Spacer().frame(height: 16) }
        }
    }

    /// The grab handle; with `handle`, a tap on it opens or closes what it holds.
    private var grabber: some View {
        Capsule()
            .fill(Color.lineStrong.opacity(0.5))
            .frame(width: 36, height: 5)
            .frame(maxWidth: .infinity, minHeight: 20)
            .contentShape(Rectangle())
            .onTapGesture { _ = handle?(nil) }
            .accessibilityHidden(true)
    }

    /// Up past a few points, `handle` opens; down far enough or flung,
    /// `handle` closes, else the sheet does. While dragging down the sheet
    /// follows the finger, and springs back if let go short.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { dragged = $0.translation.height }
            .onEnded { v in
                let d = v.translation.height
                let flung = v.predictedEndTranslation.height - d > 200
                if d < -24 {
                    _ = handle?(true)
                } else if d > 96 || (d > 24 && flung) {
                    if handle?(false) != true { close() }
                }
                withAnimation(reduceMotion ? nil : .spring(duration: 0.3)) { dragged = 0 }
            }
    }
}

extension View {
    /// The sheet is its own surface: no fade where its rows scroll under the
    /// header and footer (iOS 26 draws one by default).
    @ViewBuilder fileprivate func noScrollEdgeEffect() -> some View {
        if #available(iOS 26.0, *) {
            scrollEdgeEffectHidden(true, for: .all)
        } else {
            self
        }
    }
}

/// The sheet's buttons: filled in the brand colour for the one thing it's
/// for ("Go there"), outlined for anything else; as wide as they can be.
private struct SheetButtonStyle: ButtonStyle {
    var filled = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(filled ? Color.white : Color.ink)
            .frame(maxWidth: .infinity, minHeight: 44)
            .padding(.horizontal, 14)
            .background(filled ? Color.brand : Color.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(filled ? Color.clear : Color.line))
            .opacity(configuration.isPressed ? 0.75 : enabled ? 1 : 0.5)
            .contentShape(Capsule())
    }
}

/// The tile that leads a sheet's header, the same size for a stop as for a bus.
private struct SheetTile<Content: View>: View {
    let fill: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(width: 48, height: 48)
            .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A grey band naming what's under it, the same on a stop's sheet ("Buses
/// here") as on a bus's ("Stops ahead"). With `toggle`, it opens and closes
/// what's under it, and a chevron says so.
private struct SectionBand: View {
    let text: String
    var open = true
    var toggle: (() -> Void)? = nil

    var body: some View {
        if let toggle {
            Button(action: toggle) { band }
                .buttonStyle(.plain)
                .accessibilityValue(open ? L("Expanded") : L("Collapsed"))
                .accessibilityIdentifier("map.sheet.band")
        } else {
            band.accessibilityAddTraits(.isHeader)
        }
    }

    private var band: some View {
        HStack(spacing: 4) {
            Text(text).font(.subheadline.weight(.medium)).foregroundStyle(Color.muted)
            Spacer(minLength: 6)
            if toggle != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.muted)
                    .rotationEffect(.degrees(open ? -90 : 90))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, minHeight: 44)
        .background(Color.surface2)
        .contentShape(Rectangle())
    }
}

/// A service's code on its colour, as on the bus.
private struct SvcChip: View {
    let svc: String
    let hex: String?
    var paid = false
    var faded = false

    var body: some View {
        let rgb = hex.flatMap(hexRGB) ?? 0x8A939C
        Text(verbatim: paid ? "\(svc) $" : svc)
            .font(.system(size: 14, weight: .heavy))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(inkOn(rgb))
            .padding(.horizontal, 8)
            .frame(minWidth: 42, minHeight: 28)
            .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .opacity(faded ? 0.35 : 1)
            .accessibilityLabel(paid ? L("Public bus %@, fare applies", svc) : L("Bus %@", svc))
    }
}

// MARK: - A stop

/// A tapped stop: its board as the Buses tab has it, the first few rows
/// until asked for the rest, and ways to go there. A row tapped shows its
/// service on the map, and again hides it.
struct StopSheet: View {
    let stop: MapStop
    let map: MapModel
    let campus: CampusMap
    /// It was opened from a bus's sheet, which is still there to go back to.
    let back: Bool
    @State private var all = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        SheetFrame(
            title: stop.name,
            sub: stop.longName.flatMap { $0 == stop.name ? nil : $0 },
            close: map.closeSheet,
            back: back ? { map.back() } : nil
        ) {
            // A stop's tile, where a bus's has its service: the two headers line up.
            SheetTile(fill: Color.surface2) {
                Image(systemName: "mappin.and.ellipse")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(Color.ink)
            }
            .accessibilityHidden(true)
        } facts: {
            EmptyView()
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                SectionBand(text: L("Buses here"))
                rows
            }
        } footer: {
            footer
        }
    }

    @ViewBuilder private var rows: some View {
        if let note {
            VStack(alignment: .leading, spacing: 12) {
                Text(note).font(.subheadline).foregroundStyle(Color.muted)
                // No times to list them by: the services here, each showing its line.
                if note != L("Refreshing") {
                    HStack(spacing: 6) {
                        ForEach(stop.services, id: \.self) { svc in
                            Button {
                                if map.selected != svc { map.choose(svc) }
                            } label: {
                                SvcChip(svc: svc, hex: campus.color(svc))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(L("%@ on the map", svc))
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if let board = map.board?.aged(ServerClock.now) {
            let sorted = board.rows.filter(\.running) + board.rows.filter { !$0.running }
            let more = sorted.count - peekRows
            let shown = all || more <= 1 ? sorted : Array(sorted.prefix(peekRows))
            VStack(spacing: 0) {
                ForEach(Array(shown.enumerated()), id: \.offset) { i, r in
                    if i > 0 { Divider().overlay(Color.line) }
                    StopRow(row: r, hex: r.color ?? campus.color(r.svc), picked: map.selected == r.svc) {
                        // A row picks its line here, as the pills do, and again unpicks it.
                        map.choose(r.svc)
                    }
                }
                if more > 1 {
                    Divider().overlay(Color.line)
                    Button(all ? L("Show fewer") : L("Show %@ more", "\(more)")) {
                        withAnimation(.easeInOut(duration: 0.2)) { all.toggle() }
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brand)
                    .padding(.horizontal, 16)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .accessibilityIdentifier("map.sheet.more")
                }
            }
        }
    }

    /// What's said where the rows would be, if there are none to show.
    private var note: String? {
        if map.boardFailed { return L("Live times need a connection.") }
        // Down or busy: not "no times", which would say no buses are coming.
        if map.boardError { return L("Couldn't load the times. Trying again.") }
        guard let board = map.board else { return L("Refreshing") }
        if board.rows.isEmpty { return board.available ? L("No buses due") : L("No times right now") }
        return nil
    }

    @ViewBuilder private var footer: some View {
        Button(L("Go there")) {
            AppModel.shared.select(.code(stop.code, label: stop.name))
            NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.now)
        }
        .buttonStyle(SheetButtonStyle(filled: true))
        .accessibilityIdentifier("map.sheet.go")
        IconCircle(symbol: "figure.walk", label: L("Walking directions")) {
            // Apple Maps, the phone's own, as the web app does on Apple devices.
            if let u = URL(string: "https://maps.apple.com/?daddr=\(stop.lat),\(stop.lon)&dirflg=w") { openURL(u) }
        }
        // Tapped again, the star takes the favourite off, with Undo.
        let savedKey = map.savedAs(stop.code)
        let saved = savedKey != nil
        let full = !saved && map.placesFull
        IconCircle(
            symbol: saved ? "star.fill" : "star",
            label: saved ? L("Remove from favourites") : full ? L("Favourites are full") : L("Add to favourites"),
            tint: saved ? .brand : .ink
        ) {
            if let savedKey { Task { await map.unsave(key: savedKey) } } else { Task { await map.save(code: stop.code, name: stop.name) } }
        }
        .accessibilityAddTraits(saved ? .isSelected : [])
        .disabled(full || map.saving || map.profile == nil)
        .accessibilityIdentifier("map.sheet.save")
    }
}

/// An outlined round button with an icon, beside a sheet's main button.
private struct IconCircle: View {
    let symbol: String
    let label: String
    var tint: Color = .ink
    let action: () -> Void
    @Environment(\.isEnabled) private var enabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(enabled || tint == .brand ? tint : Color.faint)
                .frame(width: 44, height: 44)
                .background(Color.surface, in: Circle())
                .overlay(Circle().strokeBorder(Color.line))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// One row of a stop's board, as the Buses tab's, smaller: the service, where
/// it goes, live or scheduled and how full, and the minutes. Tapped, it shows
/// its line on the map; the line picked there has its row washed in its colour.
private struct StopRow: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Follows the text size the phone is set to, as the rest of the card does.
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let row: BoardRow
    let hex: String
    let picked: Bool
    let pick: () -> Void

    var body: some View {
        let rgb = hexRGB(hex) ?? 0x8A939C
        Button(action: pick) {
            Group {
                if let stopped = Stopped.of(running: row.running, why: row.stopped, resumesAt: row.resumesAt, now: ServerClock.now) {
                    stoppedRow(stopped)
                } else {
                    runningRow
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(picked ? Color(rgb: rgb).opacity(0.16) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint(L("%@ on the map", row.svc))
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityIdentifier("map.row.\(row.svc)")
    }

    private var runningRow: some View {
        HStack(alignment: .top, spacing: 12) {
            SvcChip(svc: row.svc, hex: hex, paid: row.paid)
            VStack(alignment: .leading, spacing: 6) {
                if let to = towards {
                    to.font(.body).foregroundStyle(Color.ink).lineLimit(2)
                }
                HStack(spacing: 8) {
                    quality
                    if let word = crowdWord { CrowdPill(text: word, packed: row.crowd == "high") }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                bigTime
                if let then = row.thenText {
                    Text(verbatim: then).font(.caption).foregroundStyle(Color.muted).multilineTextAlignment(.trailing)
                }
            }
            .frame(minWidth: 72, alignment: .trailing)
        }
    }

    private func stoppedRow(_ stopped: Stopped) -> some View {
        let (why, back) = stopped.lines
        return HStack(alignment: .center, spacing: 12) {
            SvcChip(svc: row.svc, hex: hex, paid: row.paid, faded: true)
            VStack(alignment: .leading, spacing: 2) {
                if let to = row.toText ?? (row.towards.isEmpty ? nil : L("to %@", row.towards.joined(separator: L(", ")))) {
                    Text(verbatim: to).font(.subheadline).foregroundStyle(Color.muted).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
                Text(why).font(.body.weight(.semibold)).foregroundStyle(Color.muted)
                if let back { Text(back).font(.subheadline).foregroundStyle(Color.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// The server's "to Central Library, Kent Vale" with the next stop in
    /// bold; all of it bold at the end of the line; "Ends here" said, so no
    /// direction doesn't read as missing.
    private var towards: Text? {
        if let to = row.toText {
            if row.endsHere { return Text(verbatim: to).bold() }
            if let next = row.towards.first, let r = to.range(of: next) {
                return Text(verbatim: String(to[..<r.lowerBound])) + Text(verbatim: next).bold()
                    + Text(verbatim: String(to[r.upperBound...]))
            }
            return Text(verbatim: to)
        }
        if let next = row.towards.first {
            let rest = row.towards.dropFirst().map { L(", ") + $0 }.joined()
            let full = L("to %@", "\u{1}")
            let parts = full.components(separatedBy: "\u{1}")
            return Text(verbatim: parts.first ?? "") + Text(verbatim: next).bold()
                + Text(verbatim: rest + (parts.count > 1 ? parts[1] : ""))
        }
        if row.endsHere { return Text(L("Ends here")).bold() }
        return nil
    }

    /// Live (a dot), Scheduled, or the last time known; why there's no time.
    @ViewBuilder private var quality: some View {
        if row.etaS == nil {
            Text(row.quality == "unknown" ? L("No live times") : L("No time yet"))
                .font(.footnote.weight(.medium)).foregroundStyle(Color.muted)
        } else if row.quality == "live" {
            HStack(spacing: 5) {
                Circle().fill(Color.good).frame(width: 7, height: 7)
                    .background(Circle().fill(Color.good.opacity(0.25)).frame(width: 11, height: 11))
                Text(L("Live")).font(.footnote.weight(.semibold)).foregroundStyle(Color.good)
            }
        } else if row.quality == "stale" {
            Tag(text: L("Last known"), color: .muted)
        } else {
            Tag(text: L("Estimate"), color: .warn)
        }
    }

    private var crowdWord: String? {
        switch row.crowd {
        case "low": L("Seats")
        case "medium": L("Busy")
        case "high": L("Packed")
        default: nil
        }
    }

    /// "4 min" with the number large, or "Arriving"; a dash without a time
    /// (the tag says why). The words are the server's ("4 min", "~6 min",
    /// "约 6 分钟"), worded here only for an older server.
    @ViewBuilder private var bigTime: some View {
        let arriving = (row.etaS ?? .max) < BusTimes.arrivingS
        let color: Color = arriving ? .brand : row.quality == "live" ? .ink : .muted
        if row.etaS == nil {
            Text(verbatim: "–").font(.system(size: 24 * scale, weight: .bold)).foregroundStyle(Color.faint)
        } else if let eta = row.etaText {
            Group {
                if let r = eta.range(of: #"\d+"#, options: .regularExpression) {
                    Text(verbatim: String(eta[..<r.lowerBound])).font(.system(size: 14 * scale, weight: .semibold))
                        + Text(verbatim: String(eta[r])).font(.system(size: 26 * scale, weight: .heavy))
                        + Text(verbatim: String(eta[r.upperBound...])).font(.system(size: 14 * scale, weight: .semibold))
                } else {
                    Text(verbatim: eta).font(.system(size: 20 * scale, weight: .heavy))
                }
            }
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
            .accessibilityLabel(spokenTimes(eta))
        }
    }
}

private struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct CrowdPill: View {
    let text: String
    let packed: Bool

    var body: some View {
        let color: Color = packed ? .warn : .muted
        Text(text)
            .font(.footnote)
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 2)
            .background(packed ? color.opacity(0.12) : Color.surface2, in: Capsule())
    }
}

// MARK: - A bus

/// A tapped bus: where its line ends and where it is or is going next; its
/// plate, whether it's moving and how full it is; and, dragged or tapped
/// open, the stops ahead of it on a strip of its line. What's ahead is the
/// server's (`upcoming`): the app doesn't walk the route. Its button opens
/// the sheet of the stop it's at or coming to, as each stop's row does; back
/// comes here from it.
struct BusSheet: View {
    let bus: LiveBus
    let svc: String
    /// The service's colour, as on its line.
    let hex: String
    let campus: CampusMap
    let map: MapModel
    @State var open: Bool
    /// Every stop to where its line ends, not just the first few.
    @State var all: Bool

    init(bus: LiveBus, svc: String, hex: String, campus: CampusMap, map: MapModel, open: Bool, all: Bool) {
        self.bus = bus
        self.svc = svc
        self.hex = hex
        self.campus = campus
        self.map = map
        _open = State(initialValue: open)
        _all = State(initialValue: all)
    }

    /// This sheet as it is now, for back to come to from a stop's sheet.
    private var now: MapModel.Sheet.Bus { MapModel.Sheet.Bus(id: bus.id, stops: open, all: all) }

    /// How many stops the short list leaves out: what "Show more" adds and
    /// "Show fewer" takes away. One alone is just shown, as on a stop's sheet.
    private var hidden: Int {
        let m = BusStrip.of(bus).more
        return m > 1 ? m : 0
    }
    private var strip: BusStrip { BusStrip.of(bus, all: all || hidden == 0) }

    var body: some View {
        let rgb = hexRGB(hex) ?? 0x8A939C
        let tint = Color(rgb: rgb)
        let where_ = bus.at.map { L("At %@", $0) } ?? bus.nextStop.map { L("Next: %@", $0) }
        // Where its line ends leads, as a stop's name does; where it is comes under.
        let title = bus.towards.map { L("Towards %@", $0) } ?? where_ ?? L("Bus %@", svc)
        let strip = strip
        let stop = Self.stop(for: bus, svc: svc, in: campus)
        SheetFrame(
            title: title,
            sub: bus.towards != nil ? where_ : nil,
            close: map.closeSheet,
            handle: strip.any
                ? { want in
                    let next = want ?? !open
                    guard next != open else { return false }
                    withAnimation(.easeInOut(duration: 0.2)) { open = next }
                    return true
                } : nil,
            footerShown: stop != nil
        ) {
            SheetTile(fill: tint) {
                Text(verbatim: svc)
                    .font(.system(size: 20, weight: .heavy))
                    .foregroundStyle(inkOn(rgb))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 4)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("Bus %@", svc))
        } facts: {
            facts
        } content: {
            if strip.any {
                VStack(alignment: .leading, spacing: 0) {
                    SectionBand(text: L("Stops ahead"), open: open) {
                        withAnimation(.easeInOut(duration: 0.2)) { open.toggle() }
                    }
                    if open {
                        VStack(alignment: .leading, spacing: 0) {
                            stripList(strip, tint)
                            if hidden > 0 {
                                Button(all ? L("Show fewer") : L("Show %@ more stops", "\(hidden)")) {
                                    withAnimation(.easeInOut(duration: 0.2)) { all.toggle() }
                                }
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.brand)
                                .frame(minHeight: 44)
                                .padding(.leading, 30)
                                .accessibilityIdentifier("map.sheet.more")
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 6)
                        .transition(.opacity)
                    }
                }
                .clipped()
            }
        } footer: {
            if let stop {
                // Secondary: "Go there" on a stop's sheet is the one prominent button.
                Button(L("Show %@", stop.name)) { map.showStop(stop.code, from: now) }
                    .buttonStyle(SheetButtonStyle())
                    .accessibilityIdentifier("map.sheet.showStop")
            }
        }
    }

    /// The stop a bus is at or coming to.
    static func stop(for bus: LiveBus, svc: String, in campus: CampusMap) -> MapStop? {
        bus.at != nil
            ? stop(code: bus.atCode, name: bus.at, for: bus, svc: svc, in: campus)
            : stop(code: bus.nextStopCode ?? bus.upcomingCodes.first ?? nil, name: bus.nextStop, for: bus, svc: svc, in: campus)
    }

    /// A stop on a bus's line: by its code; from an older API, by name: the
    /// one on its own line nearest the bus (one name can be either side of a road).
    static func stop(code: String?, name: String?, for bus: LiveBus, svc: String, in campus: CampusMap) -> MapStop? {
        if let code, let s = campus.stop(code) { return s }
        guard let name else { return nil }
        let codes = campus.stops.filter { $0.name == name && $0.services.contains(svc) }.map(\.code)
        guard !codes.isEmpty else { return nil }
        return campus.nearest(codes, lat: bus.lat, lon: bus.lon).flatMap(campus.stop)
    }

    /// The bus's plate, whether it's moving, and how full it is.
    private var facts: some View {
        HStack(spacing: 12) {
            // The number plate, like the one on the bus.
            if let plate = bus.plate {
                Text(verbatim: plate)
                    .font(.system(.footnote, design: .monospaced).weight(.medium))
                    .tracking(0.5)
                    .foregroundStyle(Color.muted)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.lineStrong.opacity(0.6)))
                    .accessibilityIdentifier("map.sheet.plate")
            }
            HStack(spacing: 6) {
                Circle().fill(Color.lineStrong).frame(width: 8, height: 8).accessibilityHidden(true)
                Text(bus.moving ? L("Moving") : L("Stopped"))
            }
            if let (filled, color, word) = crowd {
                HStack(alignment: .center, spacing: 6) {
                    // Three rising bars, as many filled as it's full; the word says it.
                    HStack(alignment: .bottom, spacing: 2) {
                        ForEach(0..<3, id: \.self) { i in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(i < filled ? color : Color.line)
                                .frame(width: 4, height: [6, 10, 14][i])
                        }
                    }
                    .accessibilityHidden(true)
                    Text(word)
                }
            }
            Spacer(minLength: 0)
        }
        .font(.subheadline)
        .foregroundStyle(Color.muted)
        .accessibilityElement(children: .combine)
    }

    private var crowd: (Int, Color, String)? {
        switch bus.crowd {
        case "low": (1, .good, L("Seats"))
        case "medium": (2, .warn, L("Busy"))
        case "high": (3, .bad, L("Packed"))
        default: nil
        }
    }

    private enum Mark { case passed, bus, here, next, ahead }

    /// The stops ahead of the bus as a strip of its line, the bus on it.
    private func stripList(_ strip: BusStrip, _ tint: Color) -> some View {
        var rows: [(mark: Mark, name: String?, code: String?)] = []
        if let p = strip.passed { rows.append((.passed, p, strip.passedCode)) }
        if strip.between { rows.append((.bus, nil, nil)) } else { rows.append((.here, strip.here, strip.hereCode)) }
        if let n = strip.next { rows.append((.next, n, strip.nextCode)) }
        for (j, s) in strip.after.enumerated() {
            rows.append((.ahead, s, strip.afterCodes.indices.contains(j) ? strip.afterCodes[j] : nil))
        }
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                let first = i == 0
                let last = i == rows.count - 1 && strip.more == 0
                // A stop's row opens its sheet, and its chevron says so: only
                // one found on the map, and not the bus's own row.
                let stop = row.mark == .bus ? nil : Self.stop(code: row.code, name: row.name, for: bus, svc: svc, in: campus)
                if let stop {
                    Button {
                        map.showStop(stop.code, from: now)
                    } label: {
                        line(row.mark, row.name, tint, first: first, last: last, chevron: true)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(L("Show this stop"))
                } else {
                    line(row.mark, row.name, tint, first: first, last: last, chevron: false)
                }
            }
            if strip.more > 0 {
                // The line fading out: it goes on, and the button under it shows the rest.
                LinearGradient(colors: [tint.opacity(0.35), tint.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(width: 3, height: 16)
                    .frame(width: 20)
                    .accessibilityHidden(true)
            }
        }
    }

    /// One row of the strip: its piece of the line with the stop's dot or
    /// the bus, the name, and a chevron when it opens the stop's sheet.
    private func line(_ mark: Mark, _ name: String?, _ tint: Color, first: Bool, last: Bool, chevron: Bool) -> some View {
        let bold = mark == .next || mark == .here
        // Above the bus (the passed stop's row, and the bus's own top half) is grey.
        let above: Color = mark == .passed || mark == .bus || mark == .here ? Color.line : tint
        let below: Color = mark == .passed ? Color.line : tint
        return HStack(spacing: 10) {
            ZStack {
                VStack(spacing: 0) {
                    Rectangle().fill(first ? .clear : above)
                    Rectangle().fill(last ? .clear : below)
                }
                .frame(width: 3)
                marker(mark, tint)
            }
            .frame(width: 20)
            .accessibilityHidden(true)
            // Passed, here and next are drawn on the line (grey, the bus,
            // bold), not written beside it; VoiceOver hears the word.
            Group {
                if mark == .bus {
                    Text(L("On its way")).font(.subheadline).foregroundStyle(Color.muted)
                } else {
                    Text(verbatim: name ?? "")
                        .font(bold ? .body.weight(.bold) : .body)
                        .foregroundStyle(mark == .passed ? Color.muted.opacity(0.8) : Color.ink)
                }
            }
            .lineLimit(1)
            Spacer(minLength: 6)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(height: bold ? 44 : 40)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(said(mark) ?? "")
    }

    private func said(_ mark: Mark) -> String? {
        switch mark {
        case .passed: L("passed")
        case .here: L("here")
        case .next: L("next")
        case .ahead, .bus: nil
        }
    }

    @ViewBuilder private func marker(_ mark: Mark, _ tint: Color) -> some View {
        switch mark {
        case .bus, .here:
            // The bus: its colour in a ring of the sheet's own.
            Circle().fill(tint).frame(width: 14, height: 14)
                .padding(2)
                .background(Circle().fill(Color.surface))
        case .passed:
            Circle().strokeBorder(Color.line, lineWidth: 2).background(Circle().fill(Color.surface)).frame(width: 9, height: 9)
        case .next:
            Circle().strokeBorder(tint, lineWidth: 3).background(Circle().fill(Color.surface)).frame(width: 12, height: 12)
        case .ahead:
            Circle().strokeBorder(tint, lineWidth: 2).background(Circle().fill(Color.surface)).frame(width: 9, height: 9)
        }
    }
}
