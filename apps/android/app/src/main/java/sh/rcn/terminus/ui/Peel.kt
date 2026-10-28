package sh.rcn.terminus.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Android's own back animation between two screens (AOSP's DefaultCrossActivityBackAnimation, in WindowManager Shell's back/), for a page
 * peeled off the one under it. Two phases, each with its own curve, so neither waits on the other:
 * - held: the closing page follows the swipe's progress through [BACK_GESTURE], shrinking to [MAX_SCALE]; from the left edge it leans right
 *   to within [MARGIN_DP] of the far edge, from the right it stays centred. The page under it sits [ENTER_OFFSET_DP] to the left and
 *   shrinks with it. Both follow the finger up or down a little.
 * - let go: [RELEASE_MS] of [EMPHASIZED] from wherever the card is. The page under grows back into place; the card moves on and is gone in
 *   a fifth of that (its alpha is 1 − 5t), so even a flick lands at once.
 */
internal object Peel {
    const val MAX_SCALE = 0.9f
    const val MARGIN_DP = 8f
    const val ENTER_OFFSET_DP = 96f
    const val RELEASE_MS = 450

    /** The dim over the page under the card, as Android's: light and dark. */
    const val DIM_LIGHT = 0.2f
    const val DIM_DARK = 0.8f

    /** The card's corners and shadow come in over the first fifth of the swipe, so a straight-edged page never jumps to round. */
    const val ROUND_BY = 0.2f

    /** Android's BackGestureInterpolator: quick to answer the thumb, settling toward the end. */
    val BACK_GESTURE: Easing = CubicBezierEasing(0.1f, 0.1f, 0f, 1f)

    private val ACCELERATE = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
    private val DECELERATE = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)

    /**
     * Android's emphasized curve (fast_out_extra_slow_in), a path of two cubics: emphasized-accelerate up to (1/6, 0.4), then
     * emphasized-decelerate to the end.
     */
    val EMPHASIZED: Easing = Easing { t ->
        if (t < 1f / 6f) 0.4f * ACCELERATE.transform(t * 6f) else 0.4f + 0.6f * DECELERATE.transform((t - 1f / 6f) * 1.2f)
    }

    /** Where a page is drawn: scaled about its centre, then moved, at [alpha]. */
    data class Place(val scale: Float, val x: Float, val y: Float, val alpha: Float = 1f)

    /**
     * One frame: the closing [card], the page [under] it, the dim over [under] (0 to 1 of its most), and how round the card's and the page
     * under's corners are (0 to 1). The page under squares up again as it returns.
     */
    data class Frame(val card: Place, val under: Place, val dim: Float, val round: Float, val underRound: Float = round)

    /**
     * The frame for a swipe at [progress] (0 to 1, as Android reports it) from [fromRight] or the left, the finger [dy] px below where it
     * started, on a page [width] by [height] px. [released] is how far the release has run (0 to 1, linear), 0 while it's held. [margin]
     * and [enterOffset] are [MARGIN_DP] and [ENTER_OFFSET_DP] in px.
     */
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
        // The card's rect slides from full size to its target: centred, then
        // right against the far edge but for the margin (left-edge swipes).
        val lean = if (fromRight) 0f else p * max(0f, width * (1f - MAX_SCALE) / 2f - margin)
        val y = shiftY(dy, height, scale, margin)
        val held = Frame(Place(scale, lean, y), Place(scale, -enterOffset, y), dim = 1f, round = min(1f, progress / ROUND_BY))
        if (released <= 0f) return held

        val t = released.coerceAtMost(1f)
        val e = EMPHASIZED.transform(t)
        // The card leaves from its own left edge, a further enterOffset on, back at full size; the page under returns to where it was.
        val left = lean + width * (1f - scale) / 2f
        return Frame(
            card = Place(lerp(scale, 1f, e), lerp(lean, left + enterOffset, e), lerp(y, 0f, e), alpha = max(0f, 1f - t * 5f)),
            under = Place(lerp(scale, 1f, e), lerp(-enterOffset, 0f, e), lerp(y, 0f, e)),
            dim = 1f - t,
            round = held.round,
            underRound = held.round * (1f - e),
        )
    }

    /** Up or down with the finger, decelerating, never nearer the top or bottom than the margin. */
    private fun shiftY(dy: Float, height: Float, scale: Float, margin: Float): Float {
        if (height <= 0f || dy == 0f) return 0f
        val ratio = min(height / 2f, abs(dy)) / (height / 2f)
        val eased = 1f - (1f - ratio) * (1f - ratio)
        val room = max(0f, (height - height * scale) / 2f - margin)
        return room * eased * (if (dy < 0f) -1f else 1f)
    }

    private fun lerp(a: Float, b: Float, t: Float) = a + (b - a) * t
}
