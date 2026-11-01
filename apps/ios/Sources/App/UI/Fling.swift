import CoreGraphics
import SwiftUI

/// The numbers behind the hand-made drags (the map's sheet, Today's rows),
/// apart from SwiftUI so they're tested (FlingTests): how far a drag past
/// its end still gives, where a flick is heading, and a spring that carries
/// on at the finger's speed when it lets go.
enum Fling {
    /// Where something is drawn for a drag of `dy` (down positive) that may
    /// only go down: with the finger going down; going up, less and less,
    /// never past `limit`.
    static func rubber(_ dy: CGFloat, limit: CGFloat) -> CGFloat {
        if dy >= 0 { return dy }
        let up = -dy
        return -(up * limit) / (limit + up)
    }

    /// How fast something drawn at `rubber(dy, limit:)` moves when the finger
    /// moves at `speed`: as fast going down, ever slower the further up.
    static func rubberSpeed(_ speed: CGFloat, at dy: CGFloat, limit: CGFloat) -> CGFloat {
        guard dy < 0 else { return speed }
        let give = limit / (limit - dy)
        return speed * give * give
    }

    /// How much further a flick at `speed` (points a second) would carry,
    /// decaying as a quick scroll does: where it's heading, not where the finger stopped.
    static func project(_ speed: CGFloat, rate: CGFloat = 0.99) -> CGFloat {
        speed / 1000 * rate / (1 - rate)
    }

    /// A spring with no bounce from `from` to `to` that starts at the
    /// finger's `speed` (points a second), so letting go leaves no seam.
    static func spring(speed: CGFloat, from: CGFloat, to: CGFloat) -> Animation {
        .interpolatingSpring(duration: 0.3, bounce: 0, initialVelocity: relative(speed: speed, from: from, to: to))
    }

    /// SwiftUI takes a spring's starting speed as a share of the distance
    /// left a second: 0 when there's next to none left, and never wild.
    static func relative(speed: CGFloat, from: CGFloat, to: CGFloat) -> Double {
        let span = to - from
        guard abs(span) > 1 else { return 0 }
        return Double(min(max(speed / span, -20), 20))
    }
}
