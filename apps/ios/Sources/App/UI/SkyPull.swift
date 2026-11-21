import SwiftUI
import UIKit

private let lit = Color(rgb: 0xFB923C)
private let goodGreen = Color(rgb: 0x22C55E)

@MainActor @Observable
final class SkyPull {
    @ObservationIgnored let motion = PullMotion(scene: .hill(1))
    private var frame = 0
    private(set) var hint: PullHint?

    @ObservationIgnored var refresh: @MainActor () async -> PullOutcome = { .failed }
    @ObservationIgnored var scene: @MainActor (CGFloat) -> PullScene = { .hill($0) }
    @ObservationIgnored var livery: UInt32?
    @ObservationIgnored var enabled = true
    @ObservationIgnored var width: CGFloat = 393
    @ObservationIgnored private lazy var ticker = FrameTicker { [weak self] dt in self?.step(dt) ?? false }

    func read() -> PullMotion {
        _ = frame
        return motion
    }

    func picture() -> PullFrame { read().frame }

    func kick() {
        motion.scene = scene(width)
        frame &+= 1
        let h = motion.hint
        if h != hint { hint = h }
        if motion.moving { ticker.start() }
    }

    func released() {
        if motion.release() {
            Task {
                let o = await refresh()
                motion.done(o)
                kick()
            }
        }
        kick()
    }

    private func step(_ dt: CGFloat) -> Bool {
        motion.step(dt)
        kick()
        return motion.moving
    }

    var paint: (Color, Color) {
        guard let livery else { return (shuttlePaint, shuttleBand) }
        return (Color(rgb: livery), .white.opacity(0.85))
    }
}

@MainActor
private final class FrameTicker: NSObject {
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0
    private let tick: @MainActor (CGFloat) -> Bool

    init(_ tick: @escaping @MainActor (CGFloat) -> Bool) { self.tick = tick }

    func start() {
        guard link == nil else { return }
        last = 0
        let l = CADisplayLink(target: self, selector: #selector(frame(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func frame(_ l: CADisplayLink) {
        let dt = last == 0 ? 1.0 / 60 : l.timestamp - last
        last = l.timestamp
        if !tick(CGFloat(dt)) {
            l.invalidate()
            link = nil
        }
    }
}

private struct SkyPullKey: EnvironmentKey { static let defaultValue: SkyPull? = nil }

extension EnvironmentValues {
    var skyPull: SkyPull? {
        get { self[SkyPullKey.self] }
        set { self[SkyPullKey.self] = newValue }
    }
}

extension View {
    func skyPull(
        _ pull: SkyPull, enabled: Bool = true, livery: UInt32? = nil, scene: @escaping @MainActor (CGFloat) -> PullScene,
        refresh: @escaping @MainActor () async -> PullOutcome
    ) -> some View {
        modifier(SkyPullModifier(pull: pull, enabled: enabled, livery: livery, scene: scene, refresh: refresh))
    }

    func pullLead() -> some View { modifier(PullLead()) }
}

private struct SkyPullModifier: ViewModifier {
    let pull: SkyPull
    let enabled: Bool
    let livery: UInt32?
    let scene: @MainActor (CGFloat) -> PullScene
    let refresh: @MainActor () async -> PullOutcome
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilityReduceMotion) private var still

    func body(content: Content) -> some View {
        pull.refresh = refresh
        pull.scene = scene
        pull.livery = livery
        pull.enabled = enabled
        pull.motion.calm = still
        return Group {
            if voiceOver {
                content.refreshable {
                    guard enabled else { return }
                    announce(await refresh().words)
                }
            } else {
                content.environment(\.skyPull, pull)
            }
        }
    }
}

private struct PullLead: ViewModifier {
    @Environment(\.skyPull) private var pull
    func body(content: Content) -> some View {
        content.offset(y: pull?.read().lead ?? 0)
    }
}

struct PullRoom: View {
    var base: CGFloat = 0
    var above: CGFloat = 0
    var below: CGFloat = 0
    @Environment(\.skyPull) private var pull

    var body: some View {
        if let pull {
            let m = pull.read()
            Color.clear
                .frame(maxWidth: .infinity)
                .frame(height: base + m.pull)
                .overlay(alignment: .top) {
                    if let hint = pull.hint {
                        let centre = Pull.pillCentre(above: above, room: base + m.pull + below, pull: m.pull)
                        let show = m.hintAlpha
                        PullPill(hint: hint, calm: m.calm)
                            .opacity(show)
                            .scaleEffect(0.92 + 0.08 * show)
                            .frame(height: 0)
                            .offset(y: centre)
                    }
                }
                .background(PullHook(pull: pull).accessibilityHidden(true))
        } else if base > 0 {
            Color.clear.frame(height: base)
        }
    }
}

private struct PullPill: View {
    let hint: PullHint
    let calm: Bool
    @Environment(\.inks) private var inks

    var body: some View {
        HStack(spacing: 6) {
            switch hint {
            case .pull, .letGo:
                Image(systemName: "arrow.down")
                    .font(.system(size: 11, weight: .bold))
                    .rotationEffect(.degrees(hint == .letGo ? 180 : 0))
                    .animation(calm ? nil : .easeOut(duration: 0.2), value: hint)
            case .checking:
                if !calm { ProgressView().controlSize(.mini).tint(inks.ink) }
            case .done(let o):
                Circle().fill(o.good ? inks.good : inks.warn).frame(width: 7, height: 7)
            }
            Text(hint.words)
                .font(.footnote.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(inks.ink)
        .padding(.leading, 10)
        .padding(.trailing, 13)
        .padding(.vertical, 5)
        .background(inks.chip ?? Color.surface2, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("pull.pill")
    }
}

private struct PullHook: UIViewRepresentable {
    let pull: SkyPull

    func makeUIView(context: Context) -> PullHookView {
        let v = PullHookView()
        v.isUserInteractionEnabled = false
        v.pull = pull
        return v
    }

    func updateUIView(_ v: PullHookView, context: Context) { v.pull = pull }

    static func dismantleUIView(_ v: PullHookView, coordinator: ()) { v.detach() }
}

private final class PullHookView: UIView {
    weak var pull: SkyPull?
    private weak var scroll: UIScrollView?
    private var watch: NSKeyValueObservation?
    private var lastT: CGFloat = 0
    private var holdTop = false
    private var pinning = false
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    override func didMoveToWindow() {
        super.didMoveToWindow()
        detach()
        guard window != nil else { return }
        var v = superview
        while let s = v, !(s is UIScrollView) { v = s.superview }
        guard let sv = v as? UIScrollView else { return }
        scroll = sv
        sv.panGestureRecognizer.addTarget(self, action: #selector(panned(_:)))
        watch = sv.observe(\.contentOffset) { [weak self] sv, _ in
            MainActor.assumeIsolated { self?.offsetChanged(sv) }
        }
    }

    func detach() {
        scroll?.panGestureRecognizer.removeTarget(self, action: #selector(panned(_:)))
        watch?.invalidate()
        watch = nil
        scroll = nil
    }

    private func over(_ sv: UIScrollView) -> CGFloat { -sv.adjustedContentInset.top - sv.contentOffset.y }

    private func pin(_ sv: UIScrollView) {
        pinning = true
        sv.contentOffset.y = -sv.adjustedContentInset.top
        pinning = false
    }

    private func offsetChanged(_ sv: UIScrollView) {
        guard !pinning, holdTop, !sv.isTracking, over(sv) > 0 else { return }
        pin(sv)
    }

    @objc private func panned(_ r: UIPanGestureRecognizer) {
        guard let pull, let sv = scroll else { return }
        let m = pull.motion
        switch r.state {
        case .began:
            holdTop = false
            pull.width = sv.bounds.width
            lastT = r.translation(in: sv).y
            m.touch()
            if over(sv) < -0.5 { m.contentScrolled() }
            haptic.prepare()
        case .changed:
            let t = r.translation(in: sv).y
            let dy = t - lastT
            lastT = t
            guard pull.enabled else { return }
            let o = over(sv)
            var armed = false
            if m.phase == .drag {
                if dy >= 0 { armed = m.drag(dy) } else { _ = m.takeBack(dy) }
                if m.phase == .drag { pin(sv) }
            } else if o > 0.5 {
                armed = m.drag(o)
                if m.phase == .drag { pin(sv) }
            } else if o < -0.5 {
                m.contentScrolled()
            }
            if armed { haptic.impactOccurred() }
            if m.open { pull.kick() }
        case .ended, .cancelled, .failed:
            if m.phase == .drag {
                holdTop = true
                pin(sv)
            }
            pull.released()
        default:
            break
        }
    }
}

enum PullDraw {
    static func road(
        _ g: inout GraphicsContext, _ m: PullFrame, paint: (Color, Color), p: SkyPalette, top: CGFloat, d: CGFloat, sign: CGFloat,
        ownSign: Bool, live: Bool, lights: Bool
    ) {
        stopSign(&g, m, p: p, foot: CGPoint(x: sign * d, y: top + 70 * d), u: d, post: 26, grow: ownSign ? 1 : m.signGrow, rise: false)
        bus(&g, m, paint: paint, p: p, top: top, d: d, ground: { _ in 70 }, slope: false, band: live, lights: lights)
    }

    static func hill(
        _ g: inout GraphicsContext, _ m: PullFrame, paint: (Color, Color), p: SkyPalette, top: CGFloat, d: CGFloat, width: CGFloat,
        lights: Bool
    ) {
        let ground = { (x: CGFloat) in nearY(x) + 0.6 }
        let sx = Pull.hillSign(width)
        stopSign(&g, m, p: p, foot: CGPoint(x: sx * d, y: top + ground(sx) * d), u: d, post: 22, grow: m.signGrow, rise: true)
        bus(&g, m, paint: paint, p: p, top: top, d: d, ground: ground, slope: true, band: true, lights: lights)
    }

    private static func stopSign(
        _ g: inout GraphicsContext, _ m: PullFrame, p: SkyPalette, foot o: CGPoint, u: CGFloat, post: CGFloat, grow: CGFloat, rise: Bool
    ) {
        guard grow > 0 else { return }
        var c = g
        c.opacity = rise ? 1 : grow
        c.translateBy(x: o.x, y: o.y)
        if rise { c.scaleBy(x: 1, y: grow) }
        func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * u, y: y * u) }
        func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: Color, _ r: CGFloat) {
            c.fill(
                Path(roundedRect: CGRect(origin: at(x, y), size: CGSize(width: w * u, height: h * u)), cornerRadius: r * u),
                with: .color(color))
        }
        let plate = -(post + 11)
        let plain = !m.good && !m.lit
        let face = m.good ? goodGreen : m.lit ? lit : p.post
        let mark = plain ? p.postInk : Color(rgb: 0x1C1917)
        if m.lit && !m.calm {
            let k = m.clock.truncatingRemainder(dividingBy: 1.1) / 1.1
            let r = (7 + 9 * k) * u
            let ctr = at(0, plate + 6.5)
            var ring = c
            ring.opacity *= 0.8 * (1 - k)
            ring.stroke(
                Path(ellipseIn: CGRect(x: ctr.x - r, y: ctr.y - r, width: 2 * r, height: 2 * r)), with: .color(lit), lineWidth: 1.2 * u)
        }
        var stick = Path()
        stick.move(to: at(0, 0))
        stick.addLine(to: at(0, -post))
        c.stroke(stick, with: .color(p.post), lineWidth: 1.6 * u)
        box(-6.5, plate, 13, 13, face, 2.5)
        box(-3.5, plate + 2.5, 7, 7.5, mark, 1.5)
        box(-2.5, plate + 3.5, 5, 3, face, 0.5)
    }

    private static func bus(
        _ g: inout GraphicsContext, _ m: PullFrame, paint livery: (Color, Color), p: SkyPalette, top: CGFloat, d: CGFloat,
        ground: (CGFloat) -> CGFloat, slope: Bool, band: Bool, lights: Bool
    ) {
        for f in m.puffs {
            let k = f.age / 0.6
            let r = (1.4 + k * 3.6) * d
            let ctr = CGPoint(x: (f.x - k * 10) * d, y: top + (ground(f.x) - 4.2 - k * 5) * d)
            g.fill(
                Path(ellipseIn: CGRect(x: ctr.x - r, y: ctr.y - r, width: 2 * r, height: 2 * r)),
                with: .color(.white.opacity(0.55 * (1 - k))))
        }
        guard m.alpha > 0 else { return }
        let x = m.busX
        let o = CGPoint(x: x * d, y: top + (ground(x + 19) - 13) * d)
        func at(_ bx: CGFloat, _ by: CGFloat) -> CGPoint { CGPoint(x: o.x + bx * d, y: o.y + by * d) }
        func turn(_ c: inout GraphicsContext, _ angle: Angle, about pivot: CGPoint) {
            c.translateBy(x: pivot.x, y: pivot.y)
            c.rotate(by: angle)
            c.translateBy(x: -pivot.x, y: -pivot.y)
        }
        var c = g
        c.opacity = m.alpha
        c.drawLayer { c in
            if slope { turn(&c, .radians(atan2(ground(x + 30) - ground(x + 8), 22)), about: at(19, 13)) }
            var body = c
            body.translateBy(x: 0, y: m.bob * d)
            turn(&body, .degrees(m.tilt), about: at(7.5, 12))
            if lights && m.driving {
                var beam = Path()
                beam.move(to: at(38, 9))
                beam.addLine(to: at(60, 6))
                beam.addLine(to: at(60, 13))
                beam.closeSubpath()
                body.fill(beam, with: .color(moonColour.opacity(0.14)))
            }
            let (paint, stripe) = livery
            SkyDraw.shuttle(&body, origin: o, d: d, paint: paint, band: band ? stripe : nil, glass: p.window, dim: 3, wheels: false)
            if m.door > 0 {
                body.fill(
                    Path(roundedRect: CGRect(origin: at(32, 2.5), size: CGSize(width: 2.8 * d, height: 8.2 * d)), cornerRadius: 0.6 * d),
                    with: .color(Color(rgb: 0xFBBF24).opacity(m.door)))
            }
            for wx in SkyDraw.shuttleWheels { SkyDraw.shuttleWheel(&c, centre: at(wx, 12), d: d, turn: m.wheel) }
            if m.honk > 0 {
                let s = m.honk * 0.8
                var arcs = Path()
                arcs.move(to: at(40.2 + s, 3.2))
                arcs.addQuadCurve(to: at(40.2 + s, 8), control: at(41.7 + s, 5.6))
                arcs.move(to: at(42.4 + s, 1.6))
                arcs.addQuadCurve(to: at(42.4 + s, 9.6), control: at(45.2 + s, 5.6))
                let ink = p.lightInk ? Color(rgb: 0xF5F3F0) : Color(rgb: 0x1C1917)
                c.stroke(arcs, with: .color(ink.opacity(min(max(m.honk, 0), 1))), style: StrokeStyle(lineWidth: 0.75 * d, lineCap: .round))
            }
        }
    }
}
