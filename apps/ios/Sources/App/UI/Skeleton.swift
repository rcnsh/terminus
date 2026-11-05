import SwiftUI

/// Placeholder shapes for content on its way: bars where the words will be,
/// in the loaded layout's own boxes, so nothing moves when the answer lands.
/// As the web's .sk.
extension Color {
    /// A bar on the ground: a shade off the surface, darker by day, lighter at night.
    static let skeleton = themed(0xE6E2DD, 0x2A2724)
    /// The shimmer's highlight over it.
    static let skeletonShine = themed(0xF6F4F1, 0x3B3732)
}

/// One bar. In the sky it's the sky's ink, faint, so the hour's colours show
/// through; on the ground, the skeleton grey. Inside a view that's
/// `shimmering`, it draws its slice of that view's one wave.
struct SkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat?
    var radius: CGFloat = 5
    @Environment(\.inks) private var inks
    @Environment(\.shimmerAt) private var shimmerAt
    @Environment(\.skeletonShown) private var shown

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape
            .fill(inks.inSky ? inks.ink.opacity(0.13) : Color.skeleton)
            .overlay {
                if let at = shimmerAt {
                    let shine = inks.inSky ? inks.ink.opacity(0.14) : Color.skeletonShine
                    GeometryReader { g in
                        LinearGradient(colors: [.clear, shine, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: ShimmerWave.band)
                            .offset(x: at - g.frame(in: .global).minX)
                    }
                    .clipShape(shape)
                }
            }
            .frame(width: width, height: height)
            .opacity(shown ? 1 : 0)
    }
}

/// A bar standing in for one line of text in `font`: as tall as the line,
/// the bar centred in it, `fraction` of the room wide (or `points` wide).
struct SkeletonLine: View {
    var font: Font = .body
    var fraction: CGFloat = 1
    var points: CGFloat?

    var body: some View {
        Text(verbatim: " ")
            .font(font)
            .hidden()
            .frame(maxWidth: points ?? .infinity, alignment: .leading)
            .overlay(alignment: .leading) {
                GeometryReader { g in
                    SkeletonBar(width: points ?? g.size.width * fraction, height: (g.size.height * 0.6).rounded())
                        .frame(height: g.size.height)
                }
            }
    }
}

/// Bar widths that vary from row to row, a fixed set rather than random, so a
/// list reads as names and not a barcode, and is the same on every draw.
enum SkeletonWidths {
    static let names: [CGFloat] = [0.7, 0.58, 0.64, 0.52, 0.66, 0.6]
    static let subs: [CGFloat] = [0.5, 0.62, 0.44, 0.56, 0.48, 0.4]
    static func name(_ i: Int) -> CGFloat { names[i % names.count] }
    static func sub(_ i: Int) -> CGFloat { subs[i % subs.count] }
}

extension View {
    /// One soft highlight sweeping left to right every 1.6 s across the bars
    /// inside, from this view's left edge to its right, however wide; one clock
    /// for all of them, and anything real inside (a badge) left alone. The bars
    /// wait 150 ms and fade in, so a quick answer never flashes grey; with
    /// Reduce Motion, they wait, then show, and don't sweep. `active` false:
    /// no sweep, for a view that only sometimes holds bars.
    func shimmering(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }

    /// A skeleton is one element to VoiceOver, saying what the screen says
    /// while it waits; its bars aren't read.
    func skeletonSpoken(_ label: String = L("Checking…")) -> some View {
        accessibilityElement(children: .ignore).accessibilityLabel(label)
    }
}

private struct ShimmerAtKey: EnvironmentKey { static let defaultValue: CGFloat? = nil }
private struct SkeletonShownKey: EnvironmentKey { static let defaultValue = true }

extension EnvironmentValues {
    /// Where the shimmer's highlight is on the screen now; nil when still.
    var shimmerAt: CGFloat? {
        get { self[ShimmerAtKey.self] }
        set { self[ShimmerAtKey.self] = newValue }
    }
    /// Whether bars show yet: off for the first moment inside a `shimmering` view.
    var skeletonShown: Bool {
        get { self[SkeletonShownKey.self] }
        set { self[SkeletonShownKey.self] = newValue }
    }
}

enum ShimmerWave {
    static let period: TimeInterval = 1.6
    /// The highlight's width.
    static let band: CGFloat = 220

    /// The band's left edge at `date`, in global coordinates: eased in and
    /// out, from off the left of `across` (the shimmering view's frame) to off its right.
    static func position(_ date: Date, across: CGRect) -> CGFloat {
        let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return across.minX - band + (across.width + band) * eased
    }
}

private struct Shimmer: ViewModifier {
    /// How long the bars wait before they show.
    static let hold: Duration = .milliseconds(150)
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var still
    /// The shimmering view's frame, so the wave crosses all of it however wide it is.
    @State private var frame = CGRect.zero
    @State private var shown = false

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: nil, paused: still || !active)) { tl in
            content
                .environment(\.shimmerAt, still || !active ? nil : ShimmerWave.position(tl.date, across: frame))
                .environment(\.skeletonShown, shown)
        }
        .onGeometryChange(for: CGRect.self) {
            $0.frame(in: .global)
        } action: {
            frame = $0
        }
        .task {
            try? await Task.sleep(for: Self.hold)
            withAnimation(still ? nil : .easeOut(duration: 0.2)) { shown = true }
        }
    }
}
