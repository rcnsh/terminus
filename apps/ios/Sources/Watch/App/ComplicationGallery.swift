#if DEBUG
    import SwiftUI
    import WidgetKit

    /// Each complication family drawn from the plan as kept, at its size on
    /// a face, for screenshots (TERMINUS_SHOW=complications): a face can't
    /// be edited from a script. Debug builds only.
    struct ComplicationGallery: View {
        var body: some View {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                let paired = TokenStore.read() != nil
                let g = Glance.of(
                    paired: paired, answer: paired ? WidgetStore.plan()?.0 : nil, error: WidgetStore.error,
                    now: ctx.date.addingTimeInterval(ServerClock.skew))
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        caption("inline")
                        InlineGlance(g: g).font(.system(size: 15, weight: .semibold)).lineLimit(1).frame(maxWidth: .infinity)
                        caption("circular")
                        CircularGlance(g: g).frame(width: 50, height: 50).frame(maxWidth: .infinity)
                        caption("rectangular")
                        RectangularGlance(g: g).padding(8).frame(height: 76)
                            .background(Color.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
            }
        }

        private func caption(_ s: String) -> some View {
            Text(verbatim: s).font(.caption2).foregroundStyle(.secondary)
        }
    }
#endif
