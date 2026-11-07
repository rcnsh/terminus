import SwiftUI

/// The window's width, as the layout reads it (docs/agents/window-sizes.md,
/// ADR 0015): the phone layout under 600, that layout in the 560 column to
/// 799, two panes from 800. Read live from the window's geometry, so a fold,
/// a rotation, Split View or a Stage Manager resize changes it at once; the
/// device, its idiom and the orientation never decide it.
enum WindowWidth: Comparable {
    case narrow, medium, wide

    static let mediumFrom: CGFloat = 600
    static let wideFrom: CGFloat = 800

    init(_ width: CGFloat) {
        self = width >= Self.wideFrom ? .wide : width >= Self.mediumFrom ? .medium : .narrow
    }

    /// Two panes on Now, Stops and Settings.
    var panes: Bool { self == .wide }
}

/// The leading pane of Stops and Settings when wide: the list a page opens from.
let listPaneWidth: CGFloat = 360

/// How wide Now's words go when wide, the card and Today side by side in it.
let wideColumnWidth: CGFloat = 1040

extension EnvironmentValues {
    /// The window's width class, set once at the root from its geometry.
    @Entry var windowWidth = WindowWidth.narrow
    /// The first page in a wide detail pane: nothing under it to go back to.
    @Entry var paneRoot = false
    /// In a wide list pane, 360 wide: rows put their values under their names.
    @Entry var listPane = false
    /// Side by side, the panes' bands of sky, so their horizons meet.
    @Entry var paneBands: PaneBands?
}

/// Where each band of sky in a pair of panes would end on its own (its top
/// at rest, unscrolled, and its height); each is drawn on
/// down to where the lowest ends, so the two horizons meet. A page under a
/// navigation bar starts lower than the list beside it.
@MainActor @Observable
final class PaneBands {
    /// Scrolling reports each band's frame every frame: only a change to a
    /// top or to the bottom redraws the bands.
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

    /// How tall the band with this top is drawn, to end with the lowest.
    func height(top: CGFloat?) -> CGFloat? { top.map { bottom - $0 } }

    func top(_ id: UUID) -> CGFloat? { tops[id] }

    private func settle() {
        let b = heights.compactMap { id, h in tops[id].map { $0 + h } }.max() ?? 0
        if b != bottom { bottom = b }
    }
}

extension View {
    /// Reads the window's width from this view's geometry (safe areas
    /// included, so the Duo's side status bar counts) into `windowWidth`.
    func readsWindowWidth() -> some View { modifier(ReadsWindowWidth()) }

    /// A list row marked as the one open beside it: the accent at 12% inside
    /// the row, its corners rounded, nothing else, and said as chosen.
    func chosenRow(_ chosen: Bool) -> some View {
        background {
            if chosen { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.chosen).padding(4) }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    /// A card in a list marked as the one open beside it: the same tint over the whole card.
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
    /// What's open beside a list: the accent at about 12%, as the Android and web clients mark it.
    static let chosen = Color.brand.opacity(0.12)
}

private struct ReadsWindowWidth: ViewModifier {
    @State private var width = WindowWidth.narrow

    func body(content: Content) -> some View {
        content
            .onGeometryChange(for: WindowWidth.self) {
                WindowWidth($0.size.width + $0.safeAreaInsets.leading + $0.safeAreaInsets.trailing)
            } action: {
                width = $0
            }
            .environment(\.windowWidth, width)
    }
}

/// List and detail, side by side when wide: `list` in a pane 360 wide on the
/// leading side, a hairline, then `detail` filling the rest. Each pane keeps
/// its own sky band at the top, so the sky reads across the window.
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
    /// The list pane's root, inside its navigation stack. The stack hands
    /// it the whole window's trailing inset (the Duo's status bar and tab
    /// rail), though the pane is nowhere near that edge.
    func listPaneRoot() -> some View { ignoresSafeArea(.container, edges: .trailing) }
}

/// A wide detail pane with nothing open: its own band of the sky at the
/// top, so the sky reads across the window, and what to do, centred, muted.
struct PaneEmpty: View {
    let text: String

    var body: some View {
        VStack(spacing: 0) {
            // As tall as the list's beside it (PaneBands).
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
    /// A sheet's content (report a problem, go later, sign in, the pickers):
    /// from 600 wide, the platform's centred sheet at most 560 wide; `fits`,
    /// as tall as what's in it, else the form sheet's height (a list). On a
    /// phone, the sheet from the bottom as it was.
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

/// The 560 column's width, and as tall as the sheet's content is at that width.
@available(iOS 18, *)
private struct FitsContent: PresentationSizing {
    func proposedSize(for root: PresentationSizingRoot, context: PresentationSizingContext) -> ProposedViewSize {
        let size = root.sizeThatFits(ProposedViewSize(width: columnWidth, height: nil))
        return ProposedViewSize(width: columnWidth, height: size.height)
    }
}

/// A sheet's page that scrolls on a phone; from 600 wide, its own height when
/// that fits (so a centred sheet can be sized to it), scrolling only when not.
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
