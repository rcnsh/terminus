import SwiftUI
import UIKit

struct MapTab: View {
    @State private var map = MapModel.shared
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var phase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var onScreen = false
    @State private var topCover: CGFloat = 0
    @State private var sheetCover: CGFloat = 0
    @State private var wide = false
    @State private var bottom: CGFloat = 800
    @State private var under = EdgeInsets()
    @State private var locationOff = false
    @State private var tabsAbove = false

    private var active: Bool { onScreen && phase == .active }
    private var dark: Bool { scheme == .dark }

    var body: some View {
        ZStack(alignment: .top) {
            Color.page.ignoresSafeArea()
            if let campus = map.campus, let style = map.style {
                CampusMapView(
                    map: map, campus: campus, style: style, dark: dark, still: reduceMotion,
                    cover: cover, bars: UIEdgeInsets(top: 0, left: under.leading, bottom: under.bottom, right: under.trailing),
                    floating: wide && sheetCover > 0 ? sheetCover + 16 : 0, shown: active,
                    drawn: .init(
                        selected: map.selected, buses: map.buses, answers: map.busAnswers, stale: map.busesStale, sheet: map.sheet,
                        me: map.me,
                        recentre: map.recentre, focusCount: map.focusCount, locateCount: map.locateCount)
                )
                .ignoresSafeArea()
                .accessibilityLabel(L("Campus map. For stops and buses as a list, use the Stops tab."))
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
            if map.campus != nil, map.style != nil {
                Color.clear
                    .frame(height: 8)
                    .background(alignment: .bottom) {
                        LinearGradient(colors: [Color.page.opacity(0.85), Color.page.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .ignoresSafeArea(edges: .top)
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            if let campus = map.campus {
                top(campus)
            }
        }
        .onGeometryChange(for: Bool.self) {
            $0.size.width >= mapSheetFloatsFrom
        } action: {
            wide = $0
        }
        .onGeometryChange(for: CGFloat.self) {
            $0.frame(in: .global).maxY
        } action: {
            bottom = $0
        }
        .onGeometryChange(for: EdgeInsets.self) {
            $0.safeAreaInsets
        } action: { insets in
            under = insets
            let window = (UIApplication.shared.connectedScenes.first as? UIWindowScene)?.keyWindow?.safeAreaInsets.top ?? insets.top
            tabsAbove = insets.top > window + 1
        }
        .overlay(alignment: .bottomTrailing) {
            if map.campus != nil, map.sheet == nil || wide {
                controls.padding(.trailing, 12).padding(.bottom, 16)
            }
        }
        .overlay(alignment: wide ? .bottomLeading : .bottom) {
            if let campus = map.campus {
                sheet(campus)
                    .frame(width: wide ? mapSheetWidth : nil)
                    .padding(wide ? 16 : 0)
                    .environment(\.mapSheetFloats, wide)
                    .environment(\.mapSheetRoom, bottom - topCover - 32)
            }
        }
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: map.sheet == nil)
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .onChange(of: "\(dark)|\(Lang.zh)|\(onScreen)", initial: true) {
            if onScreen { map.open(dark: dark, zh: Lang.zh) }
        }
        .onChange(of: onScreen) { _, on in if on { Task { await map.loadProfile() } } }
        .task(id: "\(map.selected ?? "")|\(active)") {
            guard active, map.selected != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                failures = await map.refreshBuses() ? failures + 1 : 0
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 5, failures: failures, quiet: Quiet.wait())))
            }
        }
        .task(id: "\(map.openStop ?? "")|\(active)") {
            guard active, map.openStop != nil else { return }
            var failures = 0
            while !Task.isCancelled {
                failures = await map.refreshBoard() ? failures + 1 : 0
                try? await Task.sleep(for: .seconds(MapModel.pollDelay(base: 15, failures: failures, quiet: Quiet.wait())))
            }
        }
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

    private var cover: UIEdgeInsets {
        guard wide else { return UIEdgeInsets(top: topCover, left: 0, bottom: sheetCover, right: 0) }
        return UIEdgeInsets(top: topCover, left: sheetCover > 0 ? mapSheetWidth + 16 : 0, bottom: 0, right: 0)
    }

    private func top(_ campus: CampusMap) -> some View {
        VStack(spacing: 8) {
            Pills(campus: campus, selected: map.selected) { map.choose($0) }
            Group {
                if let status = map.busStatus, let svc = map.selected {
                    StatusChip(text: status.text(svc))
                        .announcedWhen(status.text(svc), key: "\(svc)|\(status.heard)")
                }
                if map.busesStale { StatusChip(text: L("Bus positions may be out of date")) }
                if let notice = map.notice { StatusChip(text: notice, undo: map.noticeUndo) }
                if map.downloading {
                    StatusChip(text: L("Downloading the street map (about 4 MB)…"), busy: true)
                } else if map.downloadFailed {
                    StatusChip(text: L("The street map hasn't downloaded yet. Routes and stops are still available."))
                }
            }
            .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 8)
        .padding(.top, tabsAbove ? -12 : 8)
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self) {
            $0.frame(in: .global).maxY
        } action: {
            topCover = $0
        }
    }

    private var controls: some View {
        VStack(spacing: 10) {
            MapButton(symbol: Locator.shared.denied ? "location.slash" : "location", label: L("Show where you are"), id: "map.locate") {
                if Locator.shared.denied { locationOff = true } else { Task { await map.locateMe() } }
            }
            MapButton(symbol: "building.columns", label: L("Back to campus"), id: "map.recentre") { map.recentre += 1 }
        }
    }

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
                    .id("bus-\(bus.id)")
                }
            case nil:
                EmptyView()
            }
        }
        .transition(reduceMotion ? .opacity : wide ? .move(edge: .bottom).combined(with: .opacity) : .move(edge: .bottom))
        .onGeometryChange(for: CGFloat.self) {
            $0.size.height
        } action: {
            sheetCover = $0
        }
        .onChange(of: map.sheet == nil) { _, none in if none { sheetCover = 0 } }
    }

    private func showList() {
        if let stop = map.openStop {
            AppModel.shared.showInBuses([.stop(stop)])
        } else if let svc = map.selected {
            AppModel.shared.showInBuses([.line(svc: svc, from: nil)])
        } else {
            NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.buses)
        }
    }
}

extension MapModel.BusStatus {
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
    fileprivate func announcedWhen(_ message: String, key: String) -> some View {
        onAppear { announce(message) }.onChange(of: key) { announce(message) }
    }
}

private struct Pills: View {
    let campus: CampusMap
    let selected: String?
    let choose: (String) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row.floatingBar()
            ScrollView(.horizontal, showsIndicators: false) { row }
                .fadedEnds()
                .clipShape(Capsule())
                .floatingBar()
        }
    }

    private var row: some View {
        HStack(spacing: 0) {
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
                    .background(on ? Color(rgb: rgb) : .clear, in: Capsule())
                    .padding(.vertical, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("map.pill.\(svc)")
                .accessibilityLabel(L("%@: show its line and live buses", svc))
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(.horizontal, 4)
    }
}

private struct FadedEnds: ViewModifier {
    @State private var before = false
    @State private var after = true

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content
                .onScrollGeometryChange(for: [Bool].self) { g in
                    [g.contentOffset.x > 1, g.contentOffset.x + g.containerSize.width < g.contentSize.width - 1]
                } action: { _, ends in
                    before = ends[0]
                    after = ends[1]
                }
                .mask(fade)
        } else {
            content.mask(fade)
        }
    }

    private var fade: some View {
        HStack(spacing: 0) {
            LinearGradient(colors: [before ? .clear : .black, .black], startPoint: .leading, endPoint: .trailing).frame(width: 28)
            Color.black
            LinearGradient(colors: [.black, after ? .clear : .black], startPoint: .leading, endPoint: .trailing).frame(width: 28)
        }
    }
}

extension View {
    fileprivate func fadedEnds() -> some View { modifier(FadedEnds()) }

    @ViewBuilder fileprivate func floatingBar() -> some View {
        if #available(iOS 26, *) {
            glassEffect(.regular, in: Capsule())
        } else {
            background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color.line.opacity(0.6), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.12), radius: 6, y: 1)
        }
    }
}

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
        .floatingBar()
        .accessibilityElement(children: undo == nil ? .combine : .contain)
    }
}

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
