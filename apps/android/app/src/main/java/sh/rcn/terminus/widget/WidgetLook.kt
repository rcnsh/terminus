package sh.rcn.terminus.widget

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Canvas
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.inset
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.glance.unit.ColorProvider
import sh.rcn.terminus.ui.Phase
import sh.rcn.terminus.ui.Road
import sh.rcn.terminus.ui.horizon
import sh.rcn.terminus.ui.palette
import sh.rcn.terminus.ui.phaseAt
import sh.rcn.terminus.ui.skyBrush
import sh.rcn.terminus.ui.starsAndMoon
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.math.roundToInt

/**
 * The colours a widget's words are drawn in: over the sky ([WidgetLook.sky])
 * or on the ground under the horizon ([WidgetLook.ground]). Fixed rather than
 * following the phone's theme by themselves: the sky is a picture drawn for
 * one theme, so the words over it must change with it, at the same redraw.
 */
internal class Inks(
    val ink: ColorProvider,
    val muted: ColorProvider,
    val accent: ColorProvider,
    val late: ColorProvider,
    val good: ColorProvider,
    /** Behind a pill (Live, Seats) or a chip not chosen. */
    val chip: ColorProvider,
    /** Behind the chosen chip, and the words on it. */
    val chipOn: ColorProvider,
    val onChipOn: ColorProvider,
    val line: ColorProvider,
)

private fun fixed(argb: Long) = ColorProvider(Color(argb))
private fun fixed(c: Color) = ColorProvider(c)

/**
 * A widget's look at [phase] on a [dark] phone: Now's sky over the top in the
 * hour's colours, with its ink (the app's SkyInk), and the page's colours
 * under the horizon.
 */
internal class WidgetLook(val phase: Phase, val dark: Boolean) {
    val palette = palette(phase, dark)

    /** The page under the horizon, which the near hill is drawn in. */
    val page: Color = Color(if (dark) 0xFF0F0E0D else 0xFFFAFAF9)

    val sky: Inks = if (palette.lightInk) Inks(
        ink = fixed(0xFFF5F3F0), muted = fixed(0xFFE7E5E4), accent = fixed(0xFFFB923C), late = fixed(0xFFFECACA), good = fixed(0xFF86EFAC),
        chip = fixed(Color.Black.copy(alpha = 0.22f)), chipOn = fixed(0xFFF5F3F0), onChipOn = fixed(0xFF1C1917), line = fixed(Color.White.copy(alpha = 0.18f)),
    ) else Inks(
        ink = fixed(0xFF1C1917), muted = fixed(0xFF36312D), accent = fixed(0xFF9A3412), late = fixed(0xFF701818), good = fixed(0xFF14532D),
        chip = fixed(Color.White.copy(alpha = 0.65f)), chipOn = fixed(0xFF1C1917), onChipOn = fixed(0xFFFAFAF9), line = fixed(0x291C1917),
    )

    val ground: Inks = if (dark) Inks(
        ink = fixed(0xFFF2EFEB), muted = fixed(0xFFA39D97), accent = fixed(0xFFFB923C), late = fixed(0xFFF87171), good = fixed(0xFF4ADE80),
        chip = fixed(0xFF2C2926), chipOn = fixed(0xFFF2EFEB), onChipOn = fixed(0xFF1C1917), line = fixed(0xFF2C2926),
    ) else Inks(
        ink = fixed(0xFF1C1917), muted = fixed(0xFF6B6560), accent = fixed(0xFFC2410C), late = fixed(0xFFB91C1C), good = fixed(0xFF166534),
        chip = fixed(0xFFF0EEEB), chipOn = fixed(0xFF1C1917), onChipOn = fixed(0xFFFAFAF9), line = fixed(0xFFE7E5E2),
    )

    val pageColor: ColorProvider = fixed(page)

    companion object {
        /** The look now: the hour on the phone's clock, as Now's sky, and the phone's theme. */
        fun now(ctx: Context): WidgetLook {
            val dark = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            return WidgetLook(phaseAt(LocalDateTime.now().let { it.hour * 60 + it.minute }), dark)
        }
    }
}

/** Where the sky's hour changes, in minutes past midnight: dawn, day, the golden hour, dusk, night (phaseAt). */
private val PHASE_STARTS = intArrayOf(390, 510, 990, 1125, 1180)

/** Minutes from [minute] past midnight until the sky next changes, so the widget is redrawn then. */
internal fun minutesToNextPhase(minute: Int): Int {
    val next = PHASE_STARTS.firstOrNull { it > minute } ?: (PHASE_STARTS.first() + 24 * 60)
    return next - minute
}

/** When the sky next changes, on the phone's clock (epoch ms), from [now]. */
internal fun nextPhaseAt(now: Long, zone: ZoneId = ZoneId.systemDefault()): Long {
    val t = java.time.Instant.ofEpochMilli(now).atZone(zone)
    val minute = t.hour * 60 + t.minute
    return t.withSecond(0).withNano(0).plusMinutes(minutesToNextPhase(minute).toLong()).toInstant().toEpochMilli()
}

/**
 * Most pixels a sky is drawn with per dp: past this a gradient and some
 * hills look the same, and a widget's pictures share a memory budget.
 */
private const val MAX_SCALE = 2.5f

/**
 * Now's sky, [widthDp] by [heightDp], ending in the horizon (drawn [scale]
 * times its numbers, [road] on its road) whose near hill is the page's
 * colour, so the widget's ground carries on under it. At night the stars,
 * and a small moon centred at [moon]: dp in from the right edge and down
 * from the top, where a layout keeps it clear of its words.
 */
internal fun skyBitmap(ctx: Context, look: WidgetLook, widthDp: Float, heightDp: Float, scale: Float, road: Road, moon: Offset = Offset(34f, 66f)): Bitmap {
    val px = minOf(ctx.resources.displayMetrics.density, MAX_SCALE)
    val w = (widthDp * px).roundToInt().coerceAtLeast(1)
    val h = (heightDp * px).roundToInt().coerceAtLeast(1)
    val image = ImageBitmap(w, h)
    CanvasDrawScope().draw(Density(px), LayoutDirection.Ltr, Canvas(image), Size(w.toFloat(), h.toFloat())) {
        drawRect(skyBrush(look.palette, size.height), size = size)
        val strip = 92 * scale * px
        val top = size.height - strip
        // moonRoom sets the moon's size: a third of it, 10 dp across.
        if (look.phase == Phase.NIGHT) starsAndMoon(top, moonRoom = 17 * px, moonAt = Offset(size.width - moon.x * px, moon.y * px))
        horizon(top, look.page, look.palette, look.phase, road, 0f, scale)
    }
    return image.asAndroidBitmap()
}

/**
 * The bar's sky ([widthDp] by [heightDp]): the hour's colours across rather
 * than down, the stars at night, and the skyline faint at the right end,
 * [skylineDp] wide.
 */
internal fun barBitmap(ctx: Context, look: WidgetLook, widthDp: Float, heightDp: Float, skylineDp: Float): Bitmap {
    val px = minOf(ctx.resources.displayMetrics.density, MAX_SCALE)
    val w = (widthDp * px).roundToInt().coerceAtLeast(1)
    val h = (heightDp * px).roundToInt().coerceAtLeast(1)
    val image = ImageBitmap(w, h)
    val sky = look.palette.sky
    CanvasDrawScope().draw(Density(px), LayoutDirection.Ltr, Canvas(image), Size(w.toFloat(), h.toFloat())) {
        drawRect(Brush.horizontalGradient(0f to sky[0], 0.55f to sky[1], 1f to sky[2]), size = size)
        if (look.phase == Phase.NIGHT) {
            // Only the stars: the moon would sit on the words.
            clipRect(right = size.width * 0.9f) { starsAndMoon(size.height, alpha = 0.8f, moonRoom = 0f, moonAt = Offset(-100f, -100f)) }
        }
        val left = size.width - skylineDp * px
        val scale = 0.42f
        drawContext.canvas.saveLayer(Rect(left, 0f, size.width, size.height), Paint().apply { alpha = 0.55f })
        inset(left = left, top = 0f, right = 0f, bottom = 0f) {
            // No near hill: drawn over the bar's own colour, it showed as a pale box.
            horizon(size.height - 92 * scale * px * 0.86f, Color.Transparent, look.palette, look.phase, Road(shuttle = false), 0f, scale, withSun = false)
        }
        drawContext.canvas.restore()
    }
    return image.asAndroidBitmap()
}
