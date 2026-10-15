import SwiftUI
import WidgetKit

/// The card styles, each drawn with a made-up trip (a D2 from PGP to UTown,
/// leaving in a few minutes) so the choice is made by looking, not by
/// reading. The pick holds for the card on Now and the widgets.
struct SettingsCardStyles: View {
    @Environment(Prefs.self) private var prefs

    private static let styles = ["steps", "route", "ticket"]

    var body: some View {
        SettingsGroup(title: L("Card style"), hint: L("How the card and widgets show a trip by bus. Only on this phone.")) {
            ForEach(Array(Self.styles.enumerated()), id: \.element) { i, style in
                if i > 0 { GroupDivider() }
                option(style)
            }
        }
    }

    private func option(_ style: String) -> some View {
        let on = prefs.cardStyle == style
        return Button {
            prefs.cardStyle = style
            WidgetCenter.shared.reloadAllTimelines()
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 12) {
                    Image(systemName: on ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(on ? Color.brand : Color.faint)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(settingsCardStyleName(style)).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                        SettingsHint(hint(style))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                SettingsCardSample(style: style)
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.page, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(
                            on ? Color.brand : Color.line, lineWidth: on ? 2 : 1)
                    )
                    .padding(.leading, 36)
                    .accessibilityHidden(true)
            }
            .padding(16)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(settingsCardStyleName(style)). \(hint(style))")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("settings.cardStyle.\(style)")
    }

    private func hint(_ style: String) -> String {
        switch style {
        case "ticket": L("The bus first, in its colour, then when to leave.")
        case "route": L("The whole trip as a line, with the times under it.")
        default: L("The trip as a line down the card, as on a route map.")
        }
    }
}

/// The sample trip, in one style: the same shapes Now draws, without the sky.
struct SettingsCardSample: View {
    let style: String

    private static let d2 = "#8E44C9"
    private var d2Color: Color { Color(hex: Self.d2) ?? .brand }

    /// Times for the sample, from now, in the account's clock style.
    private var times: (leave: String, board: String, arrive: String) {
        let now = Date()
        let leave = now.addingTimeInterval(4 * 60)
        let board = leave.addingTimeInterval(4 * 60)
        return (campusTime(leave), campusTime(board), campusTime(board.addingTimeInterval(8 * 60)))
    }

    var body: some View {
        switch style {
        case "ticket": ticket
        case "route": route
        default: steps
        }
    }

    private var head: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(L("To %@", "UTown")).font(.subheadline).foregroundStyle(Color.muted)
            accented(L("Leave in %@"), L("%@ min", "4"))
                .font(.title3.weight(.bold))
        }
    }

    /// `format` with its blank filled by `value` in the accent, the rest in the ink, whichever order the language puts them.
    private func accented(_ format: String, _ value: String) -> Text {
        let parts = format.components(separatedBy: "%@")
        let before = parts.first ?? ""
        let after = parts.count > 1 ? parts[1] : ""
        return Text(before).foregroundColor(Color.ink) + Text(value).foregroundColor(Color.brand) + Text(after).foregroundColor(Color.ink)
    }

    private var steps: some View {
        let t = times
        return VStack(alignment: .leading, spacing: 10) {
            head
            VStack(alignment: .leading, spacing: 0) {
                point(t.leave, dot: .start, line: .walk) {
                    Text(L("Leave")).font(.subheadline.weight(.semibold))
                } below: {
                    L("%@ walk", L("%@ min", "4"))
                }
                point(t.board, dot: .stop, line: .ride(d2Color)) {
                    HStack(spacing: 6) {
                        Text(verbatim: "PGP").font(.subheadline.weight(.semibold))
                        BusBadge(svc: "D2", color: Self.d2, size: 11)
                    }
                } below: {
                    L("%@ ride", L("%@ min", "8"))
                }
                point(t.arrive, dot: .end, line: nil) {
                    Text(verbatim: "UTown").font(.subheadline.weight(.bold))
                } below: {
                    nil
                }
            }
            .foregroundStyle(Color.ink)
        }
    }

    private enum Dot { case start, stop, end }
    private enum Stretch {
        case walk
        case ride(Color)
    }

    private func point(_ time: String, dot: Dot, line: Stretch?, @ViewBuilder title: () -> some View, below: () -> String?) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(time).font(.footnote.weight(.semibold).monospacedDigit()).frame(width: 64, alignment: .leading).padding(.top, 1)
            VStack(spacing: 0) {
                ZStack {
                    switch dot {
                    case .start: Circle().fill(Color.brand).frame(width: 12, height: 12)
                    case .stop: Circle().strokeBorder(Color.ink, lineWidth: 2.5).frame(width: 12, height: 12)
                    case .end: Circle().strokeBorder(Color.brand, lineWidth: 4).frame(width: 15, height: 15)
                    }
                }
                .frame(width: 16, height: 16)
                switch line {
                case .walk?:
                    Rectangle().fill(.clear).frame(width: 3).overlay(
                        StraightLine().stroke(Color.muted, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [1.5, 5]))
                    )
                case .ride(let c)?:
                    Capsule().fill(c).frame(width: 6).padding(.vertical, 2)
                case nil:
                    EmptyView()
                }
            }
            .frame(width: 16)
            VStack(alignment: .leading, spacing: 4) {
                title()
                if let b = below() { Text(b).font(.caption).foregroundStyle(Color.muted) }
            }
            .padding(.bottom, line == nil ? 0 : 10)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var route: some View {
        let t = times
        return VStack(alignment: .leading, spacing: 12) {
            head
            HStack(alignment: .top, spacing: 0) {
                routePoint(L("You"), t.leave, Color.brand)
                routeStretch(above: nil, takes: L("%@ min", "4")) {
                    StraightLine().stroke(Color.muted, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [1.5, 5]))
                }
                routePoint("PGP", t.board, Color.ink)
                routeStretch(above: AnyView(BusBadge(svc: "D2", color: Self.d2, size: 10)), takes: L("%@ min", "8")) {
                    StraightLine().stroke(d2Color, style: StrokeStyle(lineWidth: 4.5, lineCap: .round))
                }
                routePoint("UTown", t.arrive, Color.ink)
            }
            .foregroundStyle(Color.ink)
        }
    }

    private func routePoint(_ name: String, _ time: String, _ dot: Color) -> some View {
        VStack(spacing: 3) {
            Spacer().frame(height: 18)
            Circle().fill(dot).frame(width: 12, height: 12).frame(height: 14)
            Text(name).font(.caption.weight(.semibold)).lineLimit(1)
            Text(time).font(.caption2).foregroundStyle(Color.muted).lineLimit(1).fixedSize()
        }
        .frame(minWidth: 52)
    }

    private func routeStretch(above: AnyView?, takes: String, @ViewBuilder line: () -> some View) -> some View {
        VStack(spacing: 3) {
            Group { if let above { above } else { Color.clear } }.frame(height: 18)
            line().frame(height: 14)
            Text(takes).font(.caption2).foregroundStyle(Color.muted).lineLimit(1).fixedSize()
        }
        .frame(maxWidth: .infinity)
    }

    private var ticket: some View {
        let t = times
        return VStack(alignment: .leading, spacing: 10) {
            Text(L("To %@", "UTown")).font(.subheadline).foregroundStyle(Color.muted)
            HStack(spacing: 12) {
                Text(verbatim: "D2")
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundStyle(inkOn(hexRGB(Self.d2)))
                    .frame(width: 54, height: 54)
                    .background(d2Color, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(t.board).font(.title3.weight(.bold)).foregroundStyle(Color.ink)
                    Text("\(L("from %@", "PGP")) · \(L("%@ walk", L("%@ min", "4")))").font(.subheadline).foregroundStyle(Color.ink)
                }
            }
            HStack {
                Text(L("Leave in %@", L("%@ min", "4"))).font(.headline).foregroundStyle(Color.brand)
                Spacer()
                Text(L("Arrive %@", t.arrive)).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.brand.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}

/// A straight line across the middle of its frame, or down it when it's taller than wide.
private struct StraightLine: Shape {
    func path(in r: CGRect) -> Path {
        var p = Path()
        if r.height > r.width {
            p.move(to: CGPoint(x: r.midX, y: r.minY + 3))
            p.addLine(to: CGPoint(x: r.midX, y: r.maxY - 3))
        } else {
            p.move(to: CGPoint(x: r.minX + 4, y: r.midY))
            p.addLine(to: CGPoint(x: r.maxX - 4, y: r.midY))
        }
        return p
    }
}
