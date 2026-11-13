import SwiftUI
import UIKit

/*
 * The sky: behind the top of Now, from the status bar down to a horizon of
 * the campus's hills, in the hour's colours (dawn, day, the golden hour,
 * dusk, night), by the clock; and a slim band of it at the top of Nearby,
 * Stops, Settings and their pages ([SkyBand], a tab's own [TabBand]). Its colours and drawing are in
 * Shared/SkyDraw.swift, for the widgets too; here, what only the app needs.
 */

private struct InksKey: EnvironmentKey { static let defaultValue = Inks.page }

extension EnvironmentValues {
    var inks: Inks {
        get { self[InksKey.self] }
        set { self[InksKey.self] = newValue }
    }
}

extension View {
    /// Words inside in the sky's ink (light or dark), the default colour included.
    func skyInk(light: Bool) -> some View {
        let i = Inks.sky(light: light)
        return environment(\.inks, i).foregroundStyle(i.ink).tint(i.accent)
    }
}

/// The sky's phase, ticking over each minute by the phone's clock.
@MainActor @Observable
final class SkyClock {
    static let shared = SkyClock()
    private(set) var phase = SkyPhase.at(Date())
    private var timer: Timer?

    private init() {
        // On the minute, so the sky changes when the clock does.
        let next =
            Calendar.current.nextDate(after: Date(), matching: DateComponents(second: 0), matchingPolicy: .nextTime)
            ?? Date().addingTimeInterval(60)
        let t = Timer(fire: next, interval: 60, repeats: true) { _ in
            Task { @MainActor in SkyClock.shared.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
        tick()
    }

    func tick() {
        #if DEBUG
            if let p = ProcessInfo.processInfo.environment["TERMINUS_SKY"] {
                phase = Self.named(p) ?? phase
                return
            }
        #endif
        let p = SkyPhase.at(Date())
        if p != phase { phase = p }
    }

    #if DEBUG
        /// TERMINUS_SKY=night|dawn|day|golden|dusk: one hour's sky, for screenshots.
        static func named(_ s: String) -> SkyPhase? {
            ["night": .night, "dawn": .dawn, "day": .day, "golden": .golden, "dusk": .dusk][s]
        }
    #endif
}

// MARK: the band

/// A slim band of the sky at the top of a tab or a page, in the hour's
/// colours: `content` (a title, a stop's name and star) in the sky's ink, with the
/// moon on the right at night, ending on the low horizon (just the hills, no
/// road). It belongs at the top of the page's scroll, under the status bar,
/// and scrolls away with it; give the scroll view `.skyStatusBar()` so the
/// status bar's icons read over it. `moonLow` puts the moon on a line of its
/// own just over the hills, clear of a button at the top right; without
/// `moon`, none. In a short window (a phone on its side) the band ends 12
/// under its words, with no hills and no line for the moon: the moon shows
/// only where it has room beside the words (not `moonLow`), and a pull
/// stretches the sky without drawing its sign and bus.
struct SkyBand<Content: View>: View {
    var moonLow = false
    var moon = true
    @ViewBuilder var content: Content
    @Environment(\.colorScheme) private var scheme
    @Environment(\.skyPull) private var pull
    @Environment(\.listPane) private var listPane
    @Environment(\.paneBands) private var bands
    @Environment(\.windowShort) private var short
    @State private var bandID = UUID()
    private let clock = SkyClock.shared

    init(moonLow: Bool = false, moon: Bool = true, @ViewBuilder content: () -> Content) {
        self.moonLow = moonLow
        self.moon = moon
        self.content = content()
    }

    /// How much of the horizon shows: the city's top to the near hill.
    private static var low: CGFloat { 52 }
    private static var moonLine: CGFloat { 24 }
    /// Short, under the words in place of the hills.
    private static var shortEnd: CGFloat { 12 }
    /// How far the sky reaches up past the band's top: under the status bar, and a pull.
    private static var reach: CGFloat { 600 }

    var body: some View {
        let phase = clock.phase
        let p = SkyPalette.of(phase, dark: scheme == .dark)
        let m = pull?.picture()
        let pulling = m?.open ?? false
        let paint = pull?.paint
        // Side by side, only the trailing pane draws the moon and stars.
        let short = self.short
        let moon = self.moon && !listPane && !(short && moonLow)
        VStack(alignment: .leading, spacing: 0) {
            content.skyInk(light: p.lightInk)
            if short {
                Spacer().frame(height: Self.shortEnd)
            } else {
                if moonLow { Spacer().frame(height: Self.moonLine) }
                Spacer().frame(height: Self.low)
            }
        }
        .modifier(MatchedBand(bands: bands, id: bandID, pulling: pulling))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .top) {
            Canvas { g, size in
                let end = size.height
                g.fill(
                    Path(CGRect(origin: .zero, size: size)),
                    with: .linearGradient(
                        Gradient(stops: [
                            .init(color: p.sky[0], location: 0), .init(color: p.sky[1], location: 0.5),
                            .init(color: p.sky[2], location: 0.86), .init(color: p.sky[3], location: 1),
                        ]), startPoint: .zero, endPoint: CGPoint(x: 0, y: end)))
                if phase == .night && moon {
                    // Beside the words: from the band's own top, `reach` down the canvas, to the ground.
                    let ground = short ? end - Self.shortEnd : end - Self.low
                    let row: ClosedRange<CGFloat> = moonLow ? (end - Self.low - Self.moonLine)...(end - Self.low) : Self.reach...ground
                    let pts: [(CGFloat, CGFloat, Double)] =
                        moonLow
                        ? [(0.69, 0.3, 0.6), (0.74, 0.75, 0.45), (0.79, 0.2, 0.7), (0.83, 0.65, 0.4), (0.98, 0.55, 0.45)]
                        : [
                            (0.56, 0.2, 0.6), (0.63, 0.7, 0.45), (0.7, 0.35, 0.7), (0.78, 0.8, 0.4), (0.66, 0.05, 0.5),
                            (0.95, 0.85, 0.45),
                        ]
                    for (x, y, a) in pts {
                        let c = CGPoint(x: size.width * x, y: row.lowerBound + (row.upperBound - row.lowerBound) * y)
                        g.fill(
                            Path(ellipseIn: CGRect(x: c.x - 1.1, y: c.y - 1.1, width: 2.2, height: 2.2)),
                            with: .color(.white.opacity(a)))
                    }
                    SkyDraw.crescent(&g, centre: CGPoint(x: size.width - 22 - 11, y: (row.lowerBound + row.upperBound) / 2), r: 12)
                }
                if short { return }
                var hills = g
                hills.clip(to: Path(CGRect(x: 0, y: end - Self.low, width: size.width, height: Self.low)))
                SkyDraw.horizon(
                    &hills, size: size, top: end - 58, page: .page, p: p, phase: phase, road: Road(shuttle: false), withSun: false)
                // Pulled down: a sign grows out of the near hill and a bus drives to it.
                if pulling, let m, let paint {
                    PullDraw.hill(&hills, m, paint: paint, p: p, top: end - 58, d: 1, width: size.width, lights: phase.lights)
                }
            }
            // Up under the status bar, and on up past the top for a pull; out to
            // the screen's edges on a phone on its side.
            .padding(.top, -Self.reach)
            .ignoresSafeArea(edges: .horizontal)
            .accessibilityHidden(true)
        }
    }
}

/// The top of a tab (Nearby, Stops, Settings) and of the first page in a
/// wide detail pane: the tab's name, large, in a band of the sky, the moon
/// beside it at night, ending on the hills. One height on every tab, so
/// moving between them the title stays put. On a tab with a pull, the room
/// for the pull's pill opens above the name.
struct TabBand: View {
    let title: String

    var body: some View {
        SkyBand {
            VStack(alignment: .leading, spacing: 0) {
                PullRoom(below: 10)
                Text(title)
                    .font(.title.weight(.heavy))
                    .accessibilityAddTraits(.isHeader)
                    .padding(.top, 10)
            }
            .column()
        }
    }
}

/// Side by side, a band drawn on down to where the lowest of the panes'
/// bands ends, its words at the top, so the horizons meet. Its own height
/// counts, not one stretched by a pull, and where its top rests unscrolled.
private struct MatchedBand: ViewModifier {
    let bands: PaneBands?
    let id: UUID
    let pulling: Bool
    /// Its last top and height at rest: counted again when a page over it goes.
    @State private var rest: CGSize?

    func body(content: Content) -> some View {
        if let bands {
            content
                .onGeometryChange(for: CGSize.self) {
                    // Where its top rests: in a scroll view, less how far it has scrolled.
                    let g = $0.frame(in: .global).minY
                    let s = $0.frame(in: .scrollView).minY
                    return CGSize(width: g == s ? g : g - s, height: $0.size.height)
                } action: { v in
                    guard !pulling else { return }
                    rest = v
                    bands.set(id, top: v.width, height: v.height)
                }
                // Back from a page over it its frame hasn't changed, so nothing above reports it.
                .onAppear { if let rest { bands.set(id, top: rest.width, height: rest.height) } }
                .onDisappear { bands.set(id, height: nil) }
                .frame(minHeight: bands.height(top: bands.top(id)), alignment: .top)
        } else {
            content
        }
    }
}

// MARK: the status bar

/// The status bar's icons, light over a dark sky, else the page's: set by
/// whichever screen is showing (Now, a band) through [StatusBar.light].
@MainActor
enum StatusBar {
    /// Light icons, or nil for the theme's own.
    static var light: Bool? {
        didSet { if light != oldValue { refresh() } }
    }

    /// Whether the tabs show. Outside them (welcome, setup) the theme's icons,
    /// whatever a tab's page asked for as it went: signing out, a tab's last
    /// change can come after the welcome screen has appeared.
    static var inTabs = true {
        didSet { if inTabs != oldValue { refresh() } }
    }

    /// Whether the status bar sits beside the page rather than above it (an
    /// iPhone Duo, where it shares a strip with the tab bar). The strip is
    /// the page's colour, not the sky's, so the theme's icons are the ones that read.
    static var beside = false {
        didSet { if beside != oldValue { refresh() } }
    }

    private static func refresh() {
        install()
        for scene in UIApplication.shared.connectedScenes {
            (scene as? UIWindowScene)?.windows.forEach { $0.rootViewController?.setNeedsStatusBarAppearanceUpdate() }
        }
    }

    private static var installed: Set<ObjectIdentifier> = []

    /// SwiftUI's own hosting controller decides the status bar's style from
    /// the whole app's colour scheme. Its class is given a
    /// preferredStatusBarStyle that asks here first, once.
    private static func install() {
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] {
                guard let root = window.rootViewController else { continue }
                let cls: AnyClass = type(of: root)
                guard !installed.contains(ObjectIdentifier(cls)) else { continue }
                installed.insert(ObjectIdentifier(cls))
                let sel = #selector(getter: UIViewController.preferredStatusBarStyle)
                guard let original = class_getInstanceMethod(cls, sel) else { continue }
                typealias Getter = @convention(c) (AnyObject, Selector) -> UIStatusBarStyle
                let fallback = unsafeBitCast(method_getImplementation(original), to: Getter.self)
                let block: @convention(block) (AnyObject) -> UIStatusBarStyle = { me in
                    MainActor.assumeIsolated {
                        switch StatusBar.inTabs && !StatusBar.beside ? StatusBar.light : nil {
                        case true?: .lightContent
                        case false?: .darkContent
                        case nil: fallback(me, sel)
                        }
                    }
                }
                class_replaceMethod(cls, sel, imp_implementationWithBlock(block), method_getTypeEncoding(original))
            }
        }
    }
}

extension View {
    /// While this shows, the status bar's icons are light (`light`) or the theme's (nil).
    func statusBar(light: Bool?) -> some View {
        onAppear { StatusBar.light = light }
            .onChange(of: light) { _, l in StatusBar.light = l }
    }

    /// The status bar's icons for a page whose top is a [SkyBand]: light over a dark sky.
    func skyStatusBar() -> some View { modifier(SkyStatusBar()) }
}

private struct SkyStatusBar: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    private let clock = SkyClock.shared
    func body(content: Content) -> some View {
        let light = SkyPalette.of(clock.phase, dark: scheme == .dark).lightInk
        content.statusBar(light: light ? true : (scheme == .dark ? true : false))
    }
}
