package sh.rcn.terminus

import kotlin.math.pow

/**
 * The ink for words and marks on a service's colour: white or near-black,
 * whichever reads better on it (WCAG contrast). White on the yellow A2 or
 * the blue K was under 3.5:1. Plain ARGB, so the app, the widgets and the
 * tests share it.
 */
object Ink {
    const val WHITE = 0xFFFFFFFFL
    const val DARK = 0xFF1C1917L

    /** [WHITE] or [DARK] on [argb], whichever has more contrast. */
    fun on(argb: Long): Long = if (contrast(argb, WHITE) >= contrast(argb, DARK)) WHITE else DARK

    /** WCAG contrast ratio between two colours, 1 to 21. */
    fun contrast(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }

    /** WCAG relative luminance of an sRGB colour. */
    fun luminance(argb: Long): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF) / 255.0
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }
}
