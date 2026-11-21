import SwiftUI

enum WindowWidth: Comparable {
    case narrow, medium, wide

    static let mediumFrom: CGFloat = 600
    static let wideFrom: CGFloat = 800

    init(_ width: CGFloat) {
        self = width >= Self.wideFrom ? .wide : width >= Self.mediumFrom ? .medium : .narrow
    }

    var panes: Bool { self == .wide }

    static let shortBelow: CGFloat = 500

    static func short(_ height: CGFloat) -> Bool { height < shortBelow }

    static func phoneTurns(shortSide: CGFloat) -> Bool { shortSide >= 460 }
}

let listPaneWidth: CGFloat = 360

let wideColumnWidth: CGFloat = 1040

extension EnvironmentValues {
    @Entry var windowWidth = WindowWidth.narrow
    @Entry var windowShort = false
    @Entry var paneRoot = false
    @Entry var listPane = false
    @Entry var paneBands: PaneBands?
    @Entry var keyboardUp = false
}

private struct KeyboardRoom: ViewModifier {
    @Environment(\.keyboardUp) private var up

    func body(content: Content) -> some View { content.ignoresSafeArea(up ? [] : .keyboard) }
}

extension View {
    func keyboardRoom() -> some View { modifier(KeyboardRoom()) }
}

@MainActor @Observable
final class PaneBands {
    @ObservationIgnored private var heights: [UUID: CGFloat] = [:]
    private var tops: [UUID: CGFloat] = [:]
    private(set) var bottom: CGFloat = 0

    func set(_ id: UUID, top: CGFloat? = nil, height: CGFloat?) {
        guard let height else {
            heights[id] = nil
            tops[id] = nil
            return settle()
        }
        let moved = top != nil && tops[id] != top
        if moved { tops[id] = top }
        guard moved || heights[id] != height else { return }
        heights[id] = height
        settle()
    }

    func height(top: CGFloat?) -> CGFloat? { top.map { bottom - $0 } }

    func top(_ id: UUID) -> CGFloat? { tops[id] }

    private func settle() {
        let b = heights.compactMap { id, h in tops[id].map { $0 + h } }.max() ?? 0
        if b != bottom { bottom = b }
    }
}

extension View {
    func readsWindowWidth() -> some View { modifier(ReadsWindowWidth()) }

    func chosenRow(_ chosen: Bool) -> some View {
        background {
            if chosen { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.chosen).padding(4) }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    func chosenCard(_ chosen: Bool, radius: CGFloat) -> some View {
        overlay {
            if chosen {
                RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.chosen).allowsHitTesting(false)
            }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}

extension Color {
    static let chosen = Color.brand.opacity(0.12)
}

private struct ReadsWindowWidth: ViewModifier {
    @State private var width = WindowWidth.narrow
    @State private var short = false

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: WindowWidth.self) {
                WindowWidth($0.size.width + $0.safeAreaInsets.leading + $0.safeAreaInsets.trailing)
            } action: {
                width = $0
            }
            .onGeometryChange(for: Bool.self) {
                WindowWidth.short($0.size.height + $0.safeAreaInsets.top + $0.safeAreaInsets.bottom)
            } action: {
                short = $0
            }
            .onGeometryChange(for: CGSize.self) {
                $0.size
            } action: { _ in
                for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
                    scene.keyWindow?.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
                }
            }
            .environment(\.windowWidth, width)
            .environment(\.windowShort, short)
    }
}

struct ListDetail<List: View, Detail: View>: View {
    @ViewBuilder var list: List
    @ViewBuilder var detail: Detail
    @State private var bands = PaneBands()

    var body: some View {
        HStack(spacing: 0) {
            list.environment(\.listPane, true).frame(width: listPaneWidth)
            Rectangle().fill(Color.line).frame(width: 1).ignoresSafeArea(edges: .vertical)
            detail.frame(maxWidth: .infinity)
        }
        .environment(\.paneBands, bands)
    }
}

extension View {
    func listPaneRoot() -> some View { ignoresSafeArea(.container, edges: .trailing) }
}

struct PaneEmpty: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            SkyBand(moonLow: true) { Color.clear.frame(height: 0) }
            Text(text)
                .foregroundStyle(Color.muted)
                .multilineTextAlignment(.center)
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("pane-empty")
        }
        .background(Color.page)
        .toolbar(.hidden, for: .navigationBar)
    }
}

extension View {
    func centredSheet(fits: Bool = false) -> some View { modifier(CentredSheet(fits: fits)) }
}

private struct CentredSheet: ViewModifier {
    let fits: Bool
    @Environment(\.windowWidth) private var width

    func body(content: Content) -> some View {
        if #available(iOS 18, *), width != .narrow {
            if fits {
                content.presentationSizing(FitsContent())
            } else {
                content.frame(idealWidth: columnWidth, maxWidth: columnWidth).presentationSizing(
                    .form.fitted(horizontal: true, vertical: false))
            }
        } else {
            content
        }
    }
}

@available(iOS 18, *)
private struct FitsContent: PresentationSizing {
    func proposedSize(for root: PresentationSizingRoot, context: PresentationSizingContext) -> ProposedViewSize {
        let size = root.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil))
        return ProposedViewSize(width: columnWidth, height: size.height)
    }
}

struct SheetScroll<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.windowWidth) private var width

    var body: some View {
        if width == .narrow {
            ScrollView { content }
        } else {
            ViewThatFits(in: .vertical) {
                content
                ScrollView { content }
            }
        }
    }
}
