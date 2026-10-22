import SwiftUI

/// The setup for a new account, one step at a time, the same four things the
/// account page asks: home, timetable, pace, then notifications and location.
/// Each step saves as it goes and can be skipped; so can the lot.
///
/// Each step shows what its choice does (your stops' signs, your week, a lap of
/// a track at your pace, the alert you'd get), and its buttons stay at the foot
/// of the screen, under the thumb, while the step scrolls above them.
struct OnboardingFlow: View {
    @State private var model = OnboardingModel()

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 4) {
                SetupStepLine(step: model.step)
                Button(L("Skip setup")) { model.finish() }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .padding(.top, -8)
                    .accessibilityIdentifier("setup.skipAll")
            }
            .padding(.leading, 8)
            .padding(.trailing, 16)
            .padding(.top, 12)
            .padding(.bottom, 4)
            if model.profile == nil {
                loading
            } else {
                page
                    .id(model.step)
                    .transition(
                        .asymmetric(
                            insertion: .move(edge: model.forward ? .trailing : .leading),
                            removal: .move(edge: model.forward ? .leading : .trailing)
                        ).combined(with: .opacity))
            }
        }
        .animation(.snappy(duration: 0.32), value: model.step)
        .background(Color.page.ignoresSafeArea())
        .statusBar(light: nil)
        .task { if model.profile == nil { await model.load() } }
    }

    @ViewBuilder private var loading: some View {
        VStack(spacing: 16) {
            if let m = model.message {
                Text(m)
                    .foregroundStyle(Color.bad)
                    .multilineTextAlignment(.center)
                    .announced(m)
                Button(L("Try again")) { Task { await model.load() } }
                    .buttonStyle(ChipButtonStyle(filled: true))
            } else {
                ProgressView()
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var page: some View {
        switch model.step {
        case 0: SetupHomeStep(model: model)
        case 1: SetupClassesStep(model: model)
        case 2: SetupPaceStep(model: model)
        default: SetupAlertsStep(model: model)
        }
    }
}

/// Where you are in setup, drawn as a route: a stop per step, the line done so
/// far in the accent, the stop you're at ringed, and each stop's name under it.
private struct SetupStepLine: View {
    let step: Int
    private var names: [String] { [L("Home"), L("Classes"), L("Pace"), L("Alerts")] }

    var body: some View {
        let n = OnboardingModel.steps
        VStack(spacing: 6) {
            Canvas { g, size in
                let cell = size.width / CGFloat(n)
                let y = size.height / 2
                func x(_ i: Int) -> CGFloat { cell * CGFloat(i) + cell / 2 }
                func line(_ from: Int, _ to: Int, _ color: Color) {
                    var p = Path()
                    p.move(to: CGPoint(x: x(from), y: y))
                    p.addLine(to: CGPoint(x: x(to), y: y))
                    g.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: 4, lineCap: .round))
                }
                func circle(_ i: Int, _ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: x(i) - r, y: y - r, width: r * 2, height: r * 2)) }
                line(0, n - 1, .line)
                if step > 0 { line(0, step, .brand) }
                for i in 0..<n {
                    if i < step {
                        g.fill(circle(i, 6), with: .color(.brand))
                    } else if i == step {
                        g.fill(circle(i, 8.5), with: .color(.page))
                        g.stroke(circle(i, 6.5), with: .color(.brand), lineWidth: 5)
                    } else {
                        g.fill(circle(i, 6), with: .color(.page))
                        g.stroke(circle(i, 4.5), with: .color(.lineStrong), lineWidth: 3)
                    }
                }
            }
            .frame(height: 20)
            HStack(spacing: 0) {
                ForEach(Array(names.enumerated()), id: \.offset) { i, name in
                    Text(name)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(i == step ? Color.ink : Color.muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Step %@ of %@", "\(step + 1)", "\(OnboardingModel.steps)") + ", " + names[min(step, names.count - 1)])
        .accessibilityIdentifier("setup.progress")
    }
}

/// A step: what it asks, scrolling, and its buttons pinned under it.
struct SetupPage<Content: View, Buttons: View>: View {
    let title: String
    let sub: String
    let message: String?
    @ViewBuilder var buttons: Buttons
    @ViewBuilder var content: Content
    @AccessibilityFocusState private var titleFocused: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(title)
                        .font(.largeTitle.bold())
                        .foregroundStyle(Color.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityFocused($titleFocused)
                    Text(sub)
                        .font(.body)
                        .foregroundStyle(Color.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 6)
                        .padding(.bottom, 20)
                    content
                    if let message {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(Color.bad)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 14)
                            .announced(message)
                            .accessibilityIdentifier("setup.message")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
            .environment(\.setupScroll, proxy)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            buttons
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 8)
                .background(Color.page)
        }
        // A screen reader's focus moves to the new step's title.
        .onAppear { titleFocused = true }
    }
}

/// Back on the left; the step's one big button filling the rest. With nothing
/// to continue with yet, the big button is the skip, and says so.
struct SetupButtons: View {
    var back: (() -> Void)?
    var nextLabel = L("Continue")
    /// Set when there's nothing to continue with: the big button skips, outlined.
    var skip: String?
    var enabled = true
    var busy = false
    let next: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if let back {
                Button(L("Back"), action: back)
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 52)
                    .accessibilityIdentifier("setup.back")
            }
            if let skip {
                Button(skip, action: next)
                    .buttonStyle(.secondary)
                    .accessibilityIdentifier("setup.later")
            } else {
                Button(action: next) {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(Color.onBrand) }
                        Text(nextLabel)
                    }
                }
                .buttonStyle(.primary)
                .disabled(!enabled)
                .accessibilityIdentifier("setup.next")
            }
        }
    }
}

/// A setting's explanation, under it.
struct SetupHint: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Color.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// One choice of several, as a tile: outlined, or filled with the accent's soft
/// colour and edged in it when chosen, with a tick in the corner.
struct SetupChoiceTile<Content: View>: View {
    let selected: Bool
    var id: String?
    let action: () -> Void
    @ViewBuilder var content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        Button(action: action) {
            VStack(alignment: .leading, spacing: 3) { content }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.trailing, selected ? 22 : 0)
                .padding(.horizontal, 13)
                .padding(.vertical, 11)
                .frame(minHeight: 64)
                .background(selected ? Color.brandSoft : Color.surface, in: shape)
                .overlay(shape.strokeBorder(selected ? Color.brand : Color.line, lineWidth: selected ? 2 : 1))
                .overlay(alignment: .topTrailing) {
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundStyle(.white, Color.brand)
                            .padding(10)
                    }
                }
                .contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier(id ?? "")
    }
}

/// Laid out two to a row, each row as tall as its taller tile, the last alone if it's odd.
struct SetupTwoColumns<Item: Hashable, Cell: View>: View {
    let items: [Item]
    var gap: CGFloat = 8
    @ViewBuilder let cell: (Item) -> Cell

    var body: some View {
        Grid(horizontalSpacing: gap, verticalSpacing: gap) {
            ForEach(Array(stride(from: 0, to: items.count, by: 2)), id: \.self) { i in
                GridRow {
                    cell(items[i]).frame(maxHeight: .infinity)
                    if i + 1 < items.count {
                        cell(items[i + 1]).frame(maxHeight: .infinity)
                    } else {
                        Color.clear.gridCellUnsizedAxes([.horizontal, .vertical])
                    }
                }
            }
        }
    }
}

private struct SetupScrollKey: EnvironmentKey { static var defaultValue: ScrollViewProxy? { nil } }

extension EnvironmentValues {
    /// The setup step's scroll view, for a search to bring its results into view above the keyboard.
    var setupScroll: ScrollViewProxy? {
        get { self[SetupScrollKey.self] }
        set { self[SetupScrollKey.self] = newValue }
    }
}
