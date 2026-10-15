import SwiftUI

/*
 * The sky's colours and drawing: Now's sky and horizon, the band over a
 * page, and the widgets' top. Pure drawing in a GraphicsContext, shared by
 * the app and its extensions. The web (sky.js, daylight.js) and Android
 * (NightSky.kt) draw the same scene from the same numbers.
 */

/// The sky's looks, in the order of the day.
enum SkyPhase: Sendable {
    case night, dawn, day, golden, dusk

    /// The sky at `min` minutes past midnight: dawn from 6:30, day from 8:30,
    /// the golden hour from 4:30 PM, dusk from 6:45 PM and night from 7:40 PM.
    static func at(minute min: Int) -> SkyPhase {
        if min < 390 || min >= 1180 { return .night }
        if min < 510 { return .dawn }
        if min < 990 { return .day }
        if min < 1125 { return .golden }
        return .dusk
    }

    /// By the phone's clock.
    static func at(_ date: Date) -> SkyPhase {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return at(minute: (c.hour ?? 0) * 60 + (c.minute ?? 0))
    }

    var lights: Bool { self == .dusk || self == .night }
}

/// How far each layer lags as the page scrolls down by `s` points: the moon
/// and the stars at half speed, fading out by 160; the far hills, the city
/// and a low sun sinking behind the near hill, by 18 at most.
struct Parallax {
    var sky: CGFloat, far: CGFloat, fade: CGFloat
    init(_ s: CGFloat) {
        let y = max(0, s)
        sky = y * 0.5
        far = min(y * 0.12, 18)
        fade = max(0, 1 - y / 160)
    }
}

/// Your bus on the horizon's road: its colour, how far off it is (0 at the
/// stop, 1 a quarter of an hour away), and whether that's live. A timetable
/// guess is drawn as an outline.
struct RoadBus: Equatable {
    var color: UInt32
    var far: CGFloat
    var live: Bool
}

/// What's on the horizon's road: your stop's sign and your bus, or a shuttle going by.
struct Road: Equatable {
    var stop = false
    var bus: RoadBus?
    var shuttle = true

    /// Your bus coming up to your stop's sign, nearer the sooner it's due. On foot, an empty road.
    static func of(_ j: Journey, now: Date) -> Road {
        guard let b = j.bus else { return Road(shuttle: false) }
        let due = max(0, j.boardDate?.timeIntervalSince(now) ?? 0)
        return Road(stop: true, bus: RoadBus(color: hexRGB(b.color ?? "") ?? 0x8A847E, far: due / 900, live: j.live), shuttle: false)
    }
}

/// An hour's colours, in the page's theme.
struct SkyPalette {
    let sky: [Color]
    let far: Color, tree: Color, city: Color
    /// The words over it are light.
    let lightInk: Bool
    let sun: Color?
    let road: Color, post: Color, postInk: Color, window: Color

    static func of(_ phase: SkyPhase, dark: Bool) -> SkyPalette {
        func c(_ v: UInt32) -> Color { Color(rgb: v) }
        let road = c(dark ? 0x2C2926 : 0xD6CFC7)
        let post = c(dark ? 0xD6D3D1 : 0x1C1917)
        let postInk = c(dark ? 0x0F0E0D : 0xFAFAF9)
        let lit = c(0xFDE9C9)
        let day = c(dark ? 0xB9C7D6 : 0xDBEAFE)
        func make(_ sky: [UInt32], _ far: UInt32, _ tree: UInt32, _ city: UInt32, _ light: Bool, _ sun: UInt32? = nil, _ window: Color)
            -> SkyPalette
        {
            SkyPalette(
                sky: sky.map(c), far: c(far), tree: c(tree), city: c(city), lightInk: light, sun: sun.map(c), road: road, post: post,
                postInk: postInk, window: window)
        }
        if dark {
            switch phase {
            case .dawn: return make([0x1D3550, 0x2A465F, 0x5C4D58, 0x8A6656], 0x2A3446, 0x151C24, 0x3D4658, true, 0xF3DCC0, day)
            case .day: return make([0x173350, 0x1F4262, 0x2D5674, 0x3F6B86], 0x20384A, 0x132330, 0x35506A, true, nil, day)
            case .golden: return make([0x1F3550, 0x334356, 0x5E4A37, 0x9A6A3C], 0x3A3326, 0x1A1712, 0x4D4536, true, 0xF3D29A, day)
            case .dusk: return make([0x1A1C3A, 0x322B54, 0x6C4260, 0xB8644F], 0x2B2340, 0x17121F, 0x4F4266, true, 0xF0915E, lit)
            case .night: return make([0x121A33, 0x181A30, 0x24243A, 0x2E2A44], 0x191826, 0x121110, 0x45405F, true, nil, lit)
            }
        }
        switch phase {
        case .dawn: return make([0x8FC1E8, 0xB7D6EE, 0xF1D6C2, 0xF7C9A4], 0xB3B0C3, 0x6A7568, 0xCFC8D8, false, 0xFFF1D6, day)
        case .day: return make([0x5EA8E5, 0x8EC4EC, 0xC7E2F4, 0xE3F0F8], 0x9FBCAE, 0x4F6F58, 0xB7CBD9, false, nil, day)
        case .golden: return make([0x78AADB, 0xA7C3DC, 0xF0CF9C, 0xF4B46C], 0xC4A983, 0x5E5A42, 0xDCC6A2, false, 0xFFE2A8, day)
        case .dusk: return make([0x2C3566, 0x4A4275, 0x6C4260, 0xE08A62], 0x4B3F62, 0x2C2440, 0x7D6A90, true, 0xFFB37A, lit)
        case .night: return make([0x121A33, 0x181A30, 0x24243A, 0x2E2A44], 0x3A3550, 0x5B5568, 0x45405F, true, nil, lit)
        }
    }

    /// The sky from top to horizon, as a gradient.
    var gradient: LinearGradient {
        LinearGradient(
            stops: [
                .init(color: sky[0], location: 0), .init(color: sky[1], location: 0.5), .init(color: sky[2], location: 0.86),
                .init(color: sky[3], location: 1),
            ], startPoint: .top, endPoint: .bottom)
    }
}

// MARK: ink

/// The colours words take where they are: the page's, or over the sky,
/// where every colour (the late red and the warning amber too) reads at
/// 4.5:1 over any hour, and cards on it are glass, a faint pane on a dark
/// sky and frosted on a light one. The web's --k-* and Android's SkyInk.
struct Inks {
    var ink: Color = .ink
    var muted: Color = .muted
    var accent: Color = .brand
    /// Small words in the accent (a countdown, the trip's phase): stronger in the sky.
    var smallAccent: Color = .brand
    var good: Color = .good
    var late: Color = .bad
    var warn: Color = .warn
    /// What small coloured words sit on in the sky; nil on the page.
    var chip: Color?
    /// A card's surface, and its hairline.
    var pane: Color = .surface
    var raised: Color = .surface2
    var line: Color = .line
    var inSky = false

    static let page = Inks()

    /// Over a sky whose words are light (`light`) or dark.
    static func sky(light: Bool) -> Inks {
        func c(_ v: UInt32) -> Color { Color(rgb: v) }
        if light {
            return Inks(
                ink: c(0xF2EFEB), muted: c(0xE7E5E4), accent: c(0xFB923C), smallAccent: c(0xFED7AA), good: c(0x86EFAC), late: c(0xFECACA),
                warn: c(0xFCD34D), chip: .black.opacity(0.22), pane: .white.opacity(0.08), raised: .white.opacity(0.13),
                line: .white.opacity(0.18), inSky: true)
        }
        return Inks(
            ink: c(0x1C1917), muted: c(0x36312D), accent: c(0x9A3412), smallAccent: c(0x6C2710), good: c(0x14532D), late: c(0x701818),
            warn: c(0x78350F), chip: .white.opacity(0.65), pane: .white.opacity(0.5), raised: .white.opacity(0.65),
            line: Color(rgb: 0x1C1917).opacity(0.16), inSky: true)
    }
}

// MARK: drawing

/// How much bigger than its numbers Now's horizon is drawn: the bus and your stop are the picture.
let roadScale: CGFloat = 1.25
/// The strip at the foot of the sky where Now's horizon is drawn.
let horizonHeight: CGFloat = 92 * roadScale

private let moonColour = Color(rgb: 0xFDE9C9)

/// Across (0–1), down (0–1.05 of the room above the words), brightness and size. Fixed, so they never twinkle.
private let stars: [(CGFloat, CGFloat, Double, CGFloat)] = [
    (0.06, 0.30, 0.7, 1.3), (0.17, 0.62, 0.5, 1.1), (0.29, 0.18, 0.8, 1.4),
    (0.38, 0.80, 0.4, 1.0), (0.47, 0.42, 0.6, 1.2), (0.55, 0.10, 0.5, 1.0),
    (0.63, 0.68, 0.45, 1.1), (0.72, 0.28, 0.7, 1.3), (0.84, 0.88, 0.4, 1.0),
    (0.92, 0.50, 0.55, 1.2), (0.11, 0.95, 0.35, 1.0), (0.33, 1.05, 0.4, 1.1),
    (0.58, 0.98, 0.3, 1.0), (0.97, 0.16, 0.45, 1.1),
]

/// The hills along the horizon, more or less Kent Ridge: how far down the
/// 92-unit strip each is, x units across. Fixed waves, so a wider screen
/// shows more hills rather than stretched ones.
private func farY(_ x: CGFloat) -> CGFloat { 30 + 6 * sin(x / 47 + 0.6) + 4 * sin(x / 19 + 2.1) }
private func nearY(_ x: CGFloat) -> CGFloat { 52 + 3 * sin(x / 61 + 1.3) + 1.5 * sin(x / 27) }

private func dip(_ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
    var best = lo
    var x = lo
    while x <= hi {
        if farY(x) > farY(best) { best = x }
        x += 2
    }
    return best
}

/// Now's horizon, `w` units across: your stop's sign, left of the flag.
func roadSign(_ w: CGFloat) -> CGFloat { min((w * 0.7).rounded(), (w * 0.74).rounded() - 7) }
/// Your bus, `far` along the road to the sign.
func roadBusX(_ sign: CGFloat, _ far: CGFloat) -> CGFloat { (sign - 44 - min(1, max(0, far)) * (sign - 56)).rounded() }
private func shuttleX(_ w: CGFloat) -> CGFloat { (w * 0.58).rounded() - 19 }

/// The shuttle going by when nothing's coming: dark, with A1's red along the bottom.
private let shuttlePaint = Color(rgb: 0x24211E)
private let shuttleBand = Color(rgb: 0xD32F2F)

enum SkyDraw {
    /// Where the sky ends, from `top` down: the hills, a building or two, rain
    /// trees, Singapore's flag by the road, and Marina Bay Sands far off, in
    /// `p`'s colours, with the lights on after dark and the sun low behind the
    /// hills at dawn, in the golden hour and at dusk. The near hill is `page`'s
    /// colour, so the sky meets the ground. `far` lowers the far layer (points).
    static func horizon(
        _ g: inout GraphicsContext, size: CGSize, top: CGFloat, page: Color, p: SkyPalette, phase: SkyPhase, road: Road, far: CGFloat = 0,
        scale: CGFloat = 1, withSun: Bool = true
    ) {
        let d = scale
        let w = size.width / d
        func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * d, y: top + y * d) }
        func box(_ x: CGFloat, _ y: CGFloat, _ bw: CGFloat, _ bh: CGFloat, _ color: Color, _ r: CGFloat = 0, in c: inout GraphicsContext) {
            c.fill(
                Path(roundedRect: CGRect(origin: at(x, y), size: CGSize(width: bw * d, height: bh * d)), cornerRadius: r * d),
                with: .color(color))
        }
        func shape(_ color: Color, _ pts: [(CGFloat, CGFloat)], in c: inout GraphicsContext) {
            var path = Path()
            for (i, (x, y)) in pts.enumerated() { i == 0 ? path.move(to: at(x, y)) : path.addLine(to: at(x, y)) }
            path.closeSubpath()
            c.fill(path, with: .color(color))
        }
        func ridge(_ y: (CGFloat) -> CGFloat, _ color: Color, in c: inout GraphicsContext) {
            var path = Path()
            path.move(to: CGPoint(x: 0, y: top + 92 * d))
            path.addLine(to: CGPoint(x: 0, y: top + y(0) * d))
            var x: CGFloat = 4
            while x < w + 4 {
                path.addLine(to: CGPoint(x: x * d, y: top + y(x) * d))
                x += 4
            }
            path.addLine(to: CGPoint(x: size.width, y: top + 92 * d))
            path.closeSubpath()
            c.fill(path, with: .color(color))
        }
        func across(_ f: CGFloat) -> CGFloat { (w * f).rounded() }
        let lights = phase.lights
        let sx = roadSign(w)
        let flag = across(0.76)

        // The far layer sinks behind the near hill as the page scrolls, kept to the strip.
        var back = g
        back.clip(to: Path(CGRect(x: 0, y: top, width: size.width, height: 92 * d)))
        back.translateBy(x: 0, y: far)
        if withSun, let sun = p.sun {
            let (cx, cy, r): (CGFloat, CGFloat, CGFloat) =
                switch phase {
                case .dawn: (across(0.3), 42, 16)
                case .golden: (across(0.36), 36, 16)
                default: (across(0.5), 40, 26)
                }
            let c = at(cx, cy)
            back.fill(Path(ellipseIn: CGRect(x: c.x - r * d, y: c.y - r * d, width: 2 * r * d, height: 2 * r * d)), with: .color(sun))
        }
        // Marina Bay Sands, far off and pale: three towers and the SkyPark across them.
        let mbs = dip(max(across(0.8) - 40, flag + 30), min(across(0.8) + 40, w - 29))
        if mbs + 25 <= w {
            let city = farY(mbs) + 3
            for x: CGFloat in [-13, -2, 9] {
                shape(p.city, [(mbs + x, city), (mbs + x + 1, city - 26), (mbs + x + 5, city - 26), (mbs + x + 6, city)], in: &back)
            }
            shape(p.city, [(mbs - 15, city - 28), (mbs + 25, city - 29.2), (mbs + 23, city - 26), (mbs - 14, city - 26)], in: &back)
        }
        ridge(farY, p.far, in: &back)
        let b1 = across(0.18)
        let b2 = across(0.62)
        box(b1 - 8, farY(b1) - 14, 16, 20, p.far, in: &back)
        box(b2 - 13, farY(b2) - 22, 26, 28, p.far, in: &back)
        if lights {
            box(b1 - 3, farY(b1) - 9, 3, 3, moonColour.opacity(0.6), in: &back)
            box(b2 - 5, farY(b2) - 16, 3, 3, moonColour, in: &back)
            box(b2 + 3, farY(b2) - 8, 3, 3, moonColour.opacity(0.6), in: &back)
        }

        for f: CGFloat in [0.06, 0.45, 0.9] {
            let c = across(f)
            rainTree(&g, foot: at(c, nearY(c)), d: d, color: p.tree)
        }
        // A Singapore flag on its pole by the road.
        let pole = nearY(flag)
        var staff = Path()
        staff.move(to: at(flag, pole + 2))
        staff.addLine(to: at(flag, pole - 24))
        g.stroke(staff, with: .color(p.tree), lineWidth: 1.2 * d)
        let red = Color(rgb: 0xEF3340)
        let white = Color(rgb: 0xF2EFEB)
        box(flag + 0.6, pole - 24, 12, 4, red, in: &g)
        box(flag + 0.6, pole - 20, 12, 4, white, in: &g)
        // The crescent and its five stars, which tell it from Indonesia's.
        dot(&g, at(flag + 3.2, pole - 22), 1.5 * d, white)
        dot(&g, at(flag + 3.8, pole - 22), 1.3 * d, red)
        for i in 0..<5 {
            let a = CGFloat(i) * 2 * .pi / 5
            dot(&g, at(flag + 5.2 + 0.85 * sin(a), pole - 22 - 0.85 * cos(a)), 0.35 * d, white)
        }
        ridge(nearY, page, in: &g)
        var lane = Path()
        lane.move(to: at(0, 70))
        lane.addLine(to: at(w, 70))
        g.stroke(lane, with: .color(p.road), style: StrokeStyle(lineWidth: 1.5 * d, dash: [6 * d, 6 * d]))

        if road.stop {
            // The sign: a bus on it, as on a real one.
            var post = Path()
            post.move(to: at(sx, 70))
            post.addLine(to: at(sx, 44))
            g.stroke(post, with: .color(p.post), lineWidth: 1.6 * d)
            box(sx - 6.5, 33, 13, 13, p.post, 2.5, in: &g)
            box(sx - 3.5, 35.5, 7, 7.5, p.postInk, 1.5, in: &g)
            box(sx - 2.5, 36.5, 5, 3, p.post, 0.5, in: &g)
        }
        if let bus = road.bus, road.stop {
            // Your bus pulls up just short of the sign.
            shuttle(
                &g, origin: at(roadBusX(sx, bus.far), 57), d: d, paint: Color(rgb: bus.color), band: bus.live ? .white.opacity(0.85) : nil,
                glass: p.window)
        } else if road.shuttle {
            let x = shuttleX(w)
            if lights {
                var beam = Path()
                beam.move(to: at(x + 38, 66))
                beam.addLine(to: at(x + 60, 63))
                beam.addLine(to: at(x + 60, 70))
                beam.closeSubpath()
                g.fill(beam, with: .color(moonColour.opacity(0.12)))
            }
            shuttle(&g, origin: at(x, 57), d: d, paint: shuttlePaint, band: shuttleBand, glass: p.window, dim: 3)
        }
    }

    private static func dot(_ g: inout GraphicsContext, _ c: CGPoint, _ r: CGFloat, _ color: Color) {
        g.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)), with: .color(color))
    }

    /// A rain tree standing at `foot`: a trunk forking low under a wide, flat crown.
    static func rainTree(_ g: inout GraphicsContext, foot: CGPoint, d: CGFloat, color: Color) {
        func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: foot.x + x * d, y: foot.y + y * d) }
        let trunk: [(CGFloat, CGFloat)] = [
            (-1.5, 2), (-1.5, -7), (-7, -13), (-4.5, -13), (0, -9), (4.5, -13), (7, -13), (1.5, -7), (1.5, 2),
        ]
        var p = Path()
        for (i, (x, y)) in trunk.enumerated() { i == 0 ? p.move(to: at(x, y)) : p.addLine(to: at(x, y)) }
        p.closeSubpath()
        for (cx, cy, rx, ry): (CGFloat, CGFloat, CGFloat, CGFloat) in [(0, -18, 21, 5.5), (-8, -21.5, 11, 4.5), (8, -22, 12, 4.5)] {
            p.addEllipse(in: CGRect(x: foot.x + (cx - rx) * d, y: foot.y + (cy - ry) * d, width: 2 * rx * d, height: 2 * ry * d))
        }
        g.fill(p, with: .color(color))
    }

    /// A single-decker from the side, heading right: 38 by 12 from `origin`,
    /// standing on its wheels at 12. With no `band` it's an outline in
    /// `paint` (a timetable guess, so it never passes for live). Window `dim`
    /// (0 to 3) has its light off.
    static func shuttle(_ g: inout GraphicsContext, origin o: CGPoint, d: CGFloat, paint: Color, band: Color?, glass: Color, dim: Int = -1)
    {
        let solid = band != nil
        func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: o.x + x * d, y: o.y + y * d) }
        func part(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ color: Color, _ r: CGFloat, _ line: CGFloat) {
            let rect = Path(roundedRect: CGRect(origin: pt(x, y), size: CGSize(width: w * d, height: h * d)), cornerRadius: r * d)
            if solid { g.fill(rect, with: .color(color)) } else { g.stroke(rect, with: .color(paint), lineWidth: line * d) }
        }
        var body = Path()
        body.move(to: pt(1.5, 0))
        body.addLine(to: pt(33, 0))
        body.addQuadCurve(to: pt(36.9, 2.6), control: pt(36, 0))
        body.addLine(to: pt(38, 8.5))
        body.addLine(to: pt(38, 10.5))
        body.addQuadCurve(to: pt(36.5, 12), control: pt(38, 12))
        body.addLine(to: pt(1.5, 12))
        body.addQuadCurve(to: pt(0, 10.5), control: pt(0, 12))
        body.addLine(to: pt(0, 1.5))
        body.addQuadCurve(to: pt(1.5, 0), control: pt(0, 0))
        body.closeSubpath()
        var screen = Path()
        screen.move(to: pt(35.6, 2.5))
        screen.addQuadCurve(to: pt(36.4, 3.2), control: pt(36.2, 2.5))
        screen.addLine(to: pt(37.1, 7.2))
        screen.addLine(to: pt(35.6, 7.2))
        screen.closeSubpath()
        part(5, -1.6, 14, 1.9, paint, 0.8, 0.8)
        if let band {
            g.fill(body, with: .color(paint))
            g.fill(Path(CGRect(origin: pt(0, 9.5), size: CGSize(width: 38 * d, height: 2 * d))), with: .color(band))
        } else {
            g.stroke(body, with: .color(paint), style: StrokeStyle(lineWidth: 1.2 * d, lineJoin: .round))
        }
        for (i, wx) in [2.5, 8.5, 14.5, 20.5].enumerated() { part(wx, 2.5, 5, 4, i == dim ? glass.opacity(0.6) : glass, 0.8, 0.6) }
        part(26.5, 2.5, 4.5, 4, glass, 0.8, 0.6)
        part(32, 2.5, 2.8, 8.2, glass, 0.6, 0.6)
        if solid { g.fill(screen, with: .color(glass)) } else { g.stroke(screen, with: .color(paint), lineWidth: 0.6 * d) }
        if solid {
            g.fill(
                Path(roundedRect: CGRect(origin: pt(36.6, 8.3), size: CGSize(width: 1.4 * d, height: 1.3 * d)), cornerRadius: 0.5 * d),
                with: .color(Color(rgb: 0xFEF3C7)))
            g.fill(
                Path(roundedRect: CGRect(origin: pt(0, 7.4), size: CGSize(width: 0.9 * d, height: 1.8 * d)), cornerRadius: 0.4 * d),
                with: .color(Color(rgb: 0xEF4444)))
        }
        for wx: CGFloat in [7.5, 26] {
            let c = pt(wx, 12)
            var arch = Path()
            arch.addArc(center: c, radius: 3.2 * d, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
            if solid {
                arch.closeSubpath()
                g.fill(arch, with: .color(.black.opacity(0.35)))
            } else {
                g.stroke(arch, with: .color(paint), lineWidth: 1.2 * d)
            }
            dot(&g, c, 2.2 * d, Color(rgb: 0x151311))
            dot(&g, c, 0.8 * d, Color(rgb: 0x8A847D))
        }
    }

    /// The stars across the room above the words, and the moon among them on the right.
    static func starsAndMoon(_ g: inout GraphicsContext, width: CGFloat, room: CGFloat, alpha: Double = 1, moonRoom: CGFloat? = nil) {
        for (x, y, a, r) in stars {
            dot(&g, CGPoint(x: width * x, y: room * 0.85 * y / 1.05 + 4), r, .white.opacity(a * alpha))
        }
        let mr = moonRoom ?? room
        let r = min(28, mr * 0.3)
        crescent(&g, centre: CGPoint(x: width - 16 - r, y: mr * 0.48), r: r, alpha: alpha)
    }

    /// A crescent moon: a disc with a slightly smaller one taken out up and to the right.
    static func crescent(_ g: inout GraphicsContext, centre c: CGPoint, r: CGFloat, alpha: Double = 1) {
        var layer = g
        layer.opacity = alpha
        layer.drawLayer { l in
            l.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)), with: .color(moonColour))
            l.blendMode = .destinationOut
            let b = CGPoint(x: c.x + r * 0.46, y: c.y - r * 0.3)
            let br = r * 0.9
            l.fill(Path(ellipseIn: CGRect(x: b.x - br, y: b.y - br, width: 2 * br, height: 2 * br)), with: .color(.black))
        }
    }
}
