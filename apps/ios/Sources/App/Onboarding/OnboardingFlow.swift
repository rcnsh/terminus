import SwiftUI

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
            .frame(maxWidth: columnWidth)
            .frame(maxWidth: .infinity)
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
        .task { if model.profile == nil { await model.load() } }
    }

    @ViewBuilder private var loading: some View {
        if let m = model.message {
            VStack(spacing: 16) {
                Text(m)
                    .foregroundStyle(Color.bad)
                    .multilineTextAlignment(.center)
                    .announced(m)
                Button(L("Try again")) { Task { await model.load() } }
                    .buttonStyle(ChipButtonStyle(filled: true))
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    SkeletonLine(font: .largeTitle.bold(), fraction: 0.75)
                    SkeletonLine(font: .body, fraction: 0.9).padding(.top, 6)
                    SkeletonLine(font: .body, fraction: 0.6).padding(.bottom, 20)
                }
                SetupTilesSkeleton()
            }
            .shimmering()
            .skeletonSpoken()
            .column(gutter: 20)
            .padding(.top, 14)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
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
                .column(gutter: 20)
                .padding(.top, 14)
                .padding(.bottom, 24)
            }
            .environment(\.setupScroll, proxy)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            buttons
                .column(gutter: 20)
                .padding(.top, 10)
                .padding(.bottom, 8)
                .background(Color.page)
        }
        .onAppear { titleFocused = true }
    }
}

struct SetupButtons: View {
    var back: (() -> Void)?
    var nextLabel = L("Continue")
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

struct SetupTilesSkeleton: View {
    var body: some View {
        SetupTwoColumns(items: Array(0..<6)) { i in
            VStack(alignment: .leading, spacing: 3) {
                SkeletonLine(font: .subheadline.weight(.semibold), fraction: SkeletonWidths.name(i))
                SkeletonLine(font: .footnote, fraction: SkeletonWidths.sub(i))
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .frame(minHeight: 64)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
        }
        .skeletonSpoken()
    }
}

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
    var setupScroll: ScrollViewProxy? {
        get { self[SetupScrollKey.self] }
        set { self[SetupScrollKey.self] = newValue }
    }
}
