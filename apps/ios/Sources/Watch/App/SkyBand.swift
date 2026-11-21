import SwiftUI

struct SkyBand<Content: View>: View {
    let road: Road
    @ViewBuilder var content: (Inks) -> Content
    @Environment(\.isLuminanceReduced) private var dimmed

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
                        if phase.lights { SkyDraw.starsAndMoon(&g, width: size.width, room: max(30, top), alpha: 0.8, moonRoom: 0) }
                        SkyDraw.horizon(&g, size: size, top: top, page: .black, p: p, phase: phase, road: road, scale: scale)
                    }
                    .mask {
                        LinearGradient(
                            stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.25)], startPoint: .top,
                            endPoint: .bottom)
                    }
                    .padding(.horizontal, -30)
                    .accessibilityHidden(true)
                }
        }
    }
}

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
