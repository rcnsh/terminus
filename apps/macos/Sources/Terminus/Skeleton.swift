import AppKit
import SwiftUI

extension Color {
    static let skeleton = skeletonThemed(light: 0xD8D4CF, dark: 0x3A3632)
    static let skeletonShine = skeletonThemed(light: 0xEAE7E3, dark: 0x4B4640)

    private static func skeletonThemed(light: UInt32, dark: UInt32) -> Color {
        Color(
            nsColor: NSColor(name: nil) { appearance in
                let v = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
                return NSColor(
                    srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1
                )
            })
    }
}

struct SkeletonBar: View {
    var width: CGFloat?
    var height: CGFloat?
    var radius: CGFloat = 4
    @Environment(\.shimmerAt) private var shimmerAt
    @Environment(\.skeletonShown) private var shown

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        shape.fill(Color.skeleton)
            .overlay {
                if let at = shimmerAt {
                    GeometryReader { g in
                        LinearGradient(colors: [.clear, Color.skeletonShine, .clear], startPoint: .leading, endPoint: .trailing)
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

struct SkeletonLine: View {
    var font: Font = .callout
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

enum SkeletonWidths {
    static let names: [CGFloat] = [0.7, 0.58, 0.64, 0.52, 0.66, 0.6]
    static let subs: [CGFloat] = [0.5, 0.62, 0.44, 0.56, 0.48, 0.4]
    static func name(_ i: Int) -> CGFloat { names[i % names.count] }
    static func sub(_ i: Int) -> CGFloat { subs[i % subs.count] }
}

extension View {
    func shimmering(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }

    func skeletonSpoken(_ label: String = L("Checking…")) -> some View {
        accessibilityElement(children: .ignore).accessibilityLabel(label)
    }
}

private struct ShimmerAtKey: EnvironmentKey { static let defaultValue: CGFloat? = nil }
private struct SkeletonShownKey: EnvironmentKey { static let defaultValue = true }

extension EnvironmentValues {
    var shimmerAt: CGFloat? {
        get { self[ShimmerAtKey.self] }
        set { self[ShimmerAtKey.self] = newValue }
    }
    var skeletonShown: Bool {
        get { self[SkeletonShownKey.self] }
        set { self[SkeletonShownKey.self] = newValue }
    }
}

enum ShimmerWave {
    static let period: TimeInterval = 1.6
    static let band: CGFloat = 160

    static func position(_ date: Date, across: CGRect) -> CGFloat {
        let t = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return across.minX - band + (across.width + band) * eased
    }
}

private struct Shimmer: ViewModifier {
    static let hold: Duration = .milliseconds(150)
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var still
    @State private var frame = CGRect.zero
    @State private var shown = false
    @Environment(\.fixedNow) private var fixedNow

    func body(content: Content) -> some View {
        TimelineView(.animation(minimumInterval: nil, paused: still || !active)) { tl in
            content
                .environment(\.shimmerAt, still || !active ? nil : ShimmerWave.position(tl.date, across: frame))
                .environment(\.skeletonShown, shown || fixedNow != nil)
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
