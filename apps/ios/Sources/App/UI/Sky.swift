import SwiftUI
import UIKit

private struct InksKey: EnvironmentKey { static let defaultValue = Inks.page }

extension EnvironmentValues {
    var inks: Inks {
        get { self[InksKey.self] }
        set { self[InksKey.self] = newValue }
    }
}

extension View {
    func skyInk(light: Bool) -> some View {
        let i = Inks.sky(light: light)
        return environment(\.inks, i).foregroundStyle(i.ink).tint(i.accent)
    }
}

@MainActor @Observable
final class SkyClock {
    static let shared = SkyClock()
    private(set) var phase = SkyPhase.at(Date())
    private var timer: Timer?

    private init() {
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
        static func named(_ s: String) -> SkyPhase? {
            ["night": .night, "dawn": .dawn, "day": .day, "golden": .golden, "dusk": .dusk][s]
        }
    #endif
}

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

    private static var low: CGFloat { 52 }
    private static var moonLine: CGFloat { 24 }
    private static var shortEnd: CGFloat { 12 }
    private static var reach: CGFloat { 600 }

    var body: some View {
        let phase = clock.phase
        let p = SkyPalette.of(phase, dark: scheme == .dark)
        let m = pull?.picture()
        let pulling = m?.open ?? false
        let paint = pull?.paint
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
                if pulling, let m, let paint {
                    PullDraw.hill(&hills, m, paint: paint, p: p, top: end - 58, d: 1, width: size.width, lights: phase.lights)
                }
            }
            .padding(.top, -Self.reach)
            .ignoresSafeArea(edges: .horizontal)
            .accessibilityHidden(true)
        }
    }
}

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

private struct MatchedBand: ViewModifier {
    let bands: PaneBands?
    let id: UUID
    let pulling: Bool
    @State private var rest: CGSize?

    func body(content: Content) -> some View {
        if let bands {
            content
                .onGeometryChange(for: CGSize.self) {
                    let g = $0.frame(in: .global).minY
                    let s = $0.frame(in: .scrollView).minY
                    return CGSize(width: g == s ? g : g - s, height: $0.size.height)
                } action: { v in
                    guard !pulling else { return }
                    rest = v
                    bands.set(id, top: v.width, height: v.height)
                }
                .onAppear { if let rest { bands.set(id, top: rest.width, height: rest.height) } }
                .onDisappear { bands.set(id, height: nil) }
                .frame(minHeight: bands.height(top: bands.top(id)), alignment: .top)
        } else {
            content
        }
    }
}

@MainActor
enum StatusBar {
    static var light: Bool? {
        didSet { if light != oldValue { refresh() } }
    }

    static var inTabs = true {
        didSet { if inTabs != oldValue { refresh() } }
    }

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
    func statusBar(light: Bool?) -> some View {
        onAppear { StatusBar.light = light }
            .onChange(of: light) { _, l in StatusBar.light = l }
    }

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
