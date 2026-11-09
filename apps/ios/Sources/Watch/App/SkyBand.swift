import SwiftUI

/// A band of the hour's sky behind Now's head, as on the phone and the
/// widgets (SkyDraw): the sky's colours, the hills along its foot with your
/// stop and your bus on the road, the stars at night. Its top fades into the
/// screen's background (SkyBackdrop), the same sky behind the clock, so there
/// is no edge between them. In always-on, plain black: the screen dims and
/// the sky would only blur.
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
                        // The stars without the moon (no room for it: a moon of size 0),
                        // as a phone's short band with its words across the whole width.
                        if phase.lights { SkyDraw.starsAndMoon(&g, width: size.width, room: max(30, top), alpha: 0.8, moonRoom: 0) }
                        SkyDraw.horizon(&g, size: size, top: top, page: .black, p: p, phase: phase, road: road, scale: scale)
                    }
                    .mask {
                        LinearGradient(
                            stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.25)], startPoint: .top,
                            endPoint: .bottom)
                    }
                    // Edge to edge.
                    .padding(.horizontal, -30)
                    .accessibilityHidden(true)
                }
        }
    }
}

/// The top of the hour's sky as the screen's own background: behind the
/// clock and the title and into the round corners, where the band's top
/// fades into it, then down into black behind the steps once the band has
/// scrolled away. Black in always-on.
struct SkyBackdrop: View {
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        if dimmed {
            Color.black
        } else {
            let p = SkyPalette.of(SkyPhase.at(Date()), dark: true)
            let top = p.sky.first ?? .black
            LinearGradient(
                stops: [.init(color: top, location: 0), .init(color: top, location: 0.3), .init(color: .black, location: 0.85)],
                startPoint: .top, endPoint: .bottom)
        }
    }
}
