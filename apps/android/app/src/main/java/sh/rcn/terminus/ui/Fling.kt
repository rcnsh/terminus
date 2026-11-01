package sh.rcn.terminus.ui

/**
 * The numbers behind the map sheet's drag, apart from Compose so they're tested (FlingTest), as on the iPhone (Fling.swift): how far a drag
 * past its end still gives, and how fast what's drawn there moves.
 */
object Fling {
    /**
     * Where something is drawn for a drag of [dy] (down positive) that may only go down: with the finger going down; going up, less and
     * less, never past [limit].
     */
    fun rubber(dy: Float, limit: Float): Float {
        if (dy >= 0f) return dy
        val up = -dy
        return -(up * limit) / (limit + up)
    }

    /** The drag that [rubber] draws at [y]: so something caught where it's drawn stays there under the finger. */
    fun unrubber(y: Float, limit: Float): Float {
        if (y >= 0f) return y
        return y * limit / (limit + y.coerceAtLeast(-limit * 0.999f))
    }

    /** How fast something drawn at [rubber] moves when the finger moves at [speed]: as fast going down, ever slower the further up. */
    fun rubberSpeed(speed: Float, dy: Float, limit: Float): Float {
        if (dy >= 0f) return speed
        val give = limit / (limit - dy)
        return speed * give * give
    }

    /**
     * The speed something let go at [dy] springs back to rest from: [rubberSpeed], but going up no faster than keeps a critically damped
     * spring of natural frequency [omega] (rad/s) inside 90% of the give, where [rubber] (and so [unrubber], for a catch) can still draw
     * it. From x with speed v it gets no further than |x + v / omega| beyond rest.
     */
    fun backSpeed(speed: Float, dy: Float, limit: Float, omega: Float): Float {
        val v = rubberSpeed(speed, dy, limit)
        if (v >= 0f) return v
        val room = (limit * 0.9f + rubber(dy, limit)).coerceAtLeast(0f)
        return v.coerceAtLeast(-room * omega)
    }
}
