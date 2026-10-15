import SwiftUI

/// How you get around: the pace as a lap of a running track (400 m, something
/// people have walked round) with the chosen pace's time in the middle; the
/// three paces; "allow for busy buses", with the trade it makes drawn under
/// it; then 12- or 24-hour times.
struct SetupPaceStep: View {
    let model: OnboardingModel

    /// Each pace, and how long a lap of a 400 m track takes at it.
    private var paces: [(value: String, title: String, lap: Int)] {
        [("slow", L("Slow"), 6), ("normal", L("Normal"), 5), ("fast", L("Fast"), 4)]
    }

    var body: some View {
        SetupPage(
            title: L("How you get around"), sub: L("Walks follow the paths on campus. Your pace sets how long they take."),
            message: model.message
        ) {
            SetupButtons(back: model.back, next: model.next)
        } content: {
            let lap = paces.first { $0.value == model.walkPace }?.lap ?? 5
            SetupTrack(lapMin: lap)
            Text(L("One lap of a running track is 400 m."))
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)
            HStack(spacing: 8) {
                ForEach(paces, id: \.value) { p in
                    SetupChoiceTile(selected: model.walkPace == p.value, id: "pace.\(p.value)") {
                        model.setPace(p.value)
                    } content: {
                        Text(p.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                        Text(L("%@ min a lap", "\(p.lap)")).font(.footnote).foregroundStyle(Color.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.top, 14)
            SetupBusyBuses(model: model).padding(.top, 14)
            SetupClockSwitch(model: model).padding(.top, 20)
        }
    }
}

/// A running track, from above: the lap's time at your pace in the infield.
private struct SetupTrack: View {
    let lapMin: Int
    @Environment(\.colorScheme) private var scheme

    /// A running track's own red, the same in light and dark.
    private static let track = Color(rgb: 0xB4533A)

    var body: some View {
        let dark = scheme == .dark
        let infield = Color(rgb: dark ? 0x1E3A26 : 0xCFE5C3)
        let onInfield = Color(rgb: dark ? 0xBBF7D0 : 0x14532D)
        ZStack {
            Canvas { g, size in
                let r = size.height / 2
                let lane: CGFloat = 15
                g.fill(Path(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: r), with: .color(Self.track))
                g.stroke(
                    Path(
                        roundedRect: CGRect(x: lane / 2, y: lane / 2, width: size.width - lane, height: size.height - lane),
                        cornerRadius: r - lane / 2), with: .color(.white.opacity(0.45)), lineWidth: 1)
                g.fill(
                    Path(
                        roundedRect: CGRect(x: lane, y: lane, width: size.width - 2 * lane, height: size.height - 2 * lane),
                        cornerRadius: r - lane), with: .color(infield))
                // The finish line, and you on the far bend.
                var finish = Path()
                finish.move(to: CGPoint(x: size.width / 2, y: 0))
                finish.addLine(to: CGPoint(x: size.width / 2, y: lane))
                g.stroke(finish, with: .color(.white), lineWidth: 3)
                let bend = -50 * Double.pi / 180
                let you = CGPoint(x: size.width - r + (r - lane / 2) * cos(bend), y: r + (r - lane / 2) * sin(bend))
                g.fill(Path(ellipseIn: CGRect(x: you.x - 9, y: you.y - 9, width: 18, height: 18)), with: .color(.white))
                g.fill(Path(ellipseIn: CGRect(x: you.x - 6, y: you.y - 6, width: 12, height: 12)), with: .color(.brand))
            }
            VStack(spacing: 0) {
                Text(L("%@ min", "\(lapMin)"))
                    .font(.system(size: 40, weight: .heavy))
                    .tracking(-1)
                    .contentTransition(.numericText())
                Text(L("a lap at your pace"))
                    .font(.caption.weight(.semibold))
            }
            .foregroundStyle(onInfield)
            .animation(.snappy, value: lapMin)
        }
        .frame(height: 150)
        .accessibilityElement(children: .combine)
    }
}

/// "Allow for busy buses", with an example of what it does: the earlier R2 instead of the packed one.
private struct SetupBusyBuses: View {
    let model: OnboardingModel

    var body: some View {
        let on = model.fullBusMargin
        VStack(alignment: .leading, spacing: 10) {
            Toggle(isOn: Binding(get: { on }, set: { model.setFullBusMargin($0) })) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Allow for busy buses")).font(.body).foregroundStyle(Color.ink)
                    SetupHint(L("When the bus you'd wait for is often full at that stop and time, aim one bus earlier."))
                }
            }
            .tint(.brand)
            .accessibilityIdentifier("pace.busy")
            if on {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { example }
                    VStack(alignment: .leading, spacing: 6) { example }
                }
                .accessibilityElement(children: .combine)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
        .animation(.default, value: on)
    }

    @ViewBuilder private var example: some View {
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        HStack(spacing: 6) {
            BusBadge(svc: "R2", color: "#34A853", size: 12)
            Text(setupClock(9 * 60 + 38)).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.brandSoft, in: shape)
        .overlay(shape.strokeBorder(Color.brand, lineWidth: 2))
        Text(L("instead of")).font(.footnote).foregroundStyle(Color.muted)
        HStack(spacing: 6) {
            BusBadge(svc: "R2", color: "#34A853", size: 12)
            Text("\(setupClock(9 * 60 + 46)) · \(L("busy"))")
                .font(.subheadline)
                .strikethrough()
                .foregroundStyle(Color.muted)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.surface2, in: shape)
    }
}

/// 12- or 24-hour, as two halves of one switch, each an example time. The
/// phone's own style shows picked until another is (Settings has "follow the phone").
private struct SetupClockSwitch: View {
    let model: OnboardingModel

    var body: some View {
        let shown = model.clock != "auto" ? model.clock : (Clock.hour12 ? "12" : "24")
        HStack(spacing: 12) {
            Text(L("Show times as")).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
            Spacer(minLength: 0)
            Picker(L("Show times as"), selection: Binding(get: { shown }, set: { model.setClock($0) })) {
                Text(L("6:36 PM")).tag("12")
                Text(verbatim: "18:36").tag("24")
            }
            .pickerStyle(.segmented)
            .fixedSize()
            .accessibilityIdentifier("pace.clock")
        }
    }
}
