import SwiftUI
import UIKit

/// Notifications and location, each showing what it gives before asking: the
/// leave-by alert itself, and your dot finding its nearest stop. Both optional.
struct SetupAlertsStep: View {
    let model: OnboardingModel
    private let locator = Locator.shared
    @Environment(\.scenePhase) private var scenePhase

    init(model: OnboardingModel) { self.model = model }

    var body: some View {
        SetupPage(title: L("Two more things"), sub: L("Both are optional. You can change them later in Settings."), message: model.message)
        {
            SetupButtons(back: model.back, nextLabel: L("Start using terminus"), next: model.finish)
        } content: {
            VStack(spacing: 12) {
                SetupPermissionCard(
                    title: L("A nudge when it's time"),
                    text: L("A heads-up 5 minutes before you need to leave for class, so you don't have to keep checking."),
                    done: model.alertsOn ? L("On.") : nil,
                    ask: model.notificationsRefused ? L("Turn on in Settings") : L("Turn on leave alerts"),
                    id: "alerts.notify"
                ) {
                    Task { await model.turnOnAlerts() }
                } preview: {
                    SetupAlertPreview()
                }
                SetupPermissionCard(
                    title: L("Start from where you are"),
                    text: L(
                        "So directions start from your nearest stop. Your location is used only for that request, rounded to about 11 m, and never stored. Without it, terminus assumes you're at your last class or at home."
                    ),
                    done: locator.allowed ? L("Allowed.") : nil,
                    ask: locator.denied ? L("Turn on in Settings") : L("Allow location"),
                    id: "alerts.location"
                ) {
                    if locator.denied {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    } else {
                        locator.ask()
                    }
                } preview: {
                    SetupLocationPreview()
                }
            }
        }
        // Back from Settings: what was turned on there shows.
        .onChange(of: scenePhase) { _, p in if p == .active { Task { await model.refreshAlerts() } } }
    }
}

private struct SetupPermissionCard<Preview: View>: View {
    let title: String
    let text: String
    /// What it says once allowed; nil while it can still be asked for.
    let done: String?
    let ask: String
    let id: String
    let action: () -> Void
    @ViewBuilder var preview: Preview

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            preview.accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline).foregroundStyle(Color.ink)
                Text(text).font(.footnote).foregroundStyle(Color.muted).fixedSize(horizontal: false, vertical: true)
                if let done {
                    Label(done, systemImage: "checkmark")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Color.good)
                        .padding(.top, 8)
                        .accessibilityIdentifier("\(id).done")
                } else {
                    Button(ask, action: action)
                        .buttonStyle(.secondary)
                        .padding(.top, 10)
                        .accessibilityIdentifier(id)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        }
        .background(Color.surface, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.line))
    }
}

/// The leave-by alert, as it shows on the phone: an example class.
private struct SetupAlertPreview: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 7) {
                TerminusMark().frame(width: 18, height: 18)
                Text(verbatim: "terminus").font(.footnote.weight(.semibold)).foregroundStyle(Color.ink)
                Spacer()
                Text(L("now")).font(.footnote).foregroundStyle(Color.muted)
            }
            .padding(.bottom, 4)
            Text(L("Leave in 5 min for GEA1000")).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
            Text(L("R2 from PGP at %@", setupClock(9 * 60 + 42))).font(.subheadline).foregroundStyle(Color.ink.opacity(0.8))
        }
        .padding(14)
        .background(Color.surface2, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding([.horizontal, .top], 12)
    }
}

/// A few roads, a route line, a stop, and you: a dashed walk from your dot to the stop.
private struct SetupLocationPreview: View {
    var body: some View {
        Canvas { g, size in
            let w = size.width
            let h = size.height
            func curve(
                _ from: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ to: CGPoint, _ c3: CGPoint? = nil, _ c4: CGPoint? = nil,
                _ to2: CGPoint? = nil
            ) -> Path {
                var p = Path()
                p.move(to: from)
                p.addCurve(to: to, control1: c1, control2: c2)
                if let c3, let c4, let to2 { p.addCurve(to: to2, control1: c3, control2: c4) }
                return p
            }
            let road = Color.line
            g.stroke(
                curve(
                    CGPoint(x: -10, y: h * 0.62), CGPoint(x: w * 0.25, y: h * 0.5), CGPoint(x: w * 0.45, y: h * 0.85),
                    CGPoint(x: w * 0.65, y: h * 0.65), CGPoint(x: w * 0.8, y: h * 0.5), CGPoint(x: w * 0.9, y: h * 0.4),
                    CGPoint(x: w + 10, y: h * 0.45)), with: .color(road), lineWidth: 12)
            g.stroke(
                curve(
                    CGPoint(x: w * 0.33, y: -10), CGPoint(x: w * 0.36, y: h * 0.35), CGPoint(x: w * 0.3, y: h * 0.7),
                    CGPoint(x: w * 0.42, y: h + 10)), with: .color(road), lineWidth: 10)
            g.stroke(
                curve(
                    CGPoint(x: -10, y: h * 0.82), CGPoint(x: w * 0.25, y: h * 0.7), CGPoint(x: w * 0.45, y: h * 1.02),
                    CGPoint(x: w * 0.65, y: h * 0.82), CGPoint(x: w * 0.8, y: h * 0.68), CGPoint(x: w * 0.9, y: h * 0.6),
                    CGPoint(x: w + 10, y: h * 0.64)), with: .color(Color(rgb: 0x2B9AD6)), style: StrokeStyle(lineWidth: 4, lineCap: .round))
            let stop = CGPoint(x: w * 0.6, y: h * 0.84)
            let you = CGPoint(x: w * 0.47, y: h * 0.36)
            var walk = Path()
            walk.move(to: you)
            walk.addLine(to: stop)
            g.stroke(walk, with: .color(.brand), style: StrokeStyle(lineWidth: 2.5, dash: [4, 4]))
            func dot(_ c: CGPoint, _ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)) }
            g.fill(dot(stop, 6), with: .color(.white))
            g.stroke(dot(stop, 6), with: .color(.ink), lineWidth: 2)
            g.fill(dot(you, 22), with: .color(Color(rgb: 0x3B82F6).opacity(0.18)))
            g.fill(dot(you, 9), with: .color(.white))
            g.fill(dot(you, 6.5), with: .color(Color(rgb: 0x3B82F6)))
        }
        .frame(height: 110)
        .background(Color.surface2)
    }
}
