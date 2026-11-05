import SwiftUI

/// Now before its first answer: the card's shape in bars, the trip's top in
/// the sky (where to, "Leave in", by when and Live) and its steps on the
/// ground, so the answer fills in without the page moving. No buttons: one
/// that can't be pressed yet would read as broken.
struct NowSkeletonHead: View {
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            SkeletonLine(font: .body, fraction: 0.62)
            SkeletonLine(font: .system(size: 34 * scale, weight: .heavy), fraction: 0.78).padding(.vertical, 2)
            HStack(spacing: 8) {
                SkeletonLine(font: .body, fraction: 0.6)
                SkeletonBar(width: 58, height: 24, radius: 12)
                Spacer(minLength: 0)
            }
        }
        .shimmering()
        .skeletonSpoken()
        .accessibilityIdentifier("now.skeleton")
    }
}

/// The ground under it: the road's line, then three steps of the trip.
struct NowSkeletonGround: View {
    @ScaledMetric(relativeTo: .subheadline) private var timeWidth: CGFloat = 72

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                SkeletonBar(width: 30, height: 20)
                SkeletonLine(font: .body, fraction: 0.55)
            }
            .padding(.top, -12)
            VStack(alignment: .leading, spacing: 0) {
                step(.walk, title: 0.3, below: 0.38)
                step(.ride, title: 0.42, below: 0.34)
                step(.end, title: 0.34, below: 0.3)
            }
            .padding(.top, 18)
            SkeletonLine(font: .footnote, fraction: 0.64).padding(.top, 8)
        }
        .shimmering()
        .accessibilityHidden(true)
    }

    /// The steps' kinds: the walk to the stop, the ride, where you're going.
    private enum Kind { case walk, ride, end }

    /// One point of the steps, in the boxes StepsLine's LinePoint has for its kind.
    private func step(_ kind: Kind, title: CGFloat, below: CGFloat) -> some View {
        let rail = kind != .end
        let ride = kind == .ride
        return HStack(alignment: .top, spacing: 0) {
            SkeletonLine(font: .subheadline.weight(.semibold), points: 42)
                .frame(width: timeWidth, alignment: .leading)
                .padding(.top, 3)
            VStack(spacing: 0) {
                SkeletonBar(width: 14, height: 14, radius: 7).frame(width: 20, height: 20).padding(.top, 4)
                if rail { SkeletonBar(width: 3, height: nil, radius: 1.5).frame(maxHeight: .infinity).padding(.vertical, 3) }
            }
            .frame(width: 26)
            .frame(maxHeight: .infinity, alignment: .top)
            VStack(alignment: .leading, spacing: 0) {
                SkeletonLine(font: .headline, fraction: title)
                SkeletonLine(font: .footnote, fraction: below).padding(.top, ride ? 14 : 6).padding(.bottom, ride ? 14 : 0)
            }
            .padding(.leading, 10)
            .padding(.top, 1)
            .padding(.bottom, rail ? 14 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
