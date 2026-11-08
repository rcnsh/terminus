import SwiftUI

/// A small band of the hour's sky behind Now's head, as on the phone and
/// the widgets (SkyDraw): the sky's colours, the hills along its foot with
/// your stop and your bus on the road, the stars and moon at night. In
/// always-on, plain black: the screen dims and the sky would only blur.
struct SkyBand<Content: View>: View {
    let road: Road
    @ViewBuilder var content: (Inks) -> Content
    @Environment(\.isLuminanceReduced) private var dimmed

    /// How tall the hills are drawn at the band's foot.
    static var strip: CGFloat { 30 }

    var body: some View {
        if dimmed {
            content(.page).padding(.bottom, 6)
        } else {
            let phase = SkyPhase.at(Date())
            let p = SkyPalette.of(phase, dark: true)
            content(Inks.sky(light: p.lightInk))
                .padding(.bottom, Self.strip)
                .background {
                    Canvas { g, size in
                        let scale = Self.strip / 92 * 1.6
                        let top = size.height - 92 * scale
                        g.fill(
                            Path(CGRect(origin: .zero, size: size)),
                            with: .linearGradient(
                                Gradient(colors: p.sky), startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
                        if phase.lights { SkyDraw.starsAndMoon(&g, width: size.width, room: max(30, top), alpha: 0.8) }
                        SkyDraw.horizon(&g, size: size, top: top, page: .black, p: p, phase: phase, road: road, scale: scale)
                    }
                    // Edge to edge, and up behind the clock.
                    .padding(.horizontal, -24)
                    .ignoresSafeArea(edges: .top)
                    .accessibilityHidden(true)
                }
        }
    }
}
