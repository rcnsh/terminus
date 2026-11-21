package sh.rcn.terminus.ui

object Fling {
    fun rubber(dy: Float, limit: Float): Float {
        if (dy >= 0f) return dy
        val up = -dy
        return -(up * limit) / (limit + up)
    }

    fun unrubber(y: Float, limit: Float): Float {
        if (y >= 0f) return y
        return y * limit / (limit + y.coerceAtLeast(-limit * 0.999f))
    }

    fun rubberSpeed(speed: Float, dy: Float, limit: Float): Float {
        if (dy >= 0f) return speed
        val give = limit / (limit - dy)
        return speed * give * give
    }

    fun backSpeed(speed: Float, dy: Float, limit: Float, omega: Float): Float {
        val v = rubberSpeed(speed, dy, limit)
        if (v >= 0f) return v
        val room = (limit * 0.9f + rubber(dy, limit)).coerceAtLeast(0f)
        return v.coerceAtLeast(-room * omega)
    }
}
