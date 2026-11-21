import CoreGraphics
import SwiftUI

enum Fling {
    static func rubber(_ dy: CGFloat, limit: CGFloat) -> CGFloat {
        if dy >= 0 { return dy }
        let up = -dy
        return -(up * limit) / (limit + up)
    }

    static func rubberSpeed(_ speed: CGFloat, at dy: CGFloat, limit: CGFloat) -> CGFloat {
        guard dy < 0 else { return speed }
        let give = limit / (limit - dy)
        return speed * give * give
    }

    static func project(_ speed: CGFloat, rate: CGFloat = 0.99) -> CGFloat {
        speed / 1000 * rate / (1 - rate)
    }

    static func spring(speed: CGFloat, from: CGFloat, to: CGFloat) -> Animation {
        .interpolatingSpring(duration: 0.3, bounce: 0, initialVelocity: relative(speed: speed, from: from, to: to))
    }

    static func relative(speed: CGFloat, from: CGFloat, to: CGFloat) -> Double {
        let span = to - from
        guard abs(span) > 1 else { return 0 }
        return Double(min(max(speed / span, -20), 20))
    }
}
