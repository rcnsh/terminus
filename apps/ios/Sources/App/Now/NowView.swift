import SwiftUI
import UIKit

/// Now: the bus to catch (or the walk), worded by the server, under the
/// hour's sky. The header, the chips and the top of the card are up in the
/// sky; the horizon under them has your bus on its way to your stop; the
/// rest of the card, Today and the footer are on the ground. As Android's
/// MainScreen and the web app's Now.
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
    /// "Add your email" from the report: the sign-in, over Now, as the report closes.
    @State private var addEmail = false
    @State private var signingIn = false
    @State private var goingLater = false
    @State private var pull = SkyPull()
    /// The chips' own width, and the row's room for them: from 600 wide, all
    /// of them fitting, the row neither fades nor leaves room for the fade.
    @State private var chipsWidth: CGFloat = 0
    @State private var chipsRoom: CGFloat = 0

    /// Wide, with a day to show: the card's steps in the left half, Today in the right.
    private var beside: Bool { width.panes && hasDay }

    /// Today has something in it: an entry, or one just removed with its Undo.
    private var hasDay: Bool { (app.day.map { !$0.items.isEmpty } ?? false) || app.removed != nil }

    /// The sky's words: the wide column beside Today; else, the card alone, the page's.
    private var skyWidth: CGFloat { beside ? wideColumnWidth : columnWidth }

    /// Where the notices go: short, under the card, so the answer comes first.
    private var noticesAt: NoticesAt { NoticesAt.of(short: short) }

    var body: some View {
        let phase = sky.phase
        let p = SkyPalette.of(phase, dark: scheme == .dark)
        GeometryReader { outer in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The sky, from the status bar down to the horizon.
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            if short {
                                // The wordmark leads the chips' row instead (`chips`).
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
                        // Comes down a little with a pull; the room opens under it.
                        .pullLead()
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            let shows = NowShows.of(app, now: ServerClock.now)
                            VStack(alignment: .leading, spacing: 0) {
                                Room(height: shows.room, phase: phase, scrolled: scrolled)
                                if beside {
                                    // The head tops the card's half, as wide as the half under it.
                                    HStack(alignment: .top, spacing: Self.halvesGap) {
                                        NowHead(shows: shows, now: ServerClock.now).frame(maxWidth: .infinity, alignment: .leading)
                                        Color.clear.frame(maxWidth: .infinity).frame(height: 0)
                                    }
                                    .column(width: wideColumnWidth)
                                } else {
                                    NowHead(shows: shows, now: ServerClock.now)
                                        .column()
                                }
                                // Out to the screen's edges, past the notch and the home bar on a phone on its side.
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
                        // On up past the top, for a pull and the status bar.
                        VStack(spacing: 0) {
                            Rectangle().fill(p.sky[0]).frame(height: 1000)
                            Rectangle().fill(p.gradient)
                        }
                        .padding(.top, -1000)
                        .ignoresSafeArea(edges: .horizontal)
                        .accessibilityHidden(true)
                    }

                    // The ground.
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
                        // Clear of the low horizon's near hill, which ends where the ground starts.
                        .padding(.top, short ? LowHorizon.gap : 0)
                        .padding(.bottom, 24)
                    } else {
                        VStack(alignment: .leading, spacing: 0) {
                            card
                            // Short: Go later, then the notices, straight under the card, as in two panes and on Android.
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
                        // Clear of the low horizon's near hill, which ends where the ground starts.
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
            // Pulled down at the top, the card is asked
            // for again: the sky stretches, and your bus drives to your stop on its horizon.
            // Short, the horizon is the bands' hills, and the pull's sign grows out of them as on a band.
            .skyPull(
                pull, livery: Self.road(app).bus.map(\.color),
                scene: { [app, short] w in short ? .hill(w) : .road(w / roadScale, Self.road(app)) }
            ) {
                await app.pull()
            }
            .background(Color.page)
            // The status bar's own strip: clear at the top, so the sky shows
            // through, then filled with the sky's top as the page goes under it.
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
            // Fresh while it's on screen and the app's in front: every 30 s.
            guard onScreen && scenePhase == .active else { return }
            await app.poll()
        }
        // Said when the card changes (a new bus, the trip's next phase), and
        // only then: nothing in it ticks.
        .onChange(of: Spoken.announcement(app.answer)) { old, said in
            if old != nil { announce(said) }
        }
        // On the view itself, not the location notice: allowing location
        // removes the notice in the same update, and its onChange with it.
        // Only while Now is on screen: answered on another tab (Nearby asks as
        // it opens), the card is asked for when Now next shows, as it always is.
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

    /// Between the card's half and Today's.
    private static let halvesGap: CGFloat = 32

    /// The card's steps and buttons, under the horizon.
    private var card: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            NowGround(shows: NowShows.of(app, now: ServerClock.now), now: ServerClock.now)
        }
    }

    /// A favourite or a place chosen: going there later instead of now.
    @ViewBuilder private var goLater: some View {
        if app.target != .plan && app.paired {
            Button(L("Go later today at…")) { goingLater = true }
                .buttonStyle(ChipButtonStyle())
                .padding(.top, 14)
                .accessibilityIdentifier("goLater")
        }
    }

    /// The horizon's road now, with your bus on it only when it stops for you.
    private static func road(_ app: AppModel) -> Road {
        let r = NowShows.of(app, now: ServerClock.now).road
        return r.stop ? r : Road(stop: false, bus: nil, shuttle: r.shuttle)
    }

    // MARK: the top

    private var header: some View {
        HStack {
            NowWordmark()
            Spacer()
        }
        .frame(minHeight: 56)
    }

    /// An update needed, location off: said above the chips, on glass over
    /// the sky; or, `under` the card's buttons on the ground, in the page's colours.
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
                    // Neutral, as in setup: the system's question is the one that asks.
                    Button(L("Continue")) { locator.ask() }
                }
            }
            .padding(.top, under ? 14 : 0)
            .padding(.bottom, under ? 0 : 12)
        }
    }

    /// Next first, then favourites and the
    /// places added from "Go somewhere else" (each with an ×); the row
    /// scrolls, its end fading while there's more. Then the search: kept in
    /// view after the row, or at the largest text sizes, where the two
    /// wouldn't both fit, the row's last chip.
    private var chips: some View {
        let searchInRow = typeSize.isAccessibilitySize
        // A phone keeps its fade and the room after the last chip whatever fits.
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
                    // Scrolled to the end, the last chip clears the fade.
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
                // Chosen here, or on the map or Buses (Go there) while Now was away: in view either way.
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

    /// Worded, not a bare magnifier, so it reads as one more place to go,
    /// as on the web and Android. The search opens under the chips.
    private var elsewhere: some View {
        ElsewhereChip(open: searching) { withAnimation(.snappy) { searching.toggle() } }
    }

    private func isTarget(_ a: AppModel.Added) -> Bool {
        if case .code(let c, _) = app.target { return c == a.code }
        return false
    }

    // MARK: the foot

    /// One quiet line, as the web shows it: "Updated 9:41 · Is this wrong?".
    /// In campus time on the server's clock, as the card's own times and the
    /// web's and Android's footers are, so it never sits hours from "Arrive".
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

/// The phone's settings page for this app, where a refused permission can be allowed.
@MainActor func openAppSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
}

/// The wordmark in the sky's ink, the accent the sky's.
private struct NowWordmark: View {
    @Environment(\.inks) private var inks
    var body: some View { Wordmark(size: 24, accent: inks.accent).accessibilityAddTraits(.isHeader) }
}

/// A chip on Now: filled in the ink when it's the one showing, so it stands
/// out over any sky; an added place has an × that removes it.
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
            // On the button VoiceOver reads, not the chip around it.
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

/// The chips' row fades out at its end while there's more to scroll to.
private struct FadeEnd: View {
    /// Wide enough that a chip cut off at the end reads as going on, not as clipped.
    static let width: CGFloat = 44

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: Self.width)
        }
    }
}

/// A notice over the sky, on glass: location off, an update needed.
/// "Elsewhere", after the chips: opens "Go somewhere else" under them.
/// Outlined like a chip not chosen, its outline darker while the search is open.
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

/// The room above the card's words: the stars and the moon at night,
/// lagging as the page scrolls and fading out; nothing by day. Pulled down,
/// it grows (`PullRoom`) and the stars spread over it; the moon keeps its size.
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

/// Where Now's notices (location off, an update needed) go: over the chips
/// in the sky, or in a short window under the card's buttons, so the answer
/// comes first.
enum NoticesAt {
    case sky, underCard

    static func of(short: Bool) -> NoticesAt { short ? .underCard : .sky }
}

/// Where the sky ends in a short window: the bands' low horizon, just the
/// hills, with no road, bus, sign or town (the card says in words where the
/// bus is). Pulled down, the pull's sign grows out of the near hill and a
/// bus drives to it, as on a band.
private struct LowHorizon: View {
    let palette: SkyPalette
    let phase: SkyPhase
    @Environment(\.skyPull) private var pull

    /// As tall as a band's hills.
    static let height: CGFloat = 52
    /// Between the near hill and the card's first line.
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

/// Where the sky ends: the hills, the city, the road, and on it your stop's
/// sign with your bus coming up to it, or a shuttle going by.
private struct Horizon: View {
    let road: Road
    let palette: SkyPalette
    let phase: SkyPhase
    let scrolled: CGFloat
    @Environment(\.accessibilityReduceMotion) private var still
    @Environment(\.skyPull) private var pull

    var body: some View {
        // Pulled down, the pull's sign and bus are on the road instead of the card's.
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
