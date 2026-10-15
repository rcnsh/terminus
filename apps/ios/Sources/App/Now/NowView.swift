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
    private var sky = SkyClock.shared
    private var locator = Locator.shared
    @State private var searching = false
    @State private var scrolled: CGFloat = 0
    @State private var onScreen = false
    @State private var reporting = false
    @State private var goingLater = false
    @State private var pull = SkyPull()

    var body: some View {
        let phase = sky.phase
        let p = SkyPalette.of(phase, dark: scheme == .dark)
        GeometryReader { outer in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The sky, from the status bar down to the horizon.
                    VStack(alignment: .leading, spacing: 0) {
                        VStack(alignment: .leading, spacing: 0) {
                            header
                            notices
                            chips
                            if searching {
                                NowSearch { searching = false }
                                    .padding(.top, 12)
                            }
                        }
                        .padding(.horizontal, 16)
                        // Comes down a little with a pull; the room opens under it.
                        .pullLead()
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            let shows = NowShows.of(app, now: ServerClock.now)
                            VStack(alignment: .leading, spacing: 0) {
                                Room(height: shows.room, phase: phase, scrolled: scrolled)
                                NowHead(shows: shows, now: ServerClock.now)
                                    .padding(.horizontal, 16)
                                Horizon(road: shows.road, palette: p, phase: phase, scrolled: scrolled)
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
                        .accessibilityHidden(true)
                    }

                    // The ground.
                    VStack(alignment: .leading, spacing: 0) {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            NowGround(shows: NowShows.of(app, now: ServerClock.now), now: ServerClock.now)
                        }
                        if !app.showNearby && app.target == .plan, let day = app.day {
                            DayTimeline(day: day)
                        }
                        if !app.showNearby && app.target != .plan && app.paired {
                            Button(L("Go later today at…")) { goingLater = true }
                                .buttonStyle(ChipButtonStyle())
                                .padding(.top, 14)
                                .accessibilityIdentifier("goLater")
                        }
                        footer
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .onGeometryChange(for: CGFloat.self) {
                    $0.frame(in: .scrollView).minY
                } action: {
                    scrolled = max(0, -$0)
                }
            }
            .scrollDismissesKeyboard(.interactively)
            // Pulled down at the top, what's shown (the card or Nearby) is asked
            // for again: the sky stretches, and your bus drives to your stop on its horizon.
            .skyPull(pull, livery: Self.road(app).bus.map(\.color), scene: { [app] w in .road(w / roadScale, Self.road(app)) }) {
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
        .onChange(of: app.showNearby ? nil : Spoken.announcement(app.answer)) { old, said in
            if old != nil { announce(said) }
        }
        .onAppear { onScreen = true }
        .onDisappear { onScreen = false }
        .sheet(isPresented: $reporting) { ReportSheet() }
        .sheet(isPresented: $goingLater) { GoLaterSheet() }
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

    /// An update needed, location off: said above the chips, on glass over the sky.
    @ViewBuilder private var notices: some View {
        if app.updateRequired {
            SkyNotice(text: L("Update terminus to keep using it.")) {
                Link(L("Update"), destination: URL(string: Api.site)!)
            }
            .padding(.bottom, 12)
        }
        if !locator.allowed {
            SkyNotice(
                text: L(
                    "Allow location so directions start from your nearest stop. Without it, terminus assumes you're at your last class or at home."
                )
            ) {
                if locator.denied {
                    Button(L("Open settings to allow location")) { openAppSettings() }
                } else {
                    Button(L("Allow location")) { locator.ask() }
                }
            }
            .padding(.bottom, 12)
            .onChange(of: locator.status) { _, _ in Task { await app.load(restart: true) } }
        }
    }

    /// Next and Nearby first, as on the widget, then favourites and the
    /// places added from "Go somewhere else" (each with an ×); the row
    /// scrolls, its end fading while there's more. Then the search.
    private var chips: some View {
        HStack(spacing: 4) {
            ScrollViewReader { reader in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        NowChip(label: L("Next"), selected: !app.showNearby && app.target == .plan, id: "chip.next") { app.select(.plan) }
                        NowChip(label: L("Nearby"), selected: app.showNearby, id: "chip.nearby") { app.selectNearby() }
                        ForEach(app.places, id: \.key) { place in
                            NowChip(label: place.label, selected: !app.showNearby && app.target == .place(key: place.key)) {
                                app.select(.place(key: place.key))
                            }
                        }
                        ForEach(app.added) { a in
                            NowChip(label: a.label, selected: !app.showNearby && isTarget(a), remove: { app.removeAdded(a) }) {
                                app.select(.code(a.code, label: a.label))
                            }
                            .id(a.code)
                        }
                    }
                    .padding(.vertical, 2)
                }
                .mask(FadeEnd())
                .onChange(of: app.target) { _, t in
                    if case .code(let c, _) = t { withAnimation { reader.scrollTo(c, anchor: .trailing) } }
                }
            }
            Button {
                withAnimation(.snappy) { searching.toggle() }
            } label: {
                Image(systemName: searching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 19, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(searching ? L("Close") : L("Go somewhere else"))
            .accessibilityIdentifier("search")
        }
    }

    private func isTarget(_ a: AppModel.Added) -> Bool {
        if case .code(let c, _) = app.target { return c == a.code }
        return false
    }

    // MARK: the foot

    /// One quiet line, as the web shows it: "Updated 9:41 · Is this wrong?".
    private var footer: some View {
        let parts = [app.error, app.fetchedAt.map { L("Updated %@", deviceTime($0)) }].compactMap { $0 }
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
            if !app.showNearby && app.answer != nil {
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

/// A time on the phone's clock, in the account's style: "Updated 9:41".
func deviceTime(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = Lang.locale
    f.setLocalizedDateFormatFromTemplate(Clock.hour12 ? "hmm" : "HHmm")
    return f.string(from: d)
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
    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
            LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 24)
        }
    }
}

/// A notice over the sky, on glass: location off, an update needed.
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
