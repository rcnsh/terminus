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
}
