import AppKit
import CoreLocation
import MapLibre
import SwiftUI

// MARK: - The map's state

/// What the map window shows: the campus, the style, the chosen service and
/// its live buses, and the card for a clicked stop or bus. The same as the
/// phone's Map tab (MapViewModel), polled the same: buses every 5 s, a stop's
/// times every 15 s, your dot every 20 s, and only while the window is open.
@MainActor @Observable
final class MapModel {
    enum Sheet: Equatable { case stop(String), bus(String) }
    enum BusStatus: Equatable { case finding, running(Int), noneRunning, unavailable, offline, stale }
    struct Spot: Equatable { let lat: Double; let lon: Double }

    var campus: CampusMap?
    var style: URL?
    var failed = false
    var selected: String?
    var buses: [LiveBus] = []
    /// Bumped by every answer from `/buses`, the same or not: each one plans
    /// the slides again, so a bus that hasn't moved still counts as heard from.
    var busAnswers = 0
    /// The feed is down, or the last answer is old, and these are its last
    /// places: drawn faded.
    var busesStale = false
    /// When `/buses` last answered (this Mac's clock).
    private var heardAt: Date?
    var busStatus: BusStatus?
    var sheet: Sheet?
    var board: StopBoard?
    var boardFailed = false
    var me: Spot?
    var downloading = false
    var downloadFailed = false
    /// Bumped by "Back to campus"; the map watches it.
    var recentre = 0
    /// Zoom steps asked for by the buttons (and ⌘+, ⌘−), in total: the map
    /// zooms by the difference since it last looked.
    var zoomSteps = 0
    /// A stop chosen from the list, which the map moves to; `focusCount` is
    /// bumped each time, so choosing it again moves there again.
    var focus: Spot?
    var focusCount = 0

    var openStop: String? { if case .stop(let c) = sheet { c } else { nil } }
    var openBus: LiveBus? { if case .bus(let id) = sheet { buses.first { $0.id == id } } else { nil } }

    /// The campus and the style for this theme and language, then the street
    /// map file in the background (the style again once it's here).
    func open(dark: Bool, zh: Bool) async {
        if campus == nil { campus = try? await MapFiles.campus(token: TokenStore.read()) }
        style = await MapFiles.style(dark: dark, zh: zh)
        failed = campus == nil || style == nil
        guard !failed else { return }
        downloading = !MapFiles.hasTiles
        do {
            if try await MapFiles.keepTiles() { style = await MapFiles.style(dark: dark, zh: zh) }
            downloadFailed = false
        } catch {
            downloadFailed = !MapFiles.hasTiles
        }
        downloading = false
    }

    /// A pill: that service's line and buses, or off again.
    func choose(_ svc: String?) {
        selected = svc == selected ? nil : svc
        buses = []
        busesStale = false
        heardAt = nil
        busStatus = selected == nil ? nil : .finding
        if case .bus = sheet { sheet = nil }
    }

    /// A failed poll keeps the buses drawn and says so, as the web map does:
    /// "need a connection" when this Mac is offline (`online`). Once the last
    /// answer is 15 s old (three polls) they're faded, so last places don't
    /// pass for live. A signed-out Mac (401) says nothing: the popover asks
    /// it to sign in again.
    func refreshBuses(online: Bool) async {
        guard let svc = selected, let q = svc.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
        let list: BusList?
        do {
            list = BusList.parse(try await MapFiles.get("/buses?svc=\(q)", token: TokenStore.read()))
        } catch let e as ApiError where e.status == 401 {
            return
        } catch {
            if !Task.isCancelled, svc == selected {
                busStatus = online ? .unavailable : .offline
                if let heardAt, Date().timeIntervalSince(heardAt) > 15 { busesStale = true }
            }
            return
        }
        guard svc == selected else { return }
        guard let list else {
            busStatus = .unavailable
            return
        }
        buses = list.buses
        busesStale = list.available && list.stale
        heardAt = Date()
        busAnswers += 1
        busStatus = !list.available ? .unavailable : list.stale ? .stale : list.buses.isEmpty ? .noneRunning : .running(list.buses.count)
        if case .bus(let id) = sheet, !buses.contains(where: { $0.id == id }) { sheet = nil }
    }

    func open(stop code: String) {
        guard openStop != code else { return }
        sheet = .stop(code)
        board = nil
        boardFailed = false
    }

    func open(bus id: String) { sheet = .bus(id) }

    /// A stop from the list (no mouse needed): its card, and the map moved onto it.
    func pick(stop: MapStop) {
        open(stop: stop.code)
        focus = Spot(lat: stop.lat, lon: stop.lon)
        focusCount += 1
    }

    func refreshBoard() async {
        guard let code = openStop, let q = code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
        let b = (try? await MapFiles.get("/arrivals?stop=\(q)", token: TokenStore.read())).flatMap(StopBoard.parse)
        guard code == openStop else { return }
        if let b { board = b; boardFailed = false } else if board == nil { boardFailed = true }
    }

    /// Your dot, only with location already allowed: the map never asks.
    func locate(_ app: AppModel) async {
        guard !app.needsLocation, !app.locationDenied, let at = await app.whereAmI() else { return }
        me = Spot(lat: at.coordinate.latitude, lon: at.coordinate.longitude)
    }
}

// MARK: - The window

/// The campus map, in a window of its own: every service's line in its
/// colour, the stops, a pill per service along the top (one at a time: its
/// line and live buses), and a card for a clicked stop or bus. The Mac's
/// copy of the phone's Map tab.
struct MapWindow: View {
    let app: AppModel
    @State private var map = MapModel()
    @State private var window: NSWindow?
    /// Bumped when the window comes back into view, so the polls restart at once.
    @State private var shown = 0
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .topLeading) {
            if Bundle.main.bundleIdentifier == nil {
                // `swift run` has no app bundle, and MapLibre keeps its cache by the app's id.
                Text(L("The map needs the built app (./build.sh)."))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let campus = map.campus, let style = map.style {
                CampusMapView(
                    map: map, campus: campus, style: style, dark: scheme == .dark, still: reduceMotion,
                    drawn: .init(selected: map.selected, buses: map.buses, answers: map.busAnswers, stale: map.busesStale, sheet: map.sheet, me: map.me, recentre: map.recentre, zoomSteps: map.zoomSteps, focusCount: map.focusCount)
                )
            } else if map.failed {
                Text(L("The map needs a connection the first time."))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let campus = map.campus {
                VStack(alignment: .leading, spacing: 8) {
                    Pills(campus: campus, selected: map.selected) { map.choose($0) }
                    if let status = map.busStatus {
                        // Said for a new service, or when its buses go to or from none;
                        // not at every bus that joins or leaves.
                        StatusChip(text: status.text(map.selected ?? ""))
                            .announced(status.text(map.selected ?? ""), when: [map.selected ?? "", status.heard])
                    }
                    if map.downloading {
                        StatusChip(text: L("Downloading the street map (about 4 MB)…"), busy: true)
                    } else if map.downloadFailed {
                        StatusChip(text: L("The street map hasn’t downloaded yet. Routes and stops are still available."))
                    }
                }
                .padding(.top, 12)
            }
        }
        .overlay(alignment: .bottomLeading) {
            if let campus = map.campus, let sheet = map.sheet {
                Group {
                    switch sheet {
                    case .stop(let code): if let stop = campus.stop(code) { StopCard(stop: stop, map: map, campus: campus, app: app) }
                    case .bus: if let bus = map.openBus { BusCard(bus: bus, svc: map.selected ?? "", hex: campus.color(map.selected)) { map.sheet = nil } }
                    }
                }
                .frame(width: 320)
                .padding(16)
                .padding(.bottom, 12)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if let campus = map.campus {
                MapControls(map: map, campus: campus)
                    .padding(.trailing, 14)
                    .padding(.bottom, 36)
            }
        }
        .frame(minWidth: 560, minHeight: 440)
        .background(WindowReader { if window !== $0 { window = $0 } })
        .onExitCommand { map.sheet = nil }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { n in
            if let w = n.object as? NSWindow, w === window, visible { shown += 1 }
        }
        .task(id: scheme) { await map.open(dark: scheme == .dark, zh: Lang.zh) }
        // Live buses every 5 s while a pill is on (the API caches 5 s), not
        // while the window is hidden behind others or minimised.
        .task(id: "\(map.selected ?? "")|\(shown)") {
            guard map.selected != nil else { return }
            while !Task.isCancelled {
                if visible { await map.refreshBuses(online: app.online) }
                try? await Task.sleep(for: .seconds(5))
            }
        }
        // The open stop's times every 15 s (cached 15 s).
        .task(id: "\(map.openStop ?? "")|\(shown)") {
            guard map.openStop != nil else { return }
            while !Task.isCancelled {
                if visible { await map.refreshBoard() }
                try? await Task.sleep(for: .seconds(15))
            }
        }
        .task {
            while !Task.isCancelled {
                if visible { await map.locate(app) }
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    private var visible: Bool { window.map { $0.occlusionState.contains(.visible) && !$0.isMiniaturized } ?? true }
}

extension MapModel.BusStatus {
    /// What VoiceOver hears again when it changes: any number of buses
    /// running is the same, so a count going up or down is not said.
    var heard: String {
        if case .running = self { return "running" }
        return "\(self)"
    }

    func text(_ svc: String) -> String {
        switch self {
        case .finding: L("Finding %@ buses…", svc)
        case .running(1): L("1 bus on %@", svc)
        case .running(let n): L("%1$@ buses on %2$@", String(n), svc)
        case .noneRunning: L("No %@ buses running right now.", svc)
        case .unavailable: L("Live buses aren’t available right now.")
        case .offline: L("Live buses need a connection.")
        case .stale: L("Bus positions may be out of date")
        }
    }
}

/// A pill per service: one at a time shows its line and live buses.
private struct Pills: View {
    let campus: CampusMap
    let selected: String?
    let choose: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(campus.services, id: \.self) { svc in
                    let hex = campus.color(svc)
                    let c = Color(hex: hex) ?? .gray
                    let on = svc == selected
                    Button { choose(svc) } label: {
                        HStack(spacing: 5) {
                            Circle().fill(on ? inkOn(hex) : c).frame(width: 8, height: 8)
                            Text(svc).font(.system(size: 12, weight: .semibold))
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .foregroundStyle(on ? inkOn(hex) : .primary)
                        .background(on ? AnyShapeStyle(c) : AnyShapeStyle(.regularMaterial), in: Capsule())
                        .shadow(color: .black.opacity(0.12), radius: 2, y: 1)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L("%@: show its line and live buses", svc))
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 2)
        }
    }
}

/// The map's buttons, in its corner: every stop (and the chosen service's
/// buses) in a list, so a card opens without a mouse; zoom in and out
/// (⌘+, ⌘−), which the map's own controls hid; and back to campus.
private struct MapControls: View {
    let map: MapModel
    let campus: CampusMap

    var body: some View {
        VStack(spacing: 8) {
            Menu {
                ForEach(campus.stops.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }, id: \.code) { stop in
                    Button(stop.name) { map.pick(stop: stop) }
                }
            } label: {
                Image(systemName: "list.bullet")
            }
            .control(L("Find a stop"))
            if let svc = map.selected, !map.buses.isEmpty {
                Menu {
                    ForEach(map.buses, id: \.id) { bus in
                        let place = bus.at.map { L("At %@", $0) } ?? bus.nextStop.map { L("Next stop: %@", $0) }
                        Button([bus.plate ?? L("%@ bus", svc), place].compactMap { $0 }.joined(separator: " · ")) { map.open(bus: bus.id) }
                    }
                } label: {
                    Image(systemName: "bus")
                }
                .control(L("Find a %@ bus", svc))
            }
            Button { map.zoomSteps += 1 } label: { Image(systemName: "plus") }
                .keyboardShortcut("+")
                .control(L("Zoom in"))
                // ⌘= too: on most keyboards "+" is a shifted "=".
                .background {
                    Button("") { map.zoomSteps += 1 }
                        .keyboardShortcut("=")
                        .opacity(0)
                        .focusable(false)
                        .accessibilityHidden(true)
                }
            Button { map.zoomSteps -= 1 } label: { Image(systemName: "minus") }
                .keyboardShortcut("-")
                .control(L("Zoom out"))
            // Lost after zooming or dragging: one click back to the whole campus.
            Button { map.recentre += 1 } label: { Image(systemName: "scope") }
                .control(L("Back to campus"))
        }
        .buttonStyle(.plain)
    }
}

private extension View {
    /// A round button over the map, named for VoiceOver and on hover.
    func control(_ name: String) -> some View {
        self
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .font(.system(size: 14, weight: .medium))
            .frame(width: 30, height: 30)
            .contentShape(Circle())
            .background(.regularMaterial, in: Circle())
            .shadow(color: .black.opacity(0.15), radius: 3, y: 1)
            .help(name)
            .accessibilityLabel(name)
    }
}

/// A line of status over the map, under the pills.
struct StatusChip: View {
    let text: String
    var busy = false

    var body: some View {
        HStack(spacing: 6) {
            if busy { ProgressView().controlSize(.small) }
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: Capsule())
        .padding(.horizontal, 12)
    }
}

/// A service's code on its colour, as on the bus.
private struct SvcTag: View {
    let svc: String
    let hex: String

    var body: some View {
        Text(svc)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(inkOn(hex))
            .frame(minWidth: 24)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(hex: hex) ?? .gray, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

/// The card over the map's corner, for a stop.
private struct MapCard<Content: View>: View {
    let title: String
    let close: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Text(title).font(.system(size: 15, weight: .semibold)).accessibilityAddTraits(.isHeader)
                Spacer()
                CloseButton(close: close)
            }
            content()
        }
        .mapCard()
        // It opens away from where the click (or the list) was: say which.
        .announced(title)
    }
}

private struct CloseButton: View {
    let close: () -> Void

    var body: some View {
        Button(action: close) { Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)) }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(L("Close"))
            .accessibilityLabel(L("Close"))
    }
}

private extension View {
    /// A card's fill and shadow over the map.
    func mapCard() -> some View {
        self
            .padding(14)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
    }
}

/// A clicked bus: where it is and where it's going, its plate, whether it's
/// moving and how full it is; then, opened, the stops still ahead on a strip
/// of its line. Every stop is the server's (`at`, `stretch`, `upcoming`).
struct BusCard: View {
    let bus: LiveBus
    let svc: String
    /// The service's colour, as on its line.
    let hex: String
    let close: () -> Void
    @State var open = false

    /// Stops shown after the next one before "+N more".
    static let shownAfterNext = 4

    var body: some View {
        let tint = Color(hex: hex) ?? .gray
        let title = bus.at.map { L("At %@", $0) } ?? bus.nextStop.map { L("Next: %@", $0) } ?? L("%@ bus", svc)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Text(svc)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(inkOn(hex))
                    .frame(minWidth: 26)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 5)
                    .background(tint, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityLabel(L("%@ bus", svc))
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).accessibilityAddTraits(.isHeader)
                    if let to = bus.towards { Text(L("Towards %@", to)).font(.system(size: 12)).foregroundStyle(.secondary) }
                }
                Spacer()
                CloseButton(close: close)
            }
            info
            if !stops.isEmpty {
                Button { withAnimation(.easeInOut(duration: 0.2)) { open.toggle() } } label: {
                    HStack(spacing: 4) {
                        Text(L("Stops ahead"))
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                            .accessibilityHidden(true)
                    }
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? L("Expanded") : L("Collapsed"))
                if open {
                    strip(tint)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .clipped()
        .mapCard()
        // It opens away from where the click (or the list) was: say which.
        .announced(L("%@: %@", svc, title))
    }

    /// Plate, moving or stopped, and the crowd meter, one line.
    private var info: some View {
        HStack(spacing: 10) {
            if let plate = bus.plate {
                Text(plate)
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.secondary.opacity(0.5)))
            }
            HStack(spacing: 5) {
                Circle().fill(.secondary).frame(width: 6, height: 6).accessibilityHidden(true)
                Text(bus.moving ? L("Moving") : L("Stopped"))
            }
            if let (filled, color, word) = crowd {
                HStack(alignment: .bottom, spacing: 5) {
                    HStack(alignment: .bottom, spacing: 2) {
                        ForEach(0..<3, id: \.self) { i in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(i < filled ? color : Color.secondary.opacity(0.3))
                                .frame(width: 4, height: [6, 10, 14][i])
                        }
                    }
                    // The word says it; the bars are for the eye.
                    .accessibilityHidden(true)
                    Text(word)
                }
            }
        }
        .font(.system(size: 12))
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private var crowd: (Int, Color, String)? {
        switch bus.crowd {
        case "low": (1, .good, L("Seats free"))
        case "medium": (2, .warn, L("Busy"))
        case "high": (3, .bad, L("Packed"))
        default: nil
        }
    }

    /// The stops ahead, the next first: the server's list, or (an older API)
    /// just its next stop.
    private var stops: [String] {
        if !bus.upcoming.isEmpty { return bus.upcoming }
        return bus.nextStop.map { [$0] } ?? []
    }

    enum Kind { case passed, between, here, next, ahead }
    struct Row { let name: String; let kind: Kind }

    /// The strip's rows, top to bottom: the stop it passed and itself on the
    /// way, or the stop it's at; then the next stop and a few after it.
    var rows: [Row] {
        var r: [Row] = []
        if let at = bus.at {
            r.append(Row(name: at, kind: .here))
        } else if let last = bus.stretch?.last {
            r.append(Row(name: last, kind: .passed))
            r.append(Row(name: L("On its way"), kind: .between))
        }
        for (i, s) in stops.prefix(1 + Self.shownAfterNext).enumerated() { r.append(Row(name: s, kind: i == 0 ? .next : .ahead)) }
        return r
    }

    private func strip(_ tint: Color) -> some View {
        let rows = rows
        let more = stops.count - (1 + Self.shownAfterNext)
        let grey = Color.secondary.opacity(0.4)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                // Grey down to the bus, its colour on from there.
                let above: Color? = i == 0 ? nil : (row.kind == .between ? grey : tint)
                let below: Color? = i == rows.count - 1 ? nil : (row.kind == .passed ? grey : tint)
                HStack(spacing: 10) {
                    ZStack {
                        VStack(spacing: 0) {
                            Rectangle().fill(above ?? .clear)
                            Rectangle().fill(below ?? .clear)
                        }
                        .frame(width: 3)
                        marker(row.kind, tint)
                    }
                    .frame(width: 16)
                    .accessibilityHidden(true)
                    Text(row.name)
                        .font(.system(size: row.kind == .next ? 13 : 12, weight: row.kind == .next ? .semibold : .regular))
                        .foregroundStyle(row.kind == .passed || row.kind == .between ? .secondary : .primary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let tag = tag(row.kind, last: i == rows.count - 1, more: more) {
                        Text(tag)
                            .font(.system(size: 11, weight: row.kind == .next ? .semibold : .regular))
                            .foregroundStyle(row.kind == .next || row.kind == .here ? .primary : .secondary)
                    }
                }
                .frame(height: row.kind == .between ? 20 : 24)
                .opacity(row.kind == .passed ? 0.6 : 1)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func tag(_ kind: Kind, last: Bool, more: Int) -> String? {
        switch kind {
        case .passed: L("passed")
        case .here: L("here")
        case .next: last && more > 0 ? L("+%@ more", "\(more)") : L("next")
        case .ahead: last && more > 0 ? L("+%@ more", "\(more)") : nil
        case .between: nil
        }
    }

    @ViewBuilder private func marker(_ kind: Kind, _ tint: Color) -> some View {
        switch kind {
        case .between, .here:
            // The bus: its colour in a white ring.
            Circle().fill(tint).frame(width: 10, height: 10)
                .padding(2.5)
                .background(Circle().fill(.white))
                .shadow(color: .black.opacity(0.25), radius: 1)
        case .passed:
            Circle().strokeBorder(Color.secondary, lineWidth: 2).background(Circle().fill(.background)).frame(width: 9, height: 9)
        case .next:
            Circle().strokeBorder(tint, lineWidth: 3).background(Circle().fill(.background)).frame(width: 12, height: 12)
        case .ahead:
            Circle().strokeBorder(tint, lineWidth: 2).background(Circle().fill(.background)).frame(width: 8, height: 8)
        }
    }
}

private struct StopCard: View {
    let stop: MapStop
    let map: MapModel
    let campus: CampusMap
    let app: AppModel
    @State private var sent = false

    var body: some View {
        MapCard(title: stop.name, close: { map.sheet = nil }) {
            Group {
                if map.boardFailed {
                    Text(L("Live times need a connection.")).foregroundStyle(.secondary)
                } else if let board = map.board {
                    if board.rows.isEmpty {
                        Text(board.available ? L("No buses due") : L("No times right now")).foregroundStyle(.secondary)
                    } else {
                        VStack(spacing: 5) {
                            ForEach(board.rows, id: \.svc) { r in
                                HStack {
                                    SvcTag(svc: r.svc, hex: campus.color(r.svc))
                                    Spacer()
                                    Text(eta(r)).font(.system(size: 12, weight: .semibold)).monospacedDigit()
                                }
                                // "D2: about 6 min", one element a row.
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(spokenTimes(L("%@: %@", r.svc, eta(r))))
                            }
                        }
                    }
                } else {
                    Text(L("Refreshing")).foregroundStyle(.secondary)
                }
            }
            .font(.system(size: 12))
            SectionLabel(text: L("Services here"))
            HStack(spacing: 5) {
                ForEach(stop.services, id: \.self) { svc in
                    Button { if map.selected != svc { map.choose(svc) } } label: {
                        SvcTag(svc: svc, hex: campus.color(svc))
                    }
                    .buttonStyle(.plain)
                    .help(L("%@: show its line and live buses", svc))
                }
            }
            HStack(spacing: 8) {
                if sent {
                    // The popover can't be opened for you: say where it went.
                    Label(L("Added to terminus in the menu bar"), systemImage: "checkmark")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                } else {
                    Button(L("Go there")) {
                        app.goSomewhere(code: stop.code, label: stop.name)
                        sent = true
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.brand)
                }
                Button(L("Walking directions")) {
                    // Apple Maps, the Mac's own, as the web app does on Apple devices.
                    let url = "https://maps.apple.com/?daddr=\(stop.lat),\(stop.lon)&dirflg=w"
                    if let u = URL(string: url) { NSWorkspace.shared.open(u) }
                }
            }
            .controlSize(.small)
        }
        .onChange(of: stop.code) { sent = false }
    }

    /// The server's "4 min" ("now", "~6 min"); worded here only for an older server's row.
    private func eta(_ r: BoardRow) -> String {
        if let e = r.eta { return e }
        let s = r.etaS ?? 0
        if s < 60 { return L("Arriving") }
        let min = L("%@ min", String(s / 60))
        return r.quality == "scheduled" ? L("~%@", min) : min
    }
}

// MARK: - MapLibre

/// The map file's extent (MAP_BOUNDS in apps/api/src/map.ts), with room to spare.
private let panLimit = (west: 103.735, south: 1.26, east: 103.85, north: 1.352)
/// Further than this from campus (in degrees, about 3 km), the map opens on campus, not on you.
private let nearCampusDeg = 0.027

/// A style-spec expression, as the phone's and the web's map write them.
private func E(_ json: Any) -> NSExpression { NSExpression(mglJSONObject: json) }

private func zoomed(_ stops: Double...) -> NSExpression {
    var j: [Any] = ["interpolate", ["linear"], ["zoom"]]
    for s in stops { j.append(s) }
    return E(j)
}

/// GeoJSON as a shape for a source.
private func shape(_ data: Data) -> MLNShape? { try? MLNShape(data: data, encoding: String.Encoding.utf8.rawValue) }

/// Your dot, and the halo round it.
private let meBlue = NSColor(rgb: 0x2B7BF3)

/// MapLibre's own view, drawn from the model: sources and layers are added
/// once each time a style loads, then only their data and filters change.
private struct CampusMapView: NSViewRepresentable {
    let map: MapModel
    let campus: CampusMap
    let style: URL
    let dark: Bool
    let still: Bool
    /// What it draws from the model, so SwiftUI updates it when any of it changes.
    let drawn: Drawn

    struct Drawn: Equatable {
        let selected: String?
        let buses: [LiveBus]
        let answers: Int
        let stale: Bool
        let sheet: MapModel.Sheet?
        let me: MapModel.Spot?
        let recentre: Int
        let zoomSteps: Int
        let focusCount: Int
    }

    func makeCoordinator() -> Coordinator { Coordinator(map: map, campus: campus) }

    func makeNSView(context: Context) -> MLNMapView {
        let view = SizedMapView(frame: .zero, styleURL: style)
        view.sized = { [weak coordinator = context.coordinator] in coordinator?.frameCampus() }
        view.delegate = context.coordinator
        view.compass.isHidden = true
        view.zoomControls.isHidden = true
        // The map isn't Mapbox's: only the data's own credit (attributionView) stays.
        view.logoView.isHidden = true
        view.isRotateEnabled = false
        view.isPitchEnabled = false
        view.minimumZoomLevel = 13
        view.maximumZoomLevel = 19
        let click = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.clicked(_:)))
        click.delaysPrimaryMouseButtonEvents = false
        view.addGestureRecognizer(click)
        context.coordinator.view = view
        context.coordinator.styleURL = style
        return view
    }

    func updateNSView(_ view: MLNMapView, context: Context) {
        let c = context.coordinator
        c.campus = campus
        c.dark = dark
        c.still = still
        if c.styleURL != style {
            c.styleURL = style
            c.loaded = false
            view.styleURL = style
        }
        c.apply()
    }

    @MainActor final class Coordinator: NSObject, @preconcurrency MLNMapViewDelegate {
        let map: MapModel
        var campus: CampusMap
        weak var view: MLNMapView?
        var styleURL: URL?
        var dark = false
        var still = false
        var loaded = false

        private var slides = Slides()
        private var slidesFor: String?
        private var lastAnswer = 0
        private var timer: Timer?
        private var applied: (selected: String?, dark: Bool, stretch: Bool, bus: String?, stale: Bool)?
        private var recentred = 0
        private var zoomedSteps = 0
        private var focused = 0
        private var framedLine: String?
        private var framedMe = false
        private var framed = false

        init(map: MapModel, campus: CampusMap) {
            self.map = map
            self.campus = campus
        }

        private var paper: NSColor { dark ? NSColor(rgb: 0x1A1816) : .white }
        private var ink: NSColor { NSColor(rgb: dark ? 0xF2EFEB : 0x1C1917) }
        private var color: String { campus.color(map.selected) }
        private var path: RoutePath? { map.selected.flatMap { campus.routes[$0]?.path } }

        func mapView(_ mapView: MLNMapView, didFinishLoading style: MLNStyle) {
            build(style)
            loaded = true
            applied = nil
            apply()
        }

        /// Never far off campus: the map file ends a little way out.
        func mapView(_ mapView: MLNMapView, shouldChangeFrom oldCamera: MLNMapCamera, to newCamera: MLNMapCamera) -> Bool {
            let c = newCamera.centerCoordinate
            return c.longitude > panLimit.west && c.longitude < panLimit.east && c.latitude > panLimit.south && c.latitude < panLimit.north
        }

        // MARK: layers

        private func source(_ id: String, _ data: Data) -> MLNShapeSource {
            MLNShapeSource(identifier: id, shape: shape(data), options: nil)
        }

        private func line(_ id: String, _ src: MLNSource, color: NSExpression, width: NSExpression) -> MLNLineStyleLayer {
            let l = MLNLineStyleLayer(identifier: id, source: src)
            l.lineColor = color
            l.lineWidth = width
            l.lineCap = NSExpression(forConstantValue: "round")
            l.lineJoin = NSExpression(forConstantValue: "round")
            return l
        }

        /// A bus's icon, turned with the road and drawn at its offset from where it is.
        private func busIcon(_ id: String, image: String, _ src: MLNSource) -> MLNSymbolStyleLayer {
            let l = MLNSymbolStyleLayer(identifier: id, source: src)
            l.iconImageName = NSExpression(forConstantValue: image)
            l.iconScale = zoomed(13, 0.64, 17, 1)
            l.iconRotation = E(["get", "heading"])
            l.iconRotationAlignment = NSExpression(forConstantValue: "map")
            l.iconOffset = E(["get", "offset"])
            l.iconAllowsOverlap = NSExpression(forConstantValue: true)
            return l
        }

        private func build(_ style: MLNStyle) {
            // MapLibre's Metal renderer on the Mac draws the background layer
            // over the street map's solid fills, hiding them. With the street
            // map there, its land and water cover everything anyway: the
            // background goes, its colour behind the map instead.
            if style.source(withIdentifier: "protomaps") != nil, let bg = style.layer(withIdentifier: "background") as? MLNBackgroundStyleLayer {
                if let c = bg.backgroundColor.constantValue as? NSColor { view?.layer?.backgroundColor = c.cgColor }
                style.removeLayer(bg)
            }
            let routes = source("routes", MapGeoJson.routes(campus))
            let stops = source("stops", MapGeoJson.stops(campus))
            let stretch = source("stretch", MapGeoJson.empty)
            let me = source("me", MapGeoJson.empty)
            let buses = source("buses", MapGeoJson.empty)
            for s in [routes, stops, stretch, me, buses] { style.addSource(s) }
            let byColor = E(["to-color", ["get", "color"]])

            style.addLayer(line("route-casing", routes, color: NSExpression(forConstantValue: paper), width: zoomed(13, 3, 16, 7, 18, 11)))
            style.addLayer(line("routes", routes, color: byColor, width: zoomed(13, 1.5, 16, 4, 18, 7)))
            // The chosen service, drawn again on top.
            let on = line("route-on", routes, color: byColor, width: zoomed(13, 3, 16, 6, 18, 9))
            on.predicate = NSPredicate(format: "svc == %@", "")
            style.addLayer(on)
            style.addLayer(line("stretch-casing", stretch, color: NSExpression(forConstantValue: paper), width: zoomed(13, 7, 16, 13, 18, 18)))
            style.addLayer(line("stretch", stretch, color: byColor, width: zoomed(13, 5, 16, 9, 18, 13)))

            let dots = MLNCircleStyleLayer(identifier: "stops", source: stops)
            dots.circleRadius = zoomed(13, 2.5, 16, 5.5, 18, 8)
            dots.circleColor = NSExpression(forConstantValue: paper)
            dots.circleStrokeColor = NSExpression(forConstantValue: ink)
            dots.circleStrokeWidth = zoomed(13, 1, 16, 2)
            style.addLayer(dots)

            let names = MLNSymbolStyleLayer(identifier: "stop-names", source: stops)
            names.minimumZoomLevel = 15
            names.text = E(["get", "name"])
            names.textFontNames = NSExpression(forConstantValue: ["Noto Sans Medium"])
            names.textFontSize = zoomed(15, 11, 18, 14)
            names.textColor = NSExpression(forConstantValue: ink)
            names.textHaloColor = NSExpression(forConstantValue: paper)
            names.textHaloWidth = NSExpression(forConstantValue: 1.5)
            // Below the dot, or another side of it when a bus is there.
            names.textVariableAnchor = NSExpression(forConstantValue: ["top", "bottom", "right", "left"])
            names.textRadialOffset = NSExpression(forConstantValue: 0.9)
            names.textOptional = NSExpression(forConstantValue: true)
            names.maximumTextWidth = NSExpression(forConstantValue: 8)
            style.addLayer(names)

            let halo = MLNCircleStyleLayer(identifier: "me-halo", source: me)
            halo.circleRadius = NSExpression(forConstantValue: 14)
            halo.circleColor = NSExpression(forConstantValue: meBlue)
            halo.circleOpacity = NSExpression(forConstantValue: 0.18)
            style.addLayer(halo)
            let dot = MLNCircleStyleLayer(identifier: "me", source: me)
            dot.circleRadius = NSExpression(forConstantValue: 6.5)
            dot.circleColor = NSExpression(forConstantValue: meBlue)
            dot.circleStrokeColor = NSExpression(forConstantValue: NSColor.white)
            dot.circleStrokeWidth = NSExpression(forConstantValue: 2.5)
            style.addLayer(dot)

            // An icon, not a circle, so a bus at a stop can sit beside the dot
            // (its offset is per bus, and turns with the road).
            // The offset is in the bus's own frame, so the ring turns with
            // the bus too, or it lands beside it.
            let ring = busIcon("bus-on", image: "bus-on", buses)
            ring.iconIgnoresPlacement = NSExpression(forConstantValue: true)
            ring.predicate = NSPredicate(format: "id == %@", "")
            style.addLayer(ring)
            for (id, image) in [("buses", "bus"), ("bus-heading", "heading")] {
                let l = busIcon(id, image: image, buses)
                // Stop names keep clear of buses (they move to another side of their dot).
                l.iconIgnoresPlacement = NSExpression(forConstantValue: id == "bus-heading")
                style.addLayer(l)
            }
            style.setImage(Self.ringImage(ink), forName: "bus-on")
            style.setImage(Self.headingImage(), forName: "heading")
        }

        // MARK: drawing the model

        func apply() {
            guard loaded, let style = view?.style else { return }
            let selected = map.selected
            let open = map.openBus
            let stretchData = MapGeoJson.stretch(color: color, path: path, open?.stretch)
            let stretchOn = stretchData != MapGeoJson.empty
            let stale = map.busesStale
            let now = (selected, dark, stretchOn, open?.id, stale)
            if applied == nil || applied! != now {
                applied = now
                (style.layer(withIdentifier: "route-casing") as? MLNLineStyleLayer)?.lineOpacity = NSExpression(forConstantValue: selected == nil ? 0.9 : 0.3)
                (style.layer(withIdentifier: "routes") as? MLNLineStyleLayer)?.lineOpacity = NSExpression(forConstantValue: selected == nil ? 0.9 : 0.18)
                if let on = style.layer(withIdentifier: "route-on") as? MLNLineStyleLayer {
                    on.predicate = NSPredicate(format: "svc == %@", selected ?? "")
                    on.lineOpacity = NSExpression(forConstantValue: stretchOn ? 0.2 : 1)
                }
                let onRoute: Any = selected.map { ["in", " \($0) ", ["get", "services"]] } ?? true
                let fade = E(["case", onRoute, 1, 0.35])
                if let dots = style.layer(withIdentifier: "stops") as? MLNCircleStyleLayer {
                    dots.circleOpacity = fade
                    dots.circleStrokeOpacity = fade
                }
                (style.layer(withIdentifier: "stop-names") as? MLNSymbolStyleLayer)?.textOpacity = E(["case", onRoute, 1, 0.4])
                (style.layer(withIdentifier: "bus-on") as? MLNSymbolStyleLayer)?.predicate = NSPredicate(format: "id == %@", open?.id ?? "")
                style.setImage(Self.busImage(fill: NSColor(hex: color), ring: paper), forName: "bus")
                // Last-known places while the feed is down: faded, so they don't pass for live.
                for id in ["buses", "bus-heading", "bus-on"] {
                    (style.layer(withIdentifier: id) as? MLNSymbolStyleLayer)?.iconOpacity = NSExpression(forConstantValue: stale ? 0.4 : 1)
                }
            }
            (style.source(withIdentifier: "stretch") as? MLNShapeSource)?.shape = shape(stretchData)
            let meData = map.me.map { MapGeoJson.me(lat: $0.lat, lon: $0.lon) } ?? MapGeoJson.empty
            (style.source(withIdentifier: "me") as? MLNShapeSource)?.shape = shape(meData)

            // Buses slide to each new place along their line (see Slides).
            // Every answer, even one the same as the last: a bus only jumps
            // after a while without one (Slides.staleS).
            if slidesFor != selected { slides = Slides(); slidesFor = selected; lastAnswer = map.busAnswers - 1 }
            if map.busAnswers != lastAnswer {
                lastAnswer = map.busAnswers
                slides.update(map.buses, path: path, now: Slides.clock, still: still)
                animate()
            }
            drawBuses()
            camera()
        }

        private func drawBuses() {
            guard let src = view?.style?.source(withIdentifier: "buses") as? MLNShapeSource else { return }
            let data = MapGeoJson.buses(svc: map.selected ?? "", color: color, slides.at(Slides.clock))
            src.shape = shape(data)
        }

        /// Redraws the buses each frame while one is on its way.
        private func animate() {
            guard timer == nil else { return }
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.frame() }
            }
            RunLoop.main.add(t, forMode: .common)
            timer = t
        }

        /// First view: the whole campus, once the view has a size to fit it in.
        func frameCampus() {
            guard !framed, let view, view.bounds.width > 100, view.bounds.height > 100 else { return }
            framed = true
            view.setVisibleCoordinateBounds(bounds(campus.coreBounds), edgePadding: NSEdgeInsets(top: 90, left: 24, bottom: 24, right: 24), animated: false, completionHandler: nil)
        }

        /// [west, south, east, north] as MapLibre's bounds.
        private func bounds(_ b: [Double]) -> MLNCoordinateBounds {
            MLNCoordinateBounds(sw: CLLocationCoordinate2D(latitude: b[1], longitude: b[0]), ne: CLLocationCoordinate2D(latitude: b[3], longitude: b[2]))
        }

        private func frame() {
            drawBuses()
            if !slides.moving(Slides.clock) {
                timer?.invalidate()
                timer = nil
            }
        }

        private func camera() {
            guard let view else { return }
            let pad = NSEdgeInsets(top: 100, left: 40, bottom: 40, right: 40)
            // Back to campus, from the button.
            if map.recentre != recentred {
                recentred = map.recentre
                view.setVisibleCoordinateBounds(bounds(campus.coreBounds), edgePadding: pad, animated: !still, completionHandler: nil)
            }
            // The zoom buttons: by the steps asked for since last time, within the map's limits.
            if map.zoomSteps != zoomedSteps {
                let to = view.zoomLevel + Double(map.zoomSteps - zoomedSteps)
                zoomedSteps = map.zoomSteps
                view.setZoomLevel(min(max(to, view.minimumZoomLevel), view.maximumZoomLevel), animated: !still)
            }
            // A stop chosen from the list: onto it, with a street or two round it.
            if map.focusCount != focused, let f = map.focus {
                focused = map.focusCount
                let d = 0.0015
                view.setVisibleCoordinateBounds(bounds([f.lon - d, f.lat - d, f.lon + d, f.lat + d]), edgePadding: pad, animated: !still, completionHandler: nil)
            }
            // A pill: its whole line in view, when it's chosen.
            if map.selected != framedLine {
                framedLine = map.selected
                if let r = map.selected.flatMap({ campus.routes[$0] }) {
                    view.setVisibleCoordinateBounds(bounds(r.bounds), edgePadding: pad, animated: !still, completionHandler: nil)
                }
            }
            // First view: your nearest stop when you're on campus, otherwise the whole campus.
            if !framedMe, let me = map.me {
                framedMe = true
                if map.selected == nil, let near = campus.stops.min(by: { pow($0.lat - me.lat, 2) + pow($0.lon - me.lon, 2) < pow($1.lat - me.lat, 2) + pow($1.lon - me.lon, 2) }),
                   abs(near.lat - me.lat) < nearCampusDeg, abs(near.lon - me.lon) < nearCampusDeg {
                    view.zoomLevel = 17
                    view.setCenter(CLLocationCoordinate2D(latitude: near.lat, longitude: near.lon), animated: false)
                }
            }
        }

        // MARK: clicks

        /// A bus first (it's on top), then the stop nearest the click; else the card closes.
        @objc func clicked(_ g: NSClickGestureRecognizer) {
            guard let view, g.state == .ended else { return }
            let p = g.location(in: view)
            let near = NSRect(x: p.x - 8, y: p.y - 8, width: 16, height: 16)
            if let id = view.visibleFeatures(at: near, styleLayerIdentifiers: ["buses"]).first?.attribute(forKey: "id") as? String {
                map.open(bus: id)
                return
            }
            let codes = view.visibleFeatures(at: near.insetBy(dx: -4, dy: -4), styleLayerIdentifiers: ["stops", "stop-names"]).compactMap { $0.attribute(forKey: "code") as? String }
            let at = view.convert(p, toCoordinateFrom: view)
            if let code = campus.nearest(codes, lat: at.latitude, lon: at.longitude) {
                map.open(stop: code)
            } else {
                map.sheet = nil
            }
        }

        // MARK: icons

        /// A bus: a disc of `fill`, ringed in the map's own colour.
        static func busImage(fill: NSColor, ring: NSColor) -> NSImage {
            NSImage(size: NSSize(width: 27, height: 27), flipped: false) { r in
                ring.setFill()
                NSBezierPath(ovalIn: r).fill()
                fill.setFill()
                NSBezierPath(ovalIn: r.insetBy(dx: 2.5, dy: 2.5)).fill()
                return true
            }
        }

        /// The clicked bus's ring, in the map's ink, a little way out from the bus.
        static func ringImage(_ ink: NSColor) -> NSImage {
            NSImage(size: NSSize(width: 40, height: 40), flipped: false) { _ in
                ink.setStroke()
                let p = NSBezierPath(ovalIn: NSRect(x: 3.5, y: 3.5, width: 33, height: 33))
                p.lineWidth = 2.5
                p.stroke()
                return true
            }
        }

        /// Which way a bus is going: points north before it's turned.
        static func headingImage() -> NSImage {
            NSImage(size: NSSize(width: 12, height: 12), flipped: true) { _ in
                let p = NSBezierPath()
                p.move(to: NSPoint(x: 6, y: 1.5))
                p.line(to: NSPoint(x: 9.5, y: 8.5))
                p.line(to: NSPoint(x: 6, y: 6.8))
                p.line(to: NSPoint(x: 2.5, y: 8.5))
                p.close()
                NSColor.white.setFill()
                p.fill()
                return true
            }
        }
    }
}

/// MapLibre's view, saying when it's laid out: a camera fitted before then has nothing to fit in.
private final class SizedMapView: MLNMapView {
    var sized: (() -> Void)?

    override func layout() {
        super.layout()
        // MapLibre takes in its new size during layout; a turn later it can fit a camera.
        DispatchQueue.main.async { [weak self] in self?.sized?() }
    }
}

private extension NSColor {
    /// "#rrggbb"; grey for anything else.
    convenience init(hex: String) { self.init(rgb: hexRGB(hex) ?? 0x8A939C) }
}
