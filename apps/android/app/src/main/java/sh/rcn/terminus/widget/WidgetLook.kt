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
import java.time.LocalDateTime
import java.time.ZoneId
import kotlin.math.roundToInt
import sh.rcn.terminus.ui.Phase
import sh.rcn.terminus.ui.Road
import sh.rcn.terminus.ui.horizon
import sh.rcn.terminus.ui.palette
import sh.rcn.terminus.ui.phaseAt
import sh.rcn.terminus.ui.skyBrush
import sh.rcn.terminus.ui.starsAndMoon

internal class Inks(
    val ink: ColorProvider,
    val muted: ColorProvider,
    val accent: ColorProvider,
    val late: ColorProvider,
    val good: ColorProvider,
    val chip: ColorProvider,
    val chipOn: ColorProvider,
    val onChipOn: ColorProvider,
    val line: ColorProvider,
)

private fun fixed(argb: Long) = ColorProvider(Color(argb))

private fun fixed(c: Color) = ColorProvider(c)

internal class WidgetLook(val phase: Phase, val dark: Boolean) {
    val palette = palette(phase, dark)

    val page: Color = Color(if (dark) 0xFF0F0E0D else 0xFFFAFAF9)

    val sky: Inks =
        if (palette.lightInk)
            Inks(
                ink = fixed(0xFFF5F3F0),
                muted = fixed(0xFFE7E5E4),
                accent = fixed(0xFFFB923C),
                late = fixed(0xFFFECACA),
                good = fixed(0xFF86EFAC),
                chip = fixed(Color.Black.copy(alpha = 0.22f)),
                chipOn = fixed(0xFFF5F3F0),
                onChipOn = fixed(0xFF1C1917),
                line = fixed(Color.White.copy(alpha = 0.18f)),
            )
        else
            Inks(
                ink = fixed(0xFF1C1917),
                muted = fixed(0xFF36312D),
                accent = fixed(0xFF9A3412),
                late = fixed(0xFF701818),
                good = fixed(0xFF14532D),
                chip = fixed(Color.White.copy(alpha = 0.65f)),
                chipOn = fixed(0xFF1C1917),
                onChipOn = fixed(0xFFFAFAF9),
                line = fixed(0x291C1917),
            )

    val ground: Inks =
        if (dark)
            Inks(
                ink = fixed(0xFFF2EFEB),
                muted = fixed(0xFFA39D97),
                accent = fixed(0xFFFB923C),
                late = fixed(0xFFF87171),
                good = fixed(0xFF4ADE80),
                chip = fixed(0xFF2C2926),
                chipOn = fixed(0xFFF2EFEB),
                onChipOn = fixed(0xFF1C1917),
                line = fixed(0xFF2C2926),
            )
        else
            Inks(
                ink = fixed(0xFF1C1917),
                muted = fixed(0xFF6B6560),
                accent = fixed(0xFFC2410C),
                late = fixed(0xFFB91C1C),
                good = fixed(0xFF166534),
                chip = fixed(0xFFF0EEEB),
                chipOn = fixed(0xFF1C1917),
                onChipOn = fixed(0xFFFAFAF9),
                line = fixed(0xFFE7E5E2),
            )

    val pageColor: ColorProvider = fixed(page)

    companion object {
        fun now(ctx: Context): WidgetLook {
            val dark = ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            return WidgetLook(phaseAt(LocalDateTime.now().let { it.hour * 60 + it.minute }), dark)
        }
    }
}

internal fun minutesToNextPhase(minute: Int): Int {
    val now = phaseAt(minute)
    return (1..24 * 60).first { phaseAt((minute + it) % (24 * 60)) != now }
}

internal fun nextPhaseAt(now: Long, zone: ZoneId = ZoneId.systemDefault()): Long {
    val t = java.time.Instant.ofEpochMilli(now).atZone(zone)
    val minute = t.hour * 60 + t.minute
    return t.withSecond(0).withNano(0).plusMinutes(minutesToNextPhase(minute).toLong()).toInstant().toEpochMilli()
}

private const val MAX_SCALE = 2.5f

internal fun skyBitmap(
    ctx: Context,
    look: WidgetLook,
    widthDp: Float,
    heightDp: Float,
    scale: Float,
    road: Road,
    moon: Offset? = Offset(34f, 66f),
): Bitmap {
    val px = minOf(ctx.resources.displayMetrics.density, MAX_SCALE)
    val w = (widthDp * px).roundToInt().coerceAtLeast(1)
    val h = (heightDp * px).roundToInt().coerceAtLeast(1)
    val image = ImageBitmap(w, h)
    CanvasDrawScope().draw(Density(px), LayoutDirection.Ltr, Canvas(image), Size(w.toFloat(), h.toFloat())) {
        drawRect(skyBrush(look.palette, size.height), size = size)
        val strip = 92 * scale * px
        val top = size.height - strip
        if (look.phase == Phase.NIGHT)
            starsAndMoon(
                top,
                moonRoom = 17 * px,
                moonAt = moon?.let { Offset(size.width - it.x * px, it.y * px) } ?: Offset(-size.width, -size.height),
            )
        horizon(top, look.page, look.palette, look.phase, road, 0f, scale)
    }
    return image.asAndroidBitmap()
}

internal fun barBitmap(ctx: Context, look: WidgetLook, widthDp: Float, heightDp: Float, skylineDp: Float): Bitmap {
    val px = minOf(ctx.resources.displayMetrics.density, MAX_SCALE)
    val w = (widthDp * px).roundToInt().coerceAtLeast(1)
    val h = (heightDp * px).roundToInt().coerceAtLeast(1)
    val image = ImageBitmap(w, h)
    val sky = look.palette.sky
    CanvasDrawScope().draw(Density(px), LayoutDirection.Ltr, Canvas(image), Size(w.toFloat(), h.toFloat())) {
        drawRect(Brush.horizontalGradient(0f to sky[0], 0.55f to sky[1], 1f to sky[2]), size = size)
        if (look.phase == Phase.NIGHT) {
            clipRect(right = size.width * 0.9f) { starsAndMoon(size.height, alpha = 0.8f, moonRoom = 0f, moonAt = Offset(-100f, -100f)) }
        }
        val left = size.width - skylineDp * px
        val scale = 0.42f
        drawContext.canvas.saveLayer(Rect(left, 0f, size.width, size.height), Paint().apply { alpha = 0.55f })
        inset(left = left, top = 0f, right = 0f, bottom = 0f) {
            horizon(
                size.height - 92 * scale * px * 0.86f,
                Color.Transparent,
                look.palette,
                look.phase,
                Road(shuttle = false),
                0f,
                scale,
                withSun = false,
            )
        }
        drawContext.canvas.restore()
    }
    return image.asAndroidBitmap()
}
