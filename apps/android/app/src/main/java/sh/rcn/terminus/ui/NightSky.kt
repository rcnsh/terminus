package sh.rcn.terminus.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Done for today's night: a sky behind the top of Now, from the status bar
 * down to the end of the night section (the headline and the next class),
 * where it meets the ground: a horizon of hills in the page's colour. The section says where it ends ([SkyState]);
 * Now draws the sky and puts what's over it (the header, the chips, the
 * status bar's icons) in night colours while it's there.
 */

/** Where the night section ends, for the sky behind it. Null: no night, no sky. */
@Stable
internal class SkyState {
    /** The top of Now's scrolling content, in root pixels. */
    var contentTop by mutableFloatStateOf(0f)

    /** The bottom of the night section, in root pixels; null when it isn't shown. */
    var sectionBottom by mutableStateOf<Float?>(null)

    /** How far down the content the sky goes, in pixels, or null for none. */
    val end: Float? get() = sectionBottom?.let { it - contentTop }
}

/** The sky Now draws, for the night section to report to. Null outside Now. */
internal val LocalSky = staticCompositionLocalOf<SkyState?> { null }

internal val NIGHT = listOf(Color(0xFF121A33), Color(0xFF181A30), Color(0xFF1C1B26))
internal val NIGHT_INK = Color(0xFFF2EFEB)
internal val NIGHT_SUB = Color(0xFFC9C3BD)
internal val MOON = Color(0xFFFDE9C9)

/** Across (0–1), down (0–1.05 of the room above the headline), brightness and size in dp. Fixed, so they never twinkle into a distraction. */
private val STARS = listOf(
    floatArrayOf(0.06f, 0.30f, 0.7f, 1.3f), floatArrayOf(0.17f, 0.62f, 0.5f, 1.1f), floatArrayOf(0.29f, 0.18f, 0.8f, 1.4f),
    floatArrayOf(0.38f, 0.80f, 0.4f, 1.0f), floatArrayOf(0.47f, 0.42f, 0.6f, 1.2f), floatArrayOf(0.55f, 0.10f, 0.5f, 1.0f),
    floatArrayOf(0.63f, 0.68f, 0.45f, 1.1f), floatArrayOf(0.72f, 0.28f, 0.7f, 1.3f), floatArrayOf(0.84f, 0.88f, 0.4f, 1.0f),
    floatArrayOf(0.92f, 0.50f, 0.55f, 1.2f), floatArrayOf(0.11f, 0.95f, 0.35f, 1.0f), floatArrayOf(0.33f, 1.05f, 0.4f, 1.1f),
    floatArrayOf(0.58f, 0.98f, 0.3f, 1.0f), floatArrayOf(0.97f, 0.16f, 0.45f, 1.1f),
)

/** The strip at the foot of the sky where the horizon is drawn; the night section ends with room for it. */
internal val HORIZON = 92.dp

/** The sky behind the content down to the horizon, while the night section is shown; nothing otherwise. */
internal fun Modifier.nightSky(sky: SkyState, page: Color): Modifier = drawBehind {
    val end = sky.end ?: return@drawBehind
    // Glowing a little towards the horizon.
    val glow = (end - 110.dp.toPx()).coerceAtLeast(end * 0.6f)
    drawRect(
        Brush.verticalGradient(0f to NIGHT[0], 0.55f * glow / end to NIGHT[1], glow / end to Color(0xFF24243A), 1f to Color(0xFF2E2A44), endY = end),
        size = Size(size.width, end),
    )
    horizon(end - HORIZON.toPx(), page)
}

/*
 * The hills along the horizon, more or less Kent Ridge: how far down the
 * strip (92 dp) each is, x dp across. Fixed waves in dp, so a wider screen
 * shows more hills rather than stretched ones. The web draws the same
 * (preview.js Horizon).
 */
private fun farY(x: Float) = 30f + 6f * sin(x / 47f + 0.6f) + 4f * sin(x / 19f + 2.1f)
private fun nearY(x: Float) = 52f + 3f * sin(x / 61f + 1.3f) + 1.5f * sin(x / 27f)

/** The lowest point of the far hills within 40 dp of [x], where the city shows above them. */
private fun dip(x: Float): Float = (-40..40 step 2).map { x + it }.fold(x) { best, c -> if (farY(c) > farY(best)) c else best }

/**
 * Where the sky ends, from [top] down: the hills, a building or two with a
 * light still on, rain trees, Singapore's flag by the road, a shuttle on
 * it, and Marina Bay Sands far off in the city. The near hill is [page]'s
 * own colour, so the sky meets the ground instead of fading into the page.
 */
private fun DrawScope.horizon(top: Float, page: Color) {
    val d = 1.dp.toPx()
    val w = size.width / d
    val dark = page.luminance() < 0.5f
    val far = Color(if (dark) 0xFF191826 else 0xFF3A3550)
    val tree = Color(if (dark) 0xFF121110 else 0xFF5B5568)
    val road = Color(if (dark) 0xFF2C2926 else 0xFFD6CFC7)
    fun at(x: Float, y: Float) = Offset(x * d, top + y * d)
    fun box(x: Float, y: Float, bw: Float, bh: Float, color: Color, r: Float = 0f) =
        drawRoundRect(color, at(x, y), Size(bw * d, bh * d), CornerRadius(r * d))
    fun shape(color: Color, vararg pts: Pair<Float, Float>) = drawPath(
        Path().apply {
            pts.forEachIndexed { i, (x, y) -> at(x, y).let { if (i == 0) moveTo(it.x, it.y) else lineTo(it.x, it.y) } }
            close()
        },
        color,
    )
    fun ridge(y: (Float) -> Float, color: Color) = drawPath(
        Path().apply {
            moveTo(0f, top + 92 * d)
            lineTo(0f, top + y(0f) * d)
            var x = 4f
            while (x < w + 4) { lineTo(x * d, top + y(x) * d); x += 4f }
            lineTo(size.width, top + 92 * d)
            close()
        },
        color,
    )
    val lit = MOON
    val dim = MOON.copy(alpha = 0.6f)
    fun across(f: Float) = (w * f).roundToInt().toFloat()
    // Marina Bay Sands, far off and pale: three towers and the SkyPark across them, out over the right.
    val mbs = dip(across(0.8f))
    val city = farY(mbs) + 3
    val haze = Color(0xFF45405F)
    for (x in floatArrayOf(-13f, -2f, 9f)) shape(haze, mbs + x to city, mbs + x + 1 to city - 26, mbs + x + 5 to city - 26, mbs + x + 6 to city)
    shape(haze, mbs - 15 to city - 28, mbs + 25 to city - 29.2f, mbs + 23 to city - 26, mbs - 14 to city - 26)
    ridge(::farY, far)
    val b1 = across(0.18f)
    val b2 = across(0.62f)
    box(b1 - 8, farY(b1) - 14, 16f, 20f, far)
    box(b1 - 3, farY(b1) - 9, 3f, 3f, dim)
    box(b2 - 13, farY(b2) - 22, 26f, 28f, far)
    box(b2 - 5, farY(b2) - 16, 3f, 3f, lit)
    box(b2 + 3, farY(b2) - 8, 3f, 3f, dim)
    fun oval(cx: Float, cy: Float, rx: Float, ry: Float) = drawOval(tree, at(cx - rx, cy - ry), Size(2 * rx * d, 2 * ry * d))
    for (f in floatArrayOf(0.06f, 0.45f, 0.9f)) {
        // A rain tree: a trunk forking low under a wide, flat crown.
        val c = across(f)
        val g = nearY(c)
        shape(
            tree, c - 1.5f to g + 2, c - 1.5f to g - 7, c - 7 to g - 13, c - 4.5f to g - 13, c to g - 9,
            c + 4.5f to g - 13, c + 7 to g - 13, c + 1.5f to g - 7, c + 1.5f to g + 2,
        )
        oval(c, g - 18, 21f, 5.5f)
        oval(c - 8, g - 21.5f, 11f, 4.5f)
        oval(c + 8, g - 22, 12f, 4.5f)
    }
    // A Singapore flag on its pole by the road.
    val flag = across(0.3f)
    val pole = nearY(flag)
    drawLine(tree, at(flag, pole + 2), at(flag, pole - 24), 1.2f * d)
    val red = Color(0xFFEF3340)
    val white = Color(0xFFF2EFEB)
    box(flag + 0.6f, pole - 24, 12f, 4f, red)
    box(flag + 0.6f, pole - 20, 12f, 4f, white)
    // The crescent and its five stars, which tell it from Indonesia's.
    drawCircle(white, 1.5f * d, at(flag + 3.2f, pole - 22))
    drawCircle(red, 1.3f * d, at(flag + 3.8f, pole - 22))
    for (i in 0 until 5) {
        val a = i * 2 * PI.toFloat() / 5
        drawCircle(white, 0.35f * d, at(flag + 5.2f + 0.85f * sin(a), pole - 22 - 0.85f * cos(a)))
    }
    ridge(::nearY, page)
    drawLine(road, at(0f, 70f), at(w, 70f), 1.5f * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6 * d, 6 * d)))
    // The shuttle, heading right with its headlights on: lit windows, A1's red along the bottom.
    val x = (w * 0.58f).roundToInt() - 19f
    val beam = listOf(at(x + 38, 63f), at(x + 60, 60f), at(x + 60, 68f))
    drawPath(Path().apply { moveTo(beam[0].x, beam[0].y); beam.drop(1).forEach { lineTo(it.x, it.y) }; close() }, MOON.copy(alpha = 0.12f))
    box(x, 57f, 38f, 12f, Color(0xFF24211E), 3f)
    box(x, 66.5f, 38f, 2.5f, Color(0xFFE53935), 1f)
    for (wx in floatArrayOf(3f, 10f, 17f, 24f)) box(x + wx, 59.5f, 5f, 4f, if (wx == 24f) dim else lit, 1f)
    box(x + 32, 59.5f, 4f, 6f, lit, 1f)
    for (wx in floatArrayOf(8f, 30f)) {
        drawCircle(Color(0xFF151311), 2.2f * d, at(x + wx, 69f))
        drawCircle(Color(0xFF8A847D), 0.8f * d, at(x + wx, 69f))
    }
}

/** The stars over the night section, in the room above its headline (clear of the chips, which show the sky through them), and the moon among them. */
internal fun DrawScope.starsAndMoon(room: Float) {
    for ((x, y, a, r) in STARS) drawCircle(Color.White.copy(alpha = a), r.dp.toPx(), Offset(size.width * x, room * 0.85f * y / 1.05f + 4.dp.toPx()))
    crescent(Offset(size.width - 44.dp.toPx(), room * 0.48f), 28.dp.toPx())
}

private operator fun FloatArray.component4() = this[3]

/** A crescent moon centred at [c], of radius [r]: a disc with a slightly smaller one taken out up and to the right. */
internal fun DrawScope.crescent(c: Offset, r: Float) {
    val moon = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c, r)) }
    val bite = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c + Offset(r * 0.46f, -r * 0.3f), r * 0.9f)) }
    drawPath(Path.combine(PathOperation.Difference, moon, bite), MOON)
}

/**
 * [content] in night colours when [on] (the dark scheme, whatever the
 * phone's theme), else as it is. Always the same tree, so nothing inside
 * loses its state when night comes or goes.
 */
@Composable
internal fun NightTheme(on: Boolean, content: @Composable () -> Unit) {
    val scheme = if (on) BrandDark else MaterialTheme.colorScheme
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
        CompositionLocalProvider(LocalContentColor provides if (on) scheme.onBackground else LocalContentColor.current, content = content)
    }
}

/** Light status bar icons over the night sky, back to the theme's when it goes. */
@Composable
internal fun NightStatusBar(night: Boolean) {
    val view = LocalView.current
    val dark = isSystemInDarkTheme()
    if (view.isInEditMode) return
    DisposableEffect(night, dark) {
        val window = view.context.activity()?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.isAppearanceLightStatusBars = !dark && !night
        onDispose { bars?.isAppearanceLightStatusBars = !dark }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
