package sh.rcn.terminus.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal object Peel {
    const val MAX_SCALE = 0.9f
    const val MARGIN_DP = 8f
    const val ENTER_OFFSET_DP = 96f
    const val RELEASE_MS = 450

    const val DIM_LIGHT = 0.2f
    const val DIM_DARK = 0.8f

    const val ROUND_BY = 0.2f

    val BACK_GESTURE: Easing = CubicBezierEasing(0.1f, 0.1f, 0f, 1f)

    private val ACCELERATE = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    private val DECELERATE = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)

    val EMPHASIZED: Easing = Easing { t ->
        if (t < 1f / 6f) 0.4f * ACCELERATE.transform(t * 6f) else 0.4f + 0.6f * DECELERATE.transform((t - 1f / 6f) * 1.2f)
    }

    data class Place(val scale: Float, val x: Float, val y: Float, val alpha: Float = 1f)

    data class Frame(val card: Place, val under: Place, val dim: Float, val round: Float, val underRound: Float = round)

    fun frame(
        progress: Float,
        fromRight: Boolean,
        dy: Float,
        width: Float,
        height: Float,
        margin: Float,
        enterOffset: Float,
        released: Float = 0f,
    ): Frame {
        val p = BACK_GESTURE.transform(progress.coerceIn(0f, 1f))
        val scale = 1f - p * (1f - MAX_SCALE)
        val lean = if (fromRight) 0f else p * max(0f, width * (1f - MAX_SCALE) / 2f - margin)
        val y = shiftY(dy, height, scale, margin)
        val held = Frame(Place(scale, lean, y), Place(scale, -enterOffset, y), dim = 1f, round = min(1f, progress / ROUND_BY))
        if (released <= 0f) return held

        val t = released.coerceAtMost(1f)
        val e = EMPHASIZED.transform(t)
        val left = lean + width * (1f - scale) / 2f
        return Frame(
            card = Place(lerp(scale, 1f, e), lerp(lean, left + enterOffset, e), lerp(y, 0f, e), alpha = max(0f, 1f - t * 5f)),
            under = Place(lerp(scale, 1f, e), lerp(-enterOffset, 0f, e), lerp(y, 0f, e)),
            dim = 1f - t,
            round = held.round,
            underRound = held.round * (1f - e),
        )
    }

    private fun shiftY(dy: Float, height: Float, scale: Float, margin: Float): Float {
        if (height <= 0f || dy == 0f) return 0f
        val ratio = min(height / 2f, abs(dy)) / (height / 2f)
        val eased = 1f - (1f - ratio) * (1f - ratio)
        val room = max(0f, (height - height * scale) / 2f - margin)
        return room * eased * (if (dy < 0f) -1f else 1f)
    }

    private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t
}
