import SwiftUI
import UIKit

struct NowView: View {
    @Environment(AppModel.self) private var app
    @Environment(Prefs.self) private var prefs
    @Environment(\.colorScheme) private var scheme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.windowWidth) private var width
    @Environment(\.windowShort) private var short
    private let sky = SkyClock.shared
    private let locator = Locator.shared
    @State private var searching = false
    @State private var scrolled: CGFloat = 0
    @State private var onScreen = false
    @State private var reporting = false
    @State private var addEmail = false
    @State private var signingIn = false
    @State private var goingLater = false
    @State private var pull = SkyPull()
    @State private var chipsWidth: CGFloat = 0
    @State private var chipsRoom: CGFloat = 0

    private var beside: Bool { width.panes && hasDay }

    private var hasDay: Bool { (app.day.map { !$0.items.isEmpty } ?? false) || app.removed != nil }

    private var skyWidth: CGFloat { beside ? wideColumnWidth : columnWidth }

    private var noticesAt: NoticesAt { NoticesAt.of(short: short) }

    var body: some View {
        let phase = sky.phase
        let p = SkyPalette.of(phase, dark: scheme == .dark)
        GeometryReader { outer in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            if short {
                                Spacer().frame(height: 10)
                            } else {
                                header
                            }
                            if noticesAt == .sky { notices }
                            chips
                            if searching {
                                NowSearch { searching = false }
                                    .padding(.top, 12)
                            }
                        }
                        .column(width: skyWidth)
                        .pullLead()
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            let shows = NowShows.of(app, now: ServerClock.now)
                            VStack(alignment: .leading, spacing: 0) {
                                Room(height: shows.room, phase: phase, scrolled: scrolled)
                                if beside {
                                    HStack(alignment: .top, spacing: Self.halvesGap) {
                                        NowHead(shows: shows, now: ServerClock.now).frame(maxWidth: .infinity, alignment: .leading)
                                        Color.clear.frame(maxWidth: .infinity).frame(height: 0)
                                    }
                                    .column(width: wideColumnWidth)
                                } else {
                                    NowHead(shows: shows, now: ServerClock.now)
                                        .column()
                                }
                                Group {
                                    if short {
                                        LowHorizon(palette: p, phase: phase)
                                    } else {
                                        Horizon(road: shows.road, palette: p, phase: phase, scrolled: scrolled)
                                    }
                                }
                                .ignoresSafeArea(edges: .horizontal)
                            }
                        }
                    }
                    .skyInk(light: p.lightInk)
                    .background(alignment: .top) {
                        VStack(spacing: 0) {
                            Rectangle().fill(p.sky[0]).frame(height: 1000)
                            Rectangle().fill(p.gradient)
                        }
                        .padding(.top, -1000)
                        .ignoresSafeArea(edges: .horizontal)
                        .accessibilityHidden(true)
                    }

                    if beside {
                        HStack(alignment: .top, spacing: Self.halvesGap) {
                            VStack(alignment: .leading, spacing: 0) {
                                card
                                goLater
                                if noticesAt == .underCard { notices(under: true) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            VStack(alignment: .leading, spacing: 0) {
                                if let day = app.day { DayTimeline(day: day, top: 0) }
                                footer
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .column(width: wideColumnWidth)
                        .padding(.top, short ? LowHorizon.gap : 0)
                        .padding(.bottom, 24)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            card
                            if noticesAt == .underCard {
                                goLater
                                notices(under: true)
                            }
                            if app.target == .plan, let day = app.day {
                                DayTimeline(day: day)
                            }
                            if noticesAt != .underCard { goLater }
                            footer
                        }
                        .column()
                        .padding(.top, short ? LowHorizon.gap : 0)
                        .padding(.bottom, 24)
                    }
                }
                .onGeometryChange(for: CGFloat.self) {
                    $0.frame(in: .scrollView).minY
                } action: {
                    scrolled = max(0, -$0)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .skyPull(
                pull, livery: Self.road(app).bus.map(\.color),
                scene: { [app, short] w in short ? .hill(w) : .road(w / roadScale, Self.road(app)) }
            ) {
                await app.pull()
            }
            .background(Color.page)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(p.sky[0])
                    .frame(height: outer.safeAreaInsets.top)
                    .offset(y: -outer.safeAreaInsets.top)
                    .opacity(outer.safeAreaInsets.top > 0 ? min(1, scrolled / outer.safeAreaInsets.top) : 0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .task(id: onScreen && scenePhase == .active) {
            guard onScreen && scenePhase == .active else { return }
            await app.poll()
        }
        .onChange(of: Spoken.announcement(app.answer)) { old, said in
            if old != nil { announce(said) }
        }
        .onChange(of: locator.status) { _, _ in
            if onScreen { Task { await app.load(restart: true) } }
        }
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .sheet(
            isPresented: $reporting,
            onDismiss: {
                if addEmail { (addEmail, signingIn) = (false, true) }
            }
        ) { ReportSheet(addEmail: $addEmail) }
        .sheet(isPresented: $signingIn) { SignInSheet().centredSheet() }
        .sheet(isPresented: $goingLater) { GoLaterSheet() }
    }

    private static let halvesGap: CGFloat = 32

    private var card: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            NowGround(shows: NowShows.of(app, now: ServerClock.now), now: ServerClock.now)
        }
    }

    @ViewBuilder private var goLater: some View {
        if app.target != .plan && app.paired {
            Button(L("Go later today at…")) { goingLater = true }
                .buttonStyle(ChipButtonStyle())
                .padding(.top, 14)
                .accessibilityIdentifier("goLater")
        }
    }

    private static func road(_ app: AppModel) -> Road {
        let r = NowShows.of(app, now: ServerClock.now).road
        return r.stop ? r : Road(stop: false, bus: nil, shuttle: r.shuttle)
    }

    private var header: some View {
        HStack {
            NowWordmark()
            Spacer()
        }
        .frame(minHeight: 56)
    }

    private var notices: some View { notices(under: false) }

    @ViewBuilder private func notices(under: Bool) -> some View {
        if app.updateRequired {
            SkyNotice(text: L("Update terminus to keep using it.")) {
                Link(L("Update"), destination: URL(string: Api.site)!)
            }
            .padding(.top, under ? 14 : 0)
            .padding(.bottom, under ? 0 : 12)
        }
        if !locator.allowed {
            SkyNotice(
                text: L(
                    "Directions can start from your nearest stop, using your location. Without it, terminus assumes you're at your last class or at home."
                )
            ) {
                if locator.denied {
                    Button(L("Open settings to allow location")) { openAppSettings() }
                } else {
                    Button(L("Continue")) { locator.ask() }
                }
            }
            .padding(.top, under ? 14 : 0)
            .padding(.bottom, under ? 0 : 12)
        }
    }

    private var chips: some View {
        let searchInRow = typeSize.isAccessibilitySize
        let allFit = width != .narrow && chipsWidth > 0 && chipsWidth <= chipsRoom
        return HStack(spacing: 8) {
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        if short { NowWordmark().padding(.trailing, 8) }
                        NowChip(label: L("Next"), selected: app.target == .plan, id: "chip.next") { app.select(.plan) }
                        ForEach(app.places, id: \.key) { place in
                            NowChip(label: place.label, selected: app.target == .place(key: place.key)) {
                                app.select(.place(key: place.key))
                            }
                        }
                        ForEach(app.added) { a in
                            NowChip(label: a.label, selected: isTarget(a), remove: { app.removeAdded(a) }) {
                                app.select(.code(a.code, label: a.label))
                            }
                            .id(a.code)
                        }
                        if searchInRow { elsewhere }
                    }
                    .onGeometryChange(for: CGFloat.self) {
                        $0.size.width
                    } action: {
                        chipsWidth = $0
                    }
                    .padding(.vertical, 2)
                    .padding(.trailing, allFit ? 0 : FadeEnd.width)
                }
                .onGeometryChange(for: CGFloat.self) {
                    $0.size.width
                } action: {
                    chipsRoom = $0
                }
                .mask {
                    if allFit { Rectangle() } else { FadeEnd() }
                }
                .onChange(of: app.target) { _, t in
                    if case .code(let c, _) = t { withAnimation { reader.scrollTo(c, anchor: .trailing) } }
                }
                .onAppear {
                    if case .code(let c, _) = app.target { reader.scrollTo(c, anchor: .trailing) }
                }
            }
            if !searchInRow { elsewhere }
        }
    }

    private var elsewhere: some View {
        ElsewhereChip(open: searching) { withAnimation(.snappy) { searching.toggle() } }
    }

    private func isTarget(_ a: AppModel.Added) -> Bool {
        if case .code(let c, _) = app.target { return c == a.code }
        return false
    }

    private var footer: some View {
        let parts = [app.error, app.fetchedAt.map { L("Updated %@", campusTime($0.addingTimeInterval(ServerClock.skew))) }].compactMap {
            $0
        }
        return HStack(spacing: 0) {
            if app.loading {
                ProgressView()
                    .controlSize(.mini)
                    .padding(.trailing, 8)
                    .accessibilityLabel(L("Refreshing"))
            }
            Text(parts.joined(separator: " · "))
                .foregroundStyle(app.error != nil ? Color.bad : Color.muted)
                .announced(app.error)
            if app.answer != nil {
                if !parts.isEmpty { Text(verbatim: " · ").foregroundStyle(Color.muted) }
                Button {
                    app.reportOpened()
                    reporting = true
                } label: {
                    Text(L("Is this wrong?"))
                        .underline()
                        .foregroundStyle(Color.muted)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("report")
            }
        }
        .font(.footnote)
        .frame(minHeight: 28)
        .padding(.top, 10)
    }
}

@MainActor func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
}

private struct NowWordmark: View {
    @Environment(\.inks) private var inks
    var body: some View { Wordmark(size: 24, accent: inks.accent).accessibilityAddTraits(.isHeader) }
}

struct NowChip: View {
    let label: String
    let selected: Bool
    var id: String?
    var remove: (() -> Void)?
    let action: () -> Void
    @Environment(\.inks) private var inks

    var body: some View {
        HStack(spacing: 2) {
            Button(action: action) {
                Text(label)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .padding(.leading, 14)
                    .padding(.trailing, remove == nil ? 14 : 2)
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityIdentifier(id ?? "chip.\(label)")
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .frame(width: 30, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L("Remove %@", label))
            }
        }
        .foregroundStyle(selected ? inks.paper : inks.ink)
        .background(selected ? inks.ink : Color.clear, in: Capsule())
        .overlay(Capsule().strokeBorder(selected ? Color.clear : inks.line.opacity(inks.inSky ? 1.6 : 1), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }
}

private struct FadeEnd: View {
    static let width: CGFloat = 44

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: Self.width)
        }
    }
}

struct ElsewhereChip: View {
    let open: Bool
    let action: () -> Void
    @Environment(\.inks) private var inks

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "magnifyingglass").font(.footnote.weight(.semibold))
                Text(L("Elsewhere")).font(.subheadline.weight(.semibold)).lineLimit(1)
            }
            .padding(.leading, 10)
            .padding(.trailing, 14)
            .frame(minHeight: 36)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(inks.ink)
        .overlay(Capsule().strokeBorder(open ? inks.ink : inks.line.opacity(inks.inSky ? 1.6 : 1), lineWidth: 1))
        .accessibilityAddTraits(open ? .isSelected : [])
        .accessibilityIdentifier("search")
    }
}

struct SkyNotice<Actions: View>: View {
    let text: String
    @ViewBuilder var actions: Actions
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text).font(.subheadline)
            actions.font(.subheadline.weight(.semibold)).foregroundStyle(inks.accent)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(inks.pane, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(inks.line))
    }
}

private struct Room: View {
    let height: CGFloat
    let phase: SkyPhase
    let scrolled: CGFloat
    @Environment(\.accessibilityReduceMotion) private var still

    var body: some View {
        PullRoom(base: height)
            .background {
                Canvas { g, size in
                    guard phase == .night else { return }
                    let depth = Parallax(still ? 0 : scrolled)
                    guard depth.fade > 0 else { return }
                    g.translateBy(x: 0, y: depth.sky)
                    SkyDraw.starsAndMoon(&g, width: size.width, room: size.height, alpha: depth.fade, moonRoom: height)
                }
                .accessibilityHidden(true)
            }
    }
}

enum NoticesAt {
    case sky, underCard

    static func of(short: Bool) -> NoticesAt { short ? .underCard : .sky }
}

private struct LowHorizon: View {
    let palette: SkyPalette
    let phase: SkyPhase
    @Environment(\.skyPull) private var pull

    static let height: CGFloat = 52
    static let gap: CGFloat = 8

    var body: some View {
        let m = pull?.picture()
        let pulling = m?.open ?? false
        let paint = pull?.paint
        Canvas { g, size in
            let top = size.height - 58
            SkyDraw.horizon(&g, size: size, top: top, page: .page, p: palette, phase: phase, road: Road(shuttle: false), withSun: false)
            if pulling, let m, let paint {
                PullDraw.hill(&g, m, paint: paint, p: palette, top: top, d: 1, width: size.width, lights: phase.lights)
            }
        }
        .frame(height: Self.height)
        .clipped()
        .accessibilityHidden(true)
    }
}

private struct Horizon: View {
    let road: Road
    let palette: SkyPalette
    let phase: SkyPhase
    let scrolled: CGFloat
    @Environment(\.accessibilityReduceMotion) private var still
    @Environment(\.skyPull) private var pull

    var body: some View {
        let m = pull?.picture()
        let pulling = m?.open ?? false
        let paint = pull?.paint
        Canvas { g, size in
            let shown = pulling ? Road(stop: false, bus: nil, shuttle: false) : road
            SkyDraw.horizon(
                &g, size: size, top: 10, page: .page, p: palette, phase: phase, road: shown, far: Parallax(still ? 0 : scrolled).far,
                scale: roadScale)
            if pulling, let m, let paint {
                PullDraw.road(
                    &g, m, paint: paint, p: palette, top: 10, d: roadScale, sign: roadSign(size.width / roadScale), ownSign: road.stop,
                    live: road.bus?.live != false, lights: phase.lights)
            }
        }
        .frame(height: 10 + horizonHeight)
        .accessibilityHidden(true)
    }
}
