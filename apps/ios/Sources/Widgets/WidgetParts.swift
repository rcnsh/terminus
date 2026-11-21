import AppIntents
import SwiftUI
import WidgetKit

struct WidgetLook {
    let phase: SkyPhase
    let dark: Bool
    var palette: SkyPalette { SkyPalette.of(phase, dark: dark) }
    var sky: Inks { Inks.sky(light: palette.lightInk) }
    var ground: Inks { Inks.page }
    var page: Color { Color(rgb: dark ? 0x0F0E0D : 0xFAFAF9) }

    init(date: Date, dark: Bool) {
        phase = SkyPhase.at(date)
        self.dark = dark
    }
}

struct SkyBackdrop: View {
    let look: WidgetLook
    let height: CGFloat
    let scale: CGFloat
    var road = Road()
    var moon = CGPoint(x: 34, y: 60)

    var body: some View {
        Canvas { g, size in
            g.fill(
                Path(CGRect(origin: .zero, size: size)),
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: look.palette.sky[0], location: 0), .init(color: look.palette.sky[1], location: 0.5),
                        .init(color: look.palette.sky[2], location: 0.86), .init(color: look.palette.sky[3], location: 1),
                    ]),
                    startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
            let top = size.height - 92 * scale
            if look.phase == .night {
                SkyDraw.starsAndMoon(&g, width: size.width, room: max(20, top), moonRoom: 0)
                SkyDraw.crescent(&g, centre: CGPoint(x: size.width - moon.x, y: moon.y), r: 6)
            }
            SkyDraw.horizon(&g, size: size, top: top, page: look.page, p: look.palette, phase: look.phase, road: road, scale: scale)
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

struct Headline: View {
    let face: WidgetFace
    let inks: Inks
    let size: CGFloat
    var lines = 1

    var body: some View {
        let base = face.dim ? inks.muted : face.late ? inks.late : inks.ink
        let text: Text = {
            guard let big = face.big, !face.dim, !face.late, let r = face.headline.range(of: big) else {
                return Text(verbatim: face.headline).foregroundColor(base)
            }
            return Text(verbatim: String(face.headline[..<r.lowerBound])).foregroundColor(base)
                + Text(verbatim: big).foregroundColor(inks.accent)
                + Text(verbatim: String(face.headline[r.upperBound...])).foregroundColor(base)
        }()
        text.font(.system(size: size, weight: .bold)).lineLimit(lines).minimumScaleFactor(0.7).standInSpoken()
    }
}

struct PillView: View {
    let pill: WidgetPill
    let inks: Inks

    var body: some View {
        Text(verbatim: pill.good ? "● \(pill.text)" : pill.text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(pill.good ? inks.good : inks.muted)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(inks.chip ?? inks.raised, in: Capsule())
    }
}

struct LegRow: View {
    let leg: WidgetLeg
    let inks: Inks
    var size: CGFloat = 13

    var body: some View {
        HStack(spacing: 7) {
            if let svc = leg.svc { BusBadge(svc: svc, color: leg.color, size: 12, paid: leg.paid) }
            Text(verbatim: leg.text).font(.system(size: size)).foregroundStyle(inks.ink).lineLimit(1).minimumScaleFactor(0.8)
        }
        .standInHidden()
    }
}

struct RefreshButton: View {
    let slot: String?
    let inks: Inks
    var side: CGFloat = 28

    var body: some View {
        Button(intent: RefreshIntent(slot: slot)) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: side * 0.45, weight: .semibold))
                .foregroundStyle(inks.ink)
                .frame(width: side, height: side)
                .background(inks.chip ?? inks.raised, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(L("Refresh"))
        .unredacted()
    }
}

struct ModeChips: View {
    let chips: [WidgetMode]
    let showing: WidgetMode
    let slot: String
    let inks: Inks
    let onChosen: Color

    var body: some View {
        HStack(spacing: 6) {
            ForEach(chips, id: \.id) { m in
                let on = m.id == showing.id
                Button(intent: ModeIntent(slot: slot, mode: m)) {
                    Text(verbatim: m.label)
                        .font(.system(size: 13, weight: on ? .semibold : .regular))
                        .lineLimit(1)
                        .fixedSize()
                        .foregroundStyle(on ? onChosen : inks.ink)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(on ? inks.ink : (inks.chip ?? inks.raised), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(on ? L("Showing %@", m.label) : L("Show %@", m.label))
            }
        }
        .unredacted()
    }
}

struct TileView: View {
    let tile: WidgetTile
    let inks: Inks

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(verbatim: tile.label.uppercased(with: Lang.locale)).font(.system(size: 11, weight: .bold)).foregroundStyle(
                inks.smallAccent
            ).lineLimit(1)
            Text(verbatim: [tile.title, tile.place].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 14, weight: .medium))
                .foregroundStyle(inks.ink).lineLimit(1)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .standInHidden()
        .background(inks.pane, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

func small(_ text: String, _ color: Color, _ size: CGFloat = 12, bold: Bool = false, lines: Int = 1) -> some View {
    Text(verbatim: text).font(.system(size: size, weight: bold ? .medium : .regular)).foregroundStyle(color).lineLimit(lines)
}
