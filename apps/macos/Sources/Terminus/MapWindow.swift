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
    /// The card over the map: a stop, or a bus. A stop opened from a bus's
    /// card remembers that bus (`from`), which Esc goes back to.
    enum Sheet: Equatable {
        /// A bus's card as it was: its stops ahead open (`stops`), and every one of them (`all`).
        struct Bus: Equatable {
            let id: String
            var stops = false
            var all = false
        }
        case stop(String, from: Bus? = nil)
        case bus(Bus)
    }
    enum BusStatus: Equatable { case finding, running(Int), noneRunning, unavailable, offline, stale }
    struct Spot: Equatable { let lat: Double; let lon: Double }

    var campus: CampusMap?
    var style: URL?
    var failed = false
    var selected: String?
    var buses: [LiveBus] = []
    /// Bumped by every answer from `/api/buses`, the same or not: each one plans
    /// the slides again, so a bus that hasn't moved still counts as heard from.
    var busAnswers = 0
    /// The feed is down, or the last answer is old, and these are its last
    /// places: drawn faded.
    var busesStale = false
    /// When `/api/buses` last answered (this Mac's clock).
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
    /// A stop chosen from the list, or the bus Esc goes back to, which the
    /// map moves to; `focusCount` is
    /// bumped each time, so choosing it again moves there again.
    var focus: Spot?
    var focusCount = 0

    /// Why the API refused the map: signed out (401) or this version too
    /// old (426). It asks nothing more until that changes: a new token, or
    /// the 426's hold over.
    enum Refusal: Equatable { case signedOut, outdated }
    var refused: Refusal?
    private var refusedToken: String?
    /// What the window opened with, for the style again after the map file failed.
    private var look = (dark: false, zh: false)

    /// Whether the map may ask the API now; clears a refusal that no longer holds.
    func mayAsk() -> Bool {
        switch refused {
        case .signedOut where TokenStore.read() != refusedToken, .outdated where !Outdated.active: refused = nil
        default: break
        }
        return refused == nil
    }

    /// A 401 or 426: stop asking, and have the popover check at once (it
    /// signs out, or offers the update).
    private func refuse(_ e: ApiError, token: String?, app: AppModel) {
        refused = e.status == 426 ? .outdated : .signedOut
        refusedToken = token
        app.mapRefused()
    }

    private static func refusal(_ error: Error) -> ApiError? {
        guard let e = error as? ApiError, e.status == 401 || e.status == 426 else { return nil }
        return e
    }

    var openStop: String? { if case .stop(let c, _) = sheet { c } else { nil } }
    var openBus: LiveBus? { if case .bus(let b) = sheet { buses.first { $0.id == b.id } } else { nil } }
    /// How the open bus's card was left, for it to open the same way.
    var openBusSheet: Sheet.Bus? { if case .bus(let b) = sheet { b } else { nil } }

    /// The campus and the style for this theme and language, then the street
    /// map file in the background (the style again once it's here).
    func open(dark: Bool, zh: Bool, app: AppModel) async {
        look = (dark, zh)
        // Asked first either way: back after signing in, the refusal goes.
        if mayAsk(), campus == nil {
            let token = TokenStore.read()
            do {
                campus = try await MapFiles.campus(token: token)
            } catch {
                if let e = Self.refusal(error) { refuse(e, token: token, app: app) }
            }
        }
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

    /// MapLibre couldn't load a style reading the map file: the file goes
    /// (the next look downloads it again) and the map is plain meanwhile.
    /// Only when the file itself fails the check: a load can fail for other
    /// reasons (its style file replaced meanwhile), and a good file kept is
    /// one the Mac needn't download again, offline perhaps.
    func tilesFailed(_ shown: URL) async {
        guard MapFiles.readsTiles(shown), let file = MapFiles.current, !MapFiles.looksLikeTiles(file) else { return }
        MapFiles.dropTiles()
        style = await MapFiles.style(dark: look.dark, zh: look.zh)
    }

    /// A pill: that service's line and buses, or off again.
    func choose(_ svc: String?) {
        selected = svc == selected ? nil : svc
        buses = []
        busesStale = false
        heardAt = nil
        busStatus = selected == nil ? nil : .finding
        if case .bus = sheet { sheet = nil }
        // That bus is gone with its service: Esc on its stop's card just closes.
        if case .stop(let code, _?) = sheet { sheet = .stop(code) }
    }

    /// A failed poll keeps the buses drawn and says so, as the web map does:
    /// "need a connection" when this Mac is offline (`online`). Once the last
    /// answer is 15 s old (three polls) they're faded, so last places don't
    /// pass for live. Refused (401, 426): it stops, and says why (`refused`).
    /// How long a polling loop waits before asking again: `base` while the
    /// API answers, doubling with each failure in a row up to a minute, and
    /// never sooner than a 429's or a 503's Retry-After (`quiet`, Quiet.wait).
    nonisolated static func pollDelay(base: TimeInterval, failures: Int, quiet: TimeInterval) -> TimeInterval {
        max(min(base * pow(2, Double(min(failures, 6))), max(base, 60)), quiet)
    }

    /// Whether the poll failed (no answer, or one that couldn't be read):
    /// the loop backs off. Not asking, or refused, isn't a failure here.
    @discardableResult
    func refreshBuses(app: AppModel) async -> Bool {
        guard let svc = selected, let q = svc.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), mayAsk() else { return false }
        let online = app.online
        let token = TokenStore.read()
        let list: BusList?
        do {
            list = BusList.parse(try await MapFiles.get("/api/buses?svc=\(q)", token: token))
        } catch {
            if let e = Self.refusal(error) {
                refuse(e, token: token, app: app)
                return false
            }
            if !Task.isCancelled, svc == selected {
                busStatus = online ? .unavailable : .offline
                if let heardAt, Date().timeIntervalSince(heardAt) > 15 { busesStale = true }
            }
            return true
        }
        guard svc == selected else { return false }
        guard let list else {
            busStatus = .unavailable
            return true
        }
        buses = list.buses
        busesStale = list.available && list.stale
        heardAt = Date()
        busAnswers += 1
        busStatus = !list.available ? .unavailable : list.stale ? .stale : list.buses.isEmpty ? .noneRunning : .running(list.buses.count)
        if case .bus(let b) = sheet, !buses.contains(where: { $0.id == b.id }) { sheet = nil }
        return false
    }

    /// A stop's card; `from`, the bus card it was opened from, which Esc returns to.
    func open(stop code: String, from: Sheet.Bus? = nil) {
        guard openStop != code else { sheet = .stop(code, from: from); return }
        sheet = .stop(code, from: from)
        board = nil
        boardFailed = false
    }

    func open(bus id: String) { sheet = .bus(Sheet.Bus(id: id)) }

    /// A stop from the list (no mouse needed) or from a bus's card (`from`):
    /// its card, and the map moved onto it.
    func pick(stop: MapStop, from: Sheet.Bus? = nil) {
        open(stop: stop.code, from: from)
        focus = Spot(lat: stop.lat, lon: stop.lon)
        focusCount += 1
    }

    /// Esc: from a stop opened from a bus, back to that bus's card as it was,
    /// if the bus is still on the map, and the map moved back onto the bus
    /// as it moved onto the stop; otherwise the card closes.
    func back() {
        if case .stop(_, let from?) = sheet, let bus = buses.first(where: { $0.id == from.id }) {
            sheet = .bus(from)
            focus = Spot(lat: bus.lat, lon: bus.lon)
            focusCount += 1
        } else {
            sheet = nil
        }
        board = nil
        boardFailed = false
    }

    /// The open stop's times. A failed refresh drops the last ones, as the
    /// web map does: minutes from before it would pass for current. Whether
    /// it failed, for the loop's back-off (as `refreshBuses`).
    @discardableResult
    func refreshBoard(app: AppModel) async -> Bool {
        guard let code = openStop, let q = code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed), mayAsk() else { return false }
        let token = TokenStore.read()
        var b: StopBoard?
        do {
            b = StopBoard.parse(try await MapFiles.get("/api/arrivals?stop=\(q)", token: token))
        } catch {
            if let e = Self.refusal(error) {
                refuse(e, token: token, app: app)
                return false
            }
            if Task.isCancelled { return false }
        }
        guard code == openStop else { return false }
        board = b
        boardFailed = b == nil
        return b == nil
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
                Text(map.refused?.text ?? L("The map needs a connection the first time."))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let campus = map.campus {
                VStack(alignment: .leading, spacing: 8) {
                    Pills(campus: campus, selected: map.selected) { map.choose($0) }
                    if let refused = map.refused {
                        StatusChip(text: refused.text).announced(refused.text)
                    } else if let status = map.busStatus {
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
                    case .stop(let code, _): if let stop = campus.stop(code) { StopCard(stop: stop, map: map, campus: campus, app: app) }
                    case .bus:
                        if let bus = map.openBus {
                            let svc = map.selected ?? ""
                            let was = map.openBusSheet
                            BusCard(bus: bus, svc: svc, hex: campus.color(svc), stop: BusCard.stop(for: bus, svc: svc, in: campus), campus: campus, show: { map.pick(stop: $0, from: $1) }, close: { map.sheet = nil }, open: was?.stops ?? false, all: was?.all ?? false)
                                // A fresh card for each bus: one bus's stops list open isn't another's.
                                .id(bus.id)
                        }
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
        // Back a step (to the bus a stop was opened from); the × closes outright.
        .onExitCommand { map.back() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { n in
            if let w = n.object as? NSWindow, w === window, visible { shown += 1 }
        }
        // Again after signing in, so a map refused while signed out loads.
        .task(id: "\(scheme)|\(app.paired)") { await map.open(dark: scheme == .dark, zh: Lang.zh, app: app) }
        // Live buses every 5 s while a pill is on (the API caches 5 s), not
        // while the window is hidden behind others or minimised. Failures in
        // a row back off, and a 429's or 503's Retry-After is waited out.
        .task(id: "\(map.selected ?? "")|\(shown)") {
            guard map.selected != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                if visible { failures = await map.refreshBuses(app: app) ? failures + 1 : 0 }
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 5, failures: failures, quiet: Quiet.wait())))
            }
        }
        // The open stop's times every 15 s (cached 15 s), backing off the same.
        .task(id: "\(map.openStop ?? "")|\(shown)") {
            guard map.openStop != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                if visible { failures = await map.refreshBoard(app: app) ? failures + 1 : 0 }
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 15, failures: failures, quiet: Quiet.wait())))
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

extension MapModel.Refusal {
    var text: String {
        switch self {
        case .signedOut: L("Signed out. Sign in again from terminus in the menu bar.")
        case .outdated: L("Update terminus to keep using it.")
        }
    }
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

/// The frame a stop's card and a bus's share, so the two read alike: a
/// `lead` tile beside the title, `sub` and close; a line of `facts`; then
/// `content` (a `SectionBand` and its rows), edge to edge; then the
/// `footer`'s buttons under a divider.
private struct MapCardFrame<Lead: View, Content: View>: View {
    let title: String
    let sub: String?
    /// Said when it opens, or shows another stop or bus.
    let announce: String
    let close: () -> Void
    var facts: AnyView? = nil
    var footer: AnyView? = nil
    @ViewBuilder let lead: () -> Lead
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Taller than the room it has, the header and rows scroll; the
            // footer's buttons stay in view under them.
            ViewThatFits(in: .vertical) {
                scrolled
                ScrollView(.vertical) { scrolled }
            }
            if let footer {
                Divider()
                HStack(spacing: 8) { footer }
                    .controlSize(.small)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    // The rows give up the room, never the buttons.
                    .layoutPriority(1)
            } else {
                Spacer().frame(height: 14)
            }
        }
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.18), radius: 8, y: 2)
        // It opens away from where the click (or the list) was: say which.
        .announced(announce)
    }

    /// Everything above the footer: the header, `facts` and `content`.
    private var scrolled: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 12) {
                lead()
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.system(size: 15, weight: .semibold)).accessibilityAddTraits(.isHeader)
                    if let sub { Text(sub).font(.system(size: 12)).foregroundStyle(.secondary) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                CloseButton(close: close)
            }
            .padding([.horizontal, .top], 14)
            if let facts { facts.padding(.horizontal, 14).padding(.top, 10) }
            content().padding(.top, 12)
        }
    }
}

/// The tile that leads a card's header, the same size for a stop as for a bus.
private struct CardTile<Content: View>: View {
    let fill: Color
    @ViewBuilder let content: () -> Content

    var body: some View {
        content()
            .frame(width: 48, height: 48)
            .background(fill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// A grey band naming what's under it, the same on a stop's card ("Buses
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
        } else {
            band.accessibilityAddTraits(.isHeader)
        }
    }

    private var band: some View {
        HStack(spacing: 4) {
            Text(text)
            Spacer(minLength: 6)
            if toggle != nil {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(open ? 90 : 0))
                    .accessibilityHidden(true)
            }
        }
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, minHeight: 30)
        .background(Color.primary.opacity(0.06))
        .contentShape(Rectangle())
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

/// A clicked bus: where its line ends and where it is or is going next, its
/// plate, whether it's moving and how full it is; then, opened, the stops
/// still ahead on a strip of its line. Every stop is the server's (`at`,
/// `stretch`, `upcoming`). Its button opens the card of the stop it's at or
/// coming to, as each stop's row does; Esc comes back here from it.
struct BusCard: View {
    let bus: LiveBus
    let svc: String
    /// The service's colour, as on its line.
    let hex: String
    /// The stop it's at or coming to (`stop(for:svc:in:)`), for "Show …".
    var stop: MapStop? = nil
    /// For the stops ahead's own cards; without it, the rows open nothing.
    var campus: CampusMap? = nil
    /// Opens a stop's card, with this card as it is now to come back to.
    var show: (MapStop, MapModel.Sheet.Bus) -> Void = { _, _ in }
    let close: () -> Void
    @State var open = false
    /// Every stop to where its line ends, not just the first few.
    @State var all = false

    /// Stops shown after the next one before "+N more".
    static let shownAfterNext = 4

    /// The stop a bus is at or coming to.
    static func stop(for bus: LiveBus, svc: String, in campus: CampusMap) -> MapStop? {
        bus.at != nil ? stop(code: bus.atCode, name: bus.at, for: bus, svc: svc, in: campus)
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

    /// This card as it is now, for Esc to come back to from a stop's card.
    private var now: MapModel.Sheet.Bus { MapModel.Sheet.Bus(id: bus.id, stops: open, all: all) }

    var body: some View {
        let tint = Color(hex: hex) ?? .gray
        let where_ = bus.at.map { L("At %@", $0) } ?? bus.nextStop.map { L("Next: %@", $0) }
        // Where its line ends leads, as a stop's name does; where it is comes under.
        let title = bus.towards.map { L("Towards %@", $0) } ?? where_ ?? L("%@ bus", svc)
        let sub = bus.towards != nil ? where_ : nil
        MapCardFrame(
            title: title,
            sub: sub,
            announce: L("%@: %@", svc, title),
            close: close,
            facts: AnyView(info),
            footer: stop.map { s in
                AnyView(
                    // Secondary: "Go there" on a stop's card is the one prominent button.
                    Button(L("Show %@", s.name)) { show(s, now) }
                        .buttonStyle(.bordered)
                )
            }
        ) {
            CardTile(fill: tint) {
                Text(svc)
                    .font(.system(size: 18, weight: .heavy))
                    .foregroundStyle(inkOn(hex))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.horizontal, 4)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(L("%@ bus", svc))
        } content: {
            if !stops.isEmpty {
                VStack(alignment: .leading, spacing: 0) {
                    SectionBand(text: L("Stops ahead"), open: open) {
                        withAnimation(.easeInOut(duration: 0.2)) { open.toggle() }
                    }
                    if open {
                        VStack(alignment: .leading, spacing: 2) {
                            strip(tint)
                            if past > 1 {
                                Button(all ? L("Show fewer") : L("Show %@ more stops", "\(more)")) {
                                    withAnimation(.easeInOut(duration: 0.2)) { all.toggle() }
                                }
                                .buttonStyle(.link)
                                .font(.system(size: 12, weight: .medium))
                                .padding(.leading, 26)
                                .padding(.top, 2)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }
                .clipped()
            }
        }
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

    /// Their codes, in step with `stops`; nil where the server didn't say.
    private var stopCodes: [String?] {
        if !bus.upcoming.isEmpty { return bus.upcoming.indices.map { bus.upcomingCodes.indices.contains($0) ? bus.upcomingCodes[$0] : nil } }
        return bus.nextStop == nil ? [] : [bus.nextStopCode]
    }

    enum Kind { case passed, between, here, next, ahead }
    /// A row of the strip: a stop (`code` when the server gave it), or the bus on its way.
    struct Row { let name: String; let kind: Kind; var code: String? = nil }

    /// Stops past the first few. Just one is shown rather than hidden behind
    /// a button, as on the stop's card.
    private var past: Int { max(0, stops.count - (1 + Self.shownAfterNext)) }

    /// Stops ahead not shown: none once all are, or when only one would be.
    var more: Int { all || past <= 1 ? 0 : past }

    /// The strip's rows, top to bottom: the stop it passed and itself on the
    /// way, or the stop it's at; then the next stop and a few after it (or
    /// every one, with `all`).
    var rows: [Row] {
        var r: [Row] = []
        if let at = bus.at {
            r.append(Row(name: at, kind: .here, code: bus.atCode))
        } else if let last = bus.stretch?.last {
            r.append(Row(name: last, kind: .passed, code: bus.passedCode))
            r.append(Row(name: L("On its way"), kind: .between))
        }
        let shown = more == 0 ? stops[...] : stops.prefix(1 + Self.shownAfterNext)
        let codes = stopCodes
        for (i, s) in shown.enumerated() { r.append(Row(name: s, kind: i == 0 ? .next : .ahead, code: codes[i])) }
        return r
    }

    private func strip(_ tint: Color) -> some View {
        let rows = rows
        let more = more
        let grey = Color.secondary.opacity(0.4)
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                // Grey down to the bus, its colour on from there; on past the
                // last row when more stops follow.
                let above: Color? = i == 0 ? nil : (row.kind == .between || row.kind == .here ? grey : tint)
                let below: Color? = i == rows.count - 1 && more == 0 ? nil : (row.kind == .passed ? grey : tint)
                // A stop's row opens its card, and its chevron says so; the bus's own row doesn't.
                if row.kind != .between, let campus, let s = Self.stop(code: row.code, name: row.name, for: bus, svc: svc, in: campus) {
                    Button { show(s, now) } label: { line(row, tint, above: above, below: below, chevron: true) }
                        .buttonStyle(.plain)
                        .accessibilityHint(L("Show this stop"))
                } else {
                    line(row, tint, above: above, below: below, chevron: false)
                }
            }
            if more > 0 {
                // The line fading out: it goes on, and the button under it shows the rest.
                LinearGradient(colors: [tint, tint.opacity(0)], startPoint: .top, endPoint: .bottom)
                    .frame(width: 3, height: 14)
                    .frame(width: 16)
                    .accessibilityHidden(true)
            }
        }
    }

    /// One row of the strip: its piece of the line with the stop's dot or the
    /// bus, the name, and a chevron when it opens the stop's card.
    private func line(_ row: Row, _ tint: Color, above: Color?, below: Color?, chevron: Bool) -> some View {
        let bold = row.kind == .next || row.kind == .here
        return HStack(spacing: 10) {
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
            // Passed, here and next are drawn on the line (grey, the
            // bus, bold), not written beside it; VoiceOver hears the word.
            Text(row.name)
                .font(.system(size: bold ? 13 : 12, weight: bold ? .bold : .regular))
                .foregroundStyle(row.kind == .passed || row.kind == .between ? .secondary : .primary)
                .lineLimit(1)
            Spacer(minLength: 6)
            if chevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .frame(height: row.kind == .between ? 20 : 24)
        .opacity(row.kind == .passed ? 0.6 : 1)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityValue(said(row.kind) ?? "")
    }

    private func said(_ kind: Kind) -> String? {
        switch kind {
        case .passed: L("passed")
        case .here: L("here")
        case .next: L("next")
        case .ahead, .between: nil
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

/// A clicked stop: its buses due, each showing its line when clicked; then
/// going there, walking there, in the footer.
struct StopCard: View {
    let stop: MapStop
    let map: MapModel
    let campus: CampusMap
    let app: AppModel
    @State var sent = false

    var body: some View {
        MapCardFrame(
            title: stop.name,
            sub: stop.longName.flatMap { $0 == stop.name ? nil : $0 },
            announce: stop.name,
            close: { map.sheet = nil },
            footer: AnyView(footer)
        ) {
            // A stop's tile, where a bus's has its service: the two headers line up.
            CardTile(fill: Color.secondary.opacity(0.18)) {
                Image(systemName: "mappin.and.ellipse")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(.primary)
            }
            .accessibilityHidden(true)
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                SectionBand(text: L("Buses here"))
                rows.font(.system(size: 12))
            }
        }
        .onChange(of: stop.code) { sent = false }
    }

    @ViewBuilder private var rows: some View {
        if let board = map.board, !board.rows.isEmpty, map.refused == nil, !map.boardFailed {
            VStack(spacing: 0) {
                ForEach(Array(board.rows.enumerated()), id: \.element.svc) { i, r in
                    if i > 0 { Divider().padding(.leading, 14) }
                    let picked = map.selected == r.svc
                    // A row picks its line, as the pills do, and again unpicks it
                    // (`choose` toggles). It opens no page, so it has no chevron;
                    // the picked line's row is washed in its colour.
                    Button { map.choose(r.svc) } label: {
                        HStack {
                            SvcTag(svc: r.svc, hex: campus.color(r.svc))
                            Spacer()
                            Text(eta(r)).font(.system(size: 12, weight: .semibold)).monospacedDigit()
                        }
                        .padding(.horizontal, 14)
                        .frame(minHeight: 30)
                        .background(picked ? (Color(hex: campus.color(r.svc)) ?? .gray).opacity(0.16) : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(picked ? L("%@: hide its line", r.svc) : L("%@: show its line and live buses", r.svc))
                    // "D2: about 6 min", one element a row.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spokenTimes(L("%@: %@", r.svc, eta(r))))
                    .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.top, 4)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text(note).foregroundStyle(.secondary)
                // No times to list them by: the services here, each showing its line.
                if map.board != nil || map.boardFailed || map.refused != nil {
                    HStack(spacing: 5) {
                        ForEach(stop.services, id: \.self) { svc in
                            Button { if map.selected != svc { map.choose(svc) } } label: {
                                SvcTag(svc: svc, hex: campus.color(svc))
                            }
                            .buttonStyle(.plain)
                            .help(L("%@: show its line and live buses", svc))
                        }
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
    }

    private var note: String {
        if let refused = map.refused { return refused.text }
        if map.boardFailed { return app.online ? L("No times right now") : L("Live times need a connection.") }
        guard let board = map.board else { return L("Refreshing") }
        return board.available ? L("No buses due") : L("No times right now")
    }

    @ViewBuilder private var footer: some View {
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

    /// The server's "4 min" ("now", "~6 min"); for an older server's row,
    /// worded as the popover's Nearby words it, so the two never differ.
    private func eta(_ r: BoardRow) -> String { FlowPills.eta(r) }
}

// MARK: - MapLibre

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
        view.sized = { [weak coordinator = context.coordinator] in
            coordinator?.frameCampus()
            coordinator?.keepOnMap()
        }
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

    /// The window closed: the slide's display link stops with it, and the
    /// view no longer calls back into a coordinator that's going.
    static func dismantleNSView(_ view: MLNMapView, coordinator: Coordinator) {
        coordinator.stopAnimating()
        view.delegate = nil
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
        private var link: CADisplayLink?
        /// What the stretch and your dot were last set to: set again only when they change.
        private var drawnStretch: Data?
        private var drawnMe: Data?
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
            drawnStretch = nil
            drawnMe = nil
            apply()
            if let styleURL { MapFiles.styleLoaded(styleURL) }
        }

        /// A map file MapLibre can't read: dropped, and the plain map instead.
        func mapViewDidFailLoadingMap(_ mapView: MLNMapView, withError error: any Error) {
            // A style already replaced (the look changed) failing is no news.
            guard let failed = mapView.styleURL, failed == styleURL else { return }
            Task { await map.tilesFailed(failed) }
        }

        /// The window stays on the street map (PanLimit): a drag off it is
        /// refused. A zoom goes ahead, and one out by an edge is brought back
        /// once it ends (keepOnMap), as is a drag that heads back on.
        func mapView(_ mapView: MLNMapView, shouldChangeFrom oldCamera: MLNMapCamera, to newCamera: MLNMapCamera) -> Bool {
            let zoom = mapView.zoomLevel + log2(oldCamera.altitude / newCamera.altitude)
            if abs(zoom - mapView.zoomLevel) > 0.001 { return true }
            let box = centreBox(mapView, zoom: zoom)
            let off = offBy(newCamera.centerCoordinate, box)
            return off == 0 || off < offBy(oldCamera.centerCoordinate, box)
        }

        func mapView(_ mapView: MLNMapView, cameraDidChangeAnimated animated: Bool) { keepOnMap() }

        /// Back onto the street map after a zoom out by its edge or a bigger window,
        /// and no further out than the window full of map.
        func keepOnMap() {
            guard let view, view.bounds.width > 0, view.bounds.height > 0 else { return }
            view.minimumZoomLevel = max(13, PanLimit.minZoom(width: view.bounds.width, height: view.bounds.height))
            let box = centreBox(view, zoom: view.zoomLevel)
            let c = view.centerCoordinate
            guard offBy(c, box) > 1e-9 else { return }
            view.setCenter(CLLocationCoordinate2D(latitude: min(max(c.latitude, box[1]), box[3]), longitude: min(max(c.longitude, box[0]), box[2])), animated: true)
        }

        private func centreBox(_ view: MLNMapView, zoom: Double) -> [Double] {
            PanLimit.centre(width: view.bounds.width, height: view.bounds.height, zoom: zoom)
        }

        /// How far (in degrees, the larger way) `c` is outside `box`; 0 inside it.
        private func offBy(_ c: CLLocationCoordinate2D, _ box: [Double]) -> Double {
            max(box[0] - c.longitude, c.longitude - box[2], box[1] - c.latitude, c.latitude - box[3], 0)
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
            if stretchData != drawnStretch {
                drawnStretch = stretchData
                (style.source(withIdentifier: "stretch") as? MLNShapeSource)?.shape = shape(stretchData)
            }
            let meData = map.me.map { MapGeoJson.me(lat: $0.lat, lon: $0.lon) } ?? MapGeoJson.empty
            if meData != drawnMe {
                drawnMe = meData
                (style.source(withIdentifier: "me") as? MLNShapeSource)?.shape = shape(meData)
            }

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

        /// Features made here, not GeoJSON written and read again: a slide
        /// sets them every frame.
        private func drawBuses() {
            guard let src = view?.style?.source(withIdentifier: "buses") as? MLNShapeSource else { return }
            let svc = map.selected ?? "", color = color
            let features = slides.at(Slides.clock).map { b in
                let f = MLNPointFeature()
                f.coordinate = CLLocationCoordinate2D(latitude: b.lat, longitude: b.lon)
                f.attributes = MapGeoJson.busProperties(svc: svc, color: color, b)
                return f
            }
            src.shape = MLNShapeCollectionFeature(shapes: features)
        }

        /// Redraws the buses with the screen while one is on its way, at up
        /// to 30 frames a second: enough for a bus crossing a few pixels.
        private func animate() {
            guard link == nil, let view, isShown(view) else { return }
            let l = view.displayLink(target: LinkTarget(self), selector: #selector(LinkTarget.tick))
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 15, maximum: 30, preferred: 30)
            l.add(to: .main, forMode: .common)
            link = l
        }

        func stopAnimating() {
            link?.invalidate()
            link = nil
        }

        /// Hidden, minimised or covered, there's nothing to draw for: the
        /// buses are drawn where they are once it's back (the polls start
        /// again then, and each answer plans the slides again).
        private func isShown(_ view: NSView) -> Bool {
            guard let w = view.window else { return false }
            return w.isVisible && !w.isMiniaturized && w.occlusionState.contains(.visible)
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

        fileprivate func frame() {
            guard let view, isShown(view) else { return stopAnimating() }
            drawBuses()
            if !slides.moving(Slides.clock) { stopAnimating() }
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
            // A stop chosen from the list (or the bus Esc went back to): onto it, with a street or two round it.
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

/// The display link's target. The link holds its target strongly, so this
/// holds the coordinator weakly: once that's gone, the link stops itself
/// rather than firing for ever.
@MainActor private final class LinkTarget: NSObject {
    weak var coordinator: CampusMapView.Coordinator?

    init(_ coordinator: CampusMapView.Coordinator) { self.coordinator = coordinator }

    @objc func tick(_ link: CADisplayLink) {
        guard let coordinator else { return link.invalidate() }
        coordinator.frame()
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
