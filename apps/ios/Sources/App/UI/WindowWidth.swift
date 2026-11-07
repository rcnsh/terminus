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
}

extension View {
    /// Reads the window's width from this view's geometry (safe areas
    /// included, so the Duo's side status bar counts) into `windowWidth`.
    func readsWindowWidth() -> some View { modifier(ReadsWindowWidth()) }

    /// A list row marked as the one open beside it: a rounded tint of the
    /// accent inside the row, as a sidebar marks its chosen row, and said as chosen.
    func chosenRow(_ chosen: Bool) -> some View {
        background {
            if chosen {
                RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.brandSoft).padding(4)
            }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
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

    var body: some View {
        HStack(spacing: 0) {
            list.frame(width: listPaneWidth)
            Rectangle().fill(Color.line).frame(width: 1).ignoresSafeArea(edges: .vertical)
            detail.frame(maxWidth: .infinity)
        }
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
    /// As tall as the list's band beside it, when known, so the horizon lines up.
    var band: CGFloat?

    /// What a moon-low band adds under its content: the moon's line and the hills.
    private static let bandFixed: CGFloat = 24 + 52

    var body: some View {
        VStack(spacing: 0) {
            SkyBand(moonLow: true) { Color.clear.frame(height: max(0, (band ?? 128) - Self.bandFixed)) }
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
