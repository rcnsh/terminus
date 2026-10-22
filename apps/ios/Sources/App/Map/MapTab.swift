import SwiftUI
import UIKit

/// The Map tab: the campus's streets, every service's line in its colour,
/// the stops, a pill per service along the top (one at a time: its line and
/// live buses), and a sheet for a tapped stop or bus. As Android's MapScreen.
///
/// It asks the server for nothing while it's off screen or the app is in the
/// background: buses every 5 s while a pill is on (the API caches 5 s), a
/// stop's times every 15 s while its sheet is open (cached 15 s), your dot
/// every 20 s with location already allowed.
struct MapTab: View {
    @State private var map = MapModel.shared
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var onScreen = false
    /// How much of the map the pills and the sheet cover, for the camera.
    @State private var topCover: CGFloat = 0
    @State private var sheetCover: CGFloat = 0
    /// Location was refused: "Show where you are" offers Settings.
    @State private var locationOff = false

    private var active: Bool { onScreen && phase == .active }
    private var dark: Bool { scheme == .dark }

    var body: some View {
        ZStack(alignment: .top) {
            Color.page.ignoresSafeArea()
            if let campus = map.campus, let style = map.style {
                CampusMapView(
                    map: map, campus: campus, style: style, dark: dark, still: reduceMotion,
                    cover: UIEdgeInsets(top: topCover, left: 0, bottom: sheetCover, right: 0), shown: active,
                    drawn: .init(
                        selected: map.selected, buses: map.buses, answers: map.busAnswers, stale: map.busesStale, sheet: map.sheet,
                        me: map.me,
                        recentre: map.recentre, focusCount: map.focusCount, locateCount: map.locateCount)
                )
                .ignoresSafeArea(edges: .top)
                // The stops and buses are reached only by a finger on them. To
                // VoiceOver it says so, and offers the same as a list.
                .accessibilityLabel(L("Campus map. For stops and buses as a list, use the Buses tab."))
                .accessibilityAction(named: L("Show as list")) { showList() }
            } else if map.failed {
                Text(L("The map needs a connection the first time."))
                    .font(.body)
                    .foregroundStyle(Color.muted)
                    .multilineTextAlignment(.center)
                    .padding(32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let campus = map.campus {
                top(campus)
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if map.campus != nil, map.sheet == nil {
                controls.padding(.trailing, 12).padding(.bottom, 16)
            }
        }
        .overlay(alignment: .bottom) {
            if let campus = map.campus { sheet(campus) }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: map.sheet == nil)
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        // Again when the look changes, and on each visit for whatever failed last time.
        .onChange(of: "\(dark)|\(Lang.zh)|\(onScreen)", initial: true) {
            if onScreen { map.open(dark: dark, zh: Lang.zh) }
        }
        .onChange(of: onScreen) { _, on in if on { Task { await map.loadProfile() } } }
        // Live buses every 5 s while a pill is on and the map is in view.
        // Failures in a row back off, and a 429's or 503's Retry-After is waited out.
        .task(id: "\(map.selected ?? "")|\(active)") {
            guard active, map.selected != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                failures = await map.refreshBuses() ? failures + 1 : 0
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 5, failures: failures, quiet: Quiet.wait())))
            }
        }
        // The open stop's times every 15 s, backing off the same.
        .task(id: "\(map.openStop ?? "")|\(active)") {
            guard active, map.openStop != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                failures = await map.refreshBoard() ? failures + 1 : 0
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 15, failures: failures, quiet: Quiet.wait())))
            }
        }
        // Your dot every 20 s, only with location already allowed.
        .task(id: "\(active)|\(Locator.shared.allowed)") {
            guard active else { return }
            while !Task.isCancelled {
                await map.locate()
                try? await Task.sleep(for: .seconds(20))
            }
        }
        .alert(L("Location is off"), isPresented: $locationOff) {
            Button(L("Open Settings")) {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("Open settings to allow location"))
        }
        #if DEBUG
            .onAppear { DevMap.start(map) }
        #endif
    }

    // MARK: over the map

    /// The pills, and the status lines under them.
    private func top(_ campus: CampusMap) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Pills(campus: campus, selected: map.selected) { map.choose($0) }
            Group {
                if let status = map.busStatus, let svc = map.selected {
                    // Said for a new service, or when its buses go to or from
                    // none; not at every bus that joins or leaves.
                    StatusChip(text: status.text(svc))
                        .announcedWhen(status.text(svc), key: "\(svc)|\(status.heard)")
                }
                // The feed is down: these are where the buses were last seen.
                if map.busesStale { StatusChip(text: L("Bus positions may be out of date")) }
                if let notice = map.notice { StatusChip(text: notice, undo: map.noticeUndo) }
                if map.downloading {
                    StatusChip(text: L("Downloading the street map (about 4 MB)…"), busy: true)
                } else if map.downloadFailed {
                    StatusChip(text: L("The street map hasn't downloaded yet. Routes and stops are still available."))
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.top, 8)
        .onGeometryChange(for: CGFloat.self) {
            $0.frame(in: .global).maxY
        } action: {
            topCover = $0
        }
    }

    /// The map's own buttons, in its corner: your location, and back to campus.
    private var controls: some View {
        VStack(spacing: 10) {
            MapButton(symbol: Locator.shared.denied ? "location.slash" : "location", label: L("Show where you are"), id: "map.locate") {
                if Locator.shared.denied { locationOff = true } else { Task { await map.locateMe() } }
            }
            // Lost after a pinch or a drag: one tap back to the whole campus.
            MapButton(symbol: "scope", label: L("Back to campus"), id: "map.recentre") { map.recentre += 1 }
        }
    }

    // MARK: the sheet

    @ViewBuilder private func sheet(_ campus: CampusMap) -> some View {
        Group {
            switch map.sheet {
            case .stop(let code, let from)?:
                if let stop = campus.stop(code) {
                    StopSheet(stop: stop, map: map, campus: campus, back: from != nil && map.buses.contains { $0.id == from?.id })
                        .id("stop-\(code)")
                }
            case .bus?:
                if let bus = map.openBus {
                    let svc = map.selected ?? ""
                    let was = map.openBusSheet
                    BusSheet(
                        bus: bus, svc: svc, hex: campus.color(svc), campus: campus, map: map, open: was?.stops ?? false,
                        all: was?.all ?? false
                    )
                    // A fresh sheet for each bus: one bus's stops list open isn't another's.
                    .id("bus-\(bus.id)")
                }
            case nil:
                EmptyView()
            }
        }
        .transition(reduceMotion ? .opacity : .move(edge: .bottom))
        .onGeometryChange(for: CGFloat.self) {
            $0.size.height
        } action: {
            sheetCover = $0
        }
        .onChange(of: map.sheet == nil) { _, none in if none { sheetCover = 0 } }
    }

    /// The map as a list, for VoiceOver: the Buses tab, on the open stop or the chosen service's line.
    private func showList() {
        if let stop = map.openStop { AppModel.shared.openStop = stop } else if let svc = map.selected { AppModel.shared.openLine = svc }
        NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.buses)
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
        case .unavailable: L("Live buses aren't available right now.")
        }
    }
}

extension View {
    /// Says `message` to VoiceOver when it appears and when `key` changes.
    fileprivate func announcedWhen(_ message: String, key: String) -> some View {
        onAppear { announce(message) }.onChange(of: key) { announce(message) }
    }
}

/// A pill per service: one at a time shows its line and live buses.
private struct Pills: View {
    let campus: CampusMap
    let selected: String?
    let choose: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(campus.services, id: \.self) { svc in
                    let hex = campus.color(svc)
                    let rgb = hexRGB(hex) ?? 0x8A939C
                    let on = svc == selected
                    Button {
                        choose(svc)
                    } label: {
                        HStack(spacing: 6) {
                            Circle().fill(on ? inkOn(rgb) : Color(rgb: rgb)).frame(width: 10, height: 10)
                            Text(verbatim: svc).font(.subheadline.weight(.semibold))
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .foregroundStyle(on ? inkOn(rgb) : Color.ink)
                        .background(on ? AnyShapeStyle(Color(rgb: rgb)) : AnyShapeStyle(Color.surface), in: Capsule())
                        .overlay(Capsule().strokeBorder(on ? Color.clear : Color.line))
                        .shadow(color: .black.opacity(0.14), radius: 3, y: 1)
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("map.pill.\(svc)")
                    .accessibilityLabel(L("%@: show its line and live buses", svc))
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
    }
}

/// A line of status over the map, under the pills.
private struct StatusChip: View {
    let text: String
    var busy = false
    var undo: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            if busy { ProgressView().controlSize(.small) }
            Text(text).font(.footnote).foregroundStyle(Color.muted)
            if let undo {
                Button(L("Undo"), action: undo)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.brand)
                    .accessibilityIdentifier("map.undo")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color.surface, in: Capsule())
        .shadow(color: .black.opacity(0.12), radius: 3, y: 1)
        .accessibilityElement(children: undo == nil ? .combine : .contain)
    }
}

/// A round button over the map, named for VoiceOver.
private struct MapButton: View {
    let symbol: String
    let label: String
    let id: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 44, height: 44)
                .background(Color.surface, in: Circle())
                .overlay(Circle().strokeBorder(Color.line))
                .shadow(color: .black.opacity(0.15), radius: 4, y: 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
}

#if DEBUG
    /// For the UI tests and screenshots, in debug builds only: TERMINUS_MAP_SVC
    /// turns a pill on, TERMINUS_MAP_STOP opens a stop (as Nearby on Now does),
    /// TERMINUS_MAP_BUS=1 opens the first bus once there are some.
    @MainActor enum DevMap {
        private static var done = false

        static func start(_ map: MapModel) {
            guard !done else { return }
            done = true
            Task { await apply(map) }
        }

        private static func apply(_ map: MapModel) async {
            let env = ProcessInfo.processInfo.environment
            if let svc = env["TERMINUS_MAP_SVC"], !svc.isEmpty { map.show(svc) }
            if let stop = env["TERMINUS_MAP_STOP"], !stop.isEmpty {
                while map.campus == nil { try? await Task.sleep(for: .milliseconds(200)) }
                try? await Task.sleep(for: .seconds(1))
                map.showStop(stop)
            }
            if env["TERMINUS_MAP_BUS"] == "1" {
                while map.buses.isEmpty { try? await Task.sleep(for: .milliseconds(200)) }
                try? await Task.sleep(for: .seconds(1))
                if let bus = map.buses.first(where: { $0.at == nil && $0.stretch != nil }) ?? map.buses.first { map.open(bus: bus.id) }
            }
        }
    }
#endif
