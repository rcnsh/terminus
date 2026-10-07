package sh.rcn.terminus.ui

import android.app.Activity
import android.provider.Settings
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.Lifecycle
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.runtime.remember
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.ScrollState
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
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
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Now's sky: behind the top of Now, from the status bar down to a horizon
 * of the campus's hills, in the hour's colours (dawn, day, the golden hour,
 * dusk, night; always night after your day). There's one sky for the whole
 * tab, so it stays as the chips switch: whatever Now shows has its top in a
 * [SkyHead] and ends on a [SkyGround], which says where the sky ends and
 * what's on the road. Now draws the sky and puts what's over it (the
 * header, the chips, the status bar's icons) in the sky's ink. The web draws
 * the same scene from the same numbers (sky.js, daylight.js).
 */

/** The sky's looks, in the order of the day. */
internal enum class Phase { NIGHT, DAWN, DAY, GOLDEN, DUSK }

/**
 * The sky at [min] minutes past midnight, at the web's hours (daylight.js):
 * dawn from 6:30, day from 8:30, the golden hour from 4:30 PM, dusk from
 * 6:45 PM and night from 7:40 PM.
 */
internal fun phaseAt(min: Int): Phase = when {
    min < 390 || min >= 1180 -> Phase.NIGHT
    min < 510 -> Phase.DAWN
    min < 990 -> Phase.DAY
    min < 1125 -> Phase.GOLDEN
    else -> Phase.DUSK
}

/**
 * How far each layer of the sky lags, in dp, as Now scrolls down by [s] dp:
 * the moon and the stars at half speed, fading out by 160 dp; the far hills,
 * the city and a low sun sinking behind the near hill, by 18 dp at most. The
 * near hill, the road and your bus stay with the page. The web's numbers
 * (daylight.js parallax).
 */
internal data class Parallax(val sky: Float, val far: Float, val fade: Float)

internal fun parallax(s: Float): Parallax {
    val y = s.coerceAtLeast(0f)
    return Parallax(y * 0.5f, minOf(y * 0.12f, 18f), (1 - y / 160f).coerceAtLeast(0f))
}

/**
 * Your bus on the horizon's road: its colour, how far off it is (0 at the
 * stop, 1 a quarter of an hour away), and whether that's live. A timetable
 * guess is drawn as an outline.
 */
internal data class RoadBus(val color: Long, val far: Float, val live: Boolean)

/**
 * What's on the horizon's road: your stop's sign and your bus, or a shuttle
 * going by. It's a picture with no words: drawn this small, they were too
 * hard to read, so the card says them under it ([RoadLine]).
 */
internal data class Road(val stop: Boolean = false, val bus: RoadBus? = null, val shuttle: Boolean = true)

/** Now's sky: where it ends, its hour, the page's theme, and what's on the road. */
@Stable
internal class SkyState {
    /** The top of Now's scrolling content, in root pixels. */
    var contentTop by mutableFloatStateOf(0f)

    /**
     * The bottom of the horizon on screen, in root pixels; null before the
     * first. Kept while what's shown changes, until the next horizon says
     * where it ends.
     */
    var groundBottom by mutableStateOf<Float?>(null)

    var phase by mutableStateOf(Phase.NIGHT)
    var dark by mutableStateOf(false)
    var road by mutableStateOf(Road())

    /** How far Now has scrolled, in pixels: read while drawing, so scrolling only redraws. */
    var scroll: () -> Int = { 0 }

    /** No depth as it scrolls: the phone's "Remove animations" is on. */
    var still by mutableStateOf(false)

    /** Each layer's lag at the current scroll, in dp ([parallax]). */
    fun depth(dp: Float): Parallax = parallax(if (still) 0f else scroll() / dp)

    /** How far down the content the sky goes, in pixels, or null for none yet. */
    val end: Float? get() = groundBottom?.let { it - contentTop }

    /** The hour's colours, in the page's theme. */
    val palette: Palette get() = palette(phase, dark)
}

/** The sky Now draws, for what's on it to report to. Null outside Now. */
internal val LocalSky = staticCompositionLocalOf<SkyState?> { null }

internal val NIGHT = listOf(Color(0xFF121A33), Color(0xFF181A30), Color(0xFF1C1B26))
internal val MOON = Color(0xFFFDE9C9)

/**
 * An hour's colours: the sky from top to horizon, the far hills, the trees,
 * the city, the sun low behind the hills (at dawn, in the golden hour and at
 * dusk only: it's the time of day, not the weather), and whether the words
 * over it are light. On a dark phone every hour is deep and muted, so the sky
 * never glares; the words are light.
 */
internal class Palette(
    val sky: List<Color>,
    val far: Color,
    val tree: Color,
    val city: Color,
    val lightInk: Boolean,
    val sun: Color? = null,
    val road: Color,
    val post: Color,
    val postInk: Color,
    val window: Color,
)

private fun c(argb: Long) = Color(argb)

internal fun palette(phase: Phase, dark: Boolean): Palette {
    val road = c(if (dark) 0xFF2C2926 else 0xFFD6CFC7)
    val post = c(if (dark) 0xFFD6D3D1 else 0xFF1C1917)
    val postInk = c(if (dark) 0xFF0F0E0D else 0xFFFAFAF9)
    val lit = c(0xFFFDE9C9)
    fun make(sky: List<Long>, far: Long, tree: Long, city: Long, light: Boolean, sun: Long? = null, window: Color) = Palette(
        sky.map(::c), c(far), c(tree), c(city), light, sun?.let(::c), road, post, postInk,
        window = window,
    )
    val day = c(if (dark) 0xFFB9C7D6 else 0xFFDBEAFE)
    return if (dark) when (phase) {
        Phase.DAWN -> make(listOf(0xFF1D3550, 0xFF2A465F, 0xFF5C4D58, 0xFF8A6656), 0xFF2A3446, 0xFF151C24, 0xFF3D4658, true, 0xFFF3DCC0, window = day)
        Phase.DAY -> make(listOf(0xFF173350, 0xFF1F4262, 0xFF2D5674, 0xFF3F6B86), 0xFF20384A, 0xFF132330, 0xFF35506A, true, window = day)
        Phase.GOLDEN -> make(listOf(0xFF1F3550, 0xFF334356, 0xFF5E4A37, 0xFF9A6A3C), 0xFF3A3326, 0xFF1A1712, 0xFF4D4536, true, 0xFFF3D29A, window = day)
        Phase.DUSK -> make(listOf(0xFF1A1C3A, 0xFF322B54, 0xFF6C4260, 0xFFB8644F), 0xFF2B2340, 0xFF17121F, 0xFF4F4266, true, 0xFFF0915E, window = lit)
        Phase.NIGHT -> make(listOf(0xFF121A33, 0xFF181A30, 0xFF24243A, 0xFF2E2A44), 0xFF191826, 0xFF121110, 0xFF45405F, true, window = lit)
    } else when (phase) {
        Phase.DAWN -> make(listOf(0xFF8FC1E8, 0xFFB7D6EE, 0xFFF1D6C2, 0xFFF7C9A4), 0xFFB3B0C3, 0xFF6A7568, 0xFFCFC8D8, false, 0xFFFFF1D6, window = day)
        Phase.DAY -> make(listOf(0xFF5EA8E5, 0xFF8EC4EC, 0xFFC7E2F4, 0xFFE3F0F8), 0xFF9FBCAE, 0xFF4F6F58, 0xFFB7CBD9, false, window = day)
        Phase.GOLDEN -> make(listOf(0xFF78AADB, 0xFFA7C3DC, 0xFFF0CF9C, 0xFFF4B46C), 0xFFC4A983, 0xFF5E5A42, 0xFFDCC6A2, false, 0xFFFFE2A8, window = day)
        Phase.DUSK -> make(listOf(0xFF2C3566, 0xFF4A4275, 0xFF6C4260, 0xFFE08A62), 0xFF4B3F62, 0xFF2C2440, 0xFF7D6A90, true, 0xFFFFB37A, window = lit)
        Phase.NIGHT -> make(listOf(0xFF121A33, 0xFF181A30, 0xFF24243A, 0xFF2E2A44), 0xFF3A3550, 0xFF5B5568, 0xFF45405F, true, window = lit)
    }
}

/** Across (0–1), down (0–1.05 of the room above the words), brightness and size in dp. Fixed, so they never twinkle into a distraction. */
private val STARS = listOf(
    floatArrayOf(0.06f, 0.30f, 0.7f, 1.3f), floatArrayOf(0.17f, 0.62f, 0.5f, 1.1f), floatArrayOf(0.29f, 0.18f, 0.8f, 1.4f),
    floatArrayOf(0.38f, 0.80f, 0.4f, 1.0f), floatArrayOf(0.47f, 0.42f, 0.6f, 1.2f), floatArrayOf(0.55f, 0.10f, 0.5f, 1.0f),
    floatArrayOf(0.63f, 0.68f, 0.45f, 1.1f), floatArrayOf(0.72f, 0.28f, 0.7f, 1.3f), floatArrayOf(0.84f, 0.88f, 0.4f, 1.0f),
    floatArrayOf(0.92f, 0.50f, 0.55f, 1.2f), floatArrayOf(0.11f, 0.95f, 0.35f, 1.0f), floatArrayOf(0.33f, 1.05f, 0.4f, 1.1f),
    floatArrayOf(0.58f, 0.98f, 0.3f, 1.0f), floatArrayOf(0.97f, 0.16f, 0.45f, 1.1f),
)

/** How much bigger than its numbers the horizon with the road is drawn: the bus and your stop are the picture. */
private const val ROAD_SCALE = 1.25f

/** The strip at the foot of the sky where the horizon is drawn: its 92 dp, [ROAD_SCALE] times. */
internal val HORIZON = 115.dp

/** The sky behind Now's content, down to the horizon, once something on it has said where that is. */
internal fun Modifier.skyBehind(sky: SkyState, page: Color): Modifier = drawBehind {
    val end = sky.end ?: return@drawBehind
    val p = sky.palette
    drawRect(
        Brush.verticalGradient(0f to p.sky[0], 0.5f to p.sky[1], 0.86f to p.sky[2], 1f to p.sky[3], endY = end),
        size = Size(size.width, end),
    )
    horizon(end - HORIZON.toPx(), page, p, sky.phase, sky.road, sky.depth(1.dp.toPx()).far * 1.dp.toPx(), ROAD_SCALE)
}

/**
 * The top of what Now shows, up in the sky in the sky's ink, with a short
 * [room] above it, for the stars and the moon at night: the card is the
 * picture, not the sky. Off Now (no [LocalSky]), just [content].
 */
@Composable
internal fun SkyHead(room: Dp = 34.dp, content: @Composable ColumnScope.() -> Unit) {
    val sky = LocalSky.current
    if (sky == null) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
        return
    }
    SkyInk(true, sky.palette.lightInk) {
        Column(
            Modifier.fillMaxWidth().drawBehind { celestial(sky.phase, room.toPx(), sky.depth(1.dp.toPx())) }.padding(top = room),
            verticalArrangement = Arrangement.spacedBy(4.dp),
            content = content,
        )
    }
}

/**
 * Where the sky ends on Now: room for the horizon (drawn by [skyBehind]),
 * with [road]'s sign and bus on it. Off Now, nothing.
 */
@Composable
internal fun SkyGround(road: Road = Road()) {
    val sky = LocalSky.current ?: return
    SideEffect { sky.road = road }
    Spacer(Modifier.fillMaxWidth().height(10.dp + HORIZON).onGloballyPositioned { sky.groundBottom = it.positionInRoot().y + it.size.height })
}

/**
 * What's up in the room above the words at [phase]: the stars and the moon
 * at night, and nothing by day (the sun stays low, behind the hills).
 * Lagging behind the page as it scrolls, by [depth], and fading behind the
 * words.
 */
private fun DrawScope.celestial(phase: Phase, room: Float, depth: Parallax) {
    if (phase != Phase.NIGHT || depth.fade <= 0f) return
    translate(top = depth.sky * 1.dp.toPx()) { starsAndMoon(room, depth.fade) }
}

/*
 * The hills along the horizon, more or less Kent Ridge: how far down the
 * strip (92 dp) each is, x dp across. Fixed waves in dp, so a wider screen
 * shows more hills rather than stretched ones. The web draws the same
 * (sky.js Horizon).
 */
private fun farY(x: Float) = 30f + 6f * sin(x / 47f + 0.6f) + 4f * sin(x / 19f + 2.1f)
private fun nearY(x: Float) = 52f + 3f * sin(x / 61f + 1.3f) + 1.5f * sin(x / 27f)

/** The lowest point of the far hills between [lo] and [hi] dp, where the city shows above them. */
private fun dip(lo: Float, hi: Float): Float {
    var best = lo
    var x = lo
    while (x <= hi) { if (farY(x) > farY(best)) best = x; x += 2f }
    return best
}

/**
 * Where the sky ends, from [top] down: the hills, a building or two, rain
 * trees, Singapore's flag by the road, and Marina Bay Sands far off in the
 * city, in [p]'s colours at [phase], with the lights on after dark and the
 * sun low behind the hills at dawn, in the golden hour and at dusk. The near
 * hill is [page]'s own colour, so the sky meets the ground instead of fading
 * into the page. On the road, [road]'s sign and bus, or a shuttle going by.
 * Drawn [scale] times its numbers; [far] is in pixels. [withSun]: false for
 * just the hills (the band at the top of Settings' pages).
 */
private fun DrawScope.horizon(top: Float, page: Color, p: Palette, phase: Phase, road: Road, far: Float, scale: Float = 1f, withSun: Boolean = true) {
    val d = 1.dp.toPx() * scale
    val lights = phase == Phase.DUSK || phase == Phase.NIGHT
    val w = size.width / d
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
    // Your stop's sign left of the flag; the flag right of anything on the
    // road; the city clear of the flag and of the screen's edge.
    val sx = if (road.stop) minOf(across(0.7f), across(0.74f) - 7) else 0f
    val flag = across(0.76f)
    // The far layer sinks behind the near hill as Now scrolls ([far]), kept to the strip.
    clipRect(top = top, bottom = top + 92 * d) { translate(top = far) {
    // The sun, low: rising at dawn, low in the golden hour, setting at dusk. As the web's (.horizon .sun).
    p.sun?.takeIf { withSun }?.let { sun ->
        when (phase) {
            Phase.DAWN -> drawCircle(sun, 16 * d, at(across(0.3f), 42f))
            Phase.GOLDEN -> drawCircle(sun, 16 * d, at(across(0.36f), 36f))
            else -> drawCircle(sun, 26 * d, at(across(0.5f), 40f))
        }
    }
    // Marina Bay Sands, far off and pale: three towers and the SkyPark across them, out over the right.
    val mbs = dip(maxOf(across(0.8f) - 40, flag + 30), minOf(across(0.8f) + 40, w - 29))
    if (mbs + 25 <= w) {
        val city = farY(mbs) + 3
        for (x in floatArrayOf(-13f, -2f, 9f)) shape(p.city, mbs + x to city, mbs + x + 1 to city - 26, mbs + x + 5 to city - 26, mbs + x + 6 to city)
        shape(p.city, mbs - 15 to city - 28, mbs + 25 to city - 29.2f, mbs + 23 to city - 26, mbs - 14 to city - 26)
    }
    ridge(::farY, p.far)
    val b1 = across(0.18f)
    val b2 = across(0.62f)
    box(b1 - 8, farY(b1) - 14, 16f, 20f, p.far)
    box(b2 - 13, farY(b2) - 22, 26f, 28f, p.far)
    if (lights) {
        box(b1 - 3, farY(b1) - 9, 3f, 3f, dim)
        box(b2 - 5, farY(b2) - 16, 3f, 3f, lit)
        box(b2 + 3, farY(b2) - 8, 3f, 3f, dim)
    }
    } }
    fun oval(cx: Float, cy: Float, rx: Float, ry: Float) = drawOval(p.tree, at(cx - rx, cy - ry), Size(2 * rx * d, 2 * ry * d))
    for (f in floatArrayOf(0.06f, 0.45f, 0.9f)) {
        // A rain tree: a trunk forking low under a wide, flat crown.
        val c = across(f)
        val g = nearY(c)
        shape(
            p.tree, c - 1.5f to g + 2, c - 1.5f to g - 7, c - 7 to g - 13, c - 4.5f to g - 13, c to g - 9,
            c + 4.5f to g - 13, c + 7 to g - 13, c + 1.5f to g - 7, c + 1.5f to g + 2,
        )
        oval(c, g - 18, 21f, 5.5f)
        oval(c - 8, g - 21.5f, 11f, 4.5f)
        oval(c + 8, g - 22, 12f, 4.5f)
    }
    // A Singapore flag on its pole by the road.
    val pole = nearY(flag)
    drawLine(p.tree, at(flag, pole + 2), at(flag, pole - 24), 1.2f * d)
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
    drawLine(p.road, at(0f, 70f), at(w, 70f), 1.5f * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6 * d, 6 * d)))
    // A single-decker from the side, heading right: 38 by 12 from (x, 57), standing on the road. The air-con
    // on its roof, a row of windows, the driver's, the door ahead of the front wheel, the windscreen raking back
    // to the headlight, a tail light, and the wheels in their arches. With no [band] it's an outline in [paint]
    // (a timetable guess, so it never passes for live). Window [dim] (0 to 3) has its light off. As the web's busParts.
    fun bus(x: Float, paint: Color, band: Color?, dim: Int = -1) {
        val solid = band != null
        fun part(bx: Float, by: Float, bw: Float, bh: Float, color: Color, r: Float, line: Float) =
            if (solid) box(x + bx, 57 + by, bw, bh, color, r)
            else drawRoundRect(paint, at(x + bx, 57 + by), Size(bw * d, bh * d), CornerRadius(r * d), style = Stroke(line * d))
        fun pt(px: Float, py: Float) = at(x + px, 57 + py)
        val body = Path().apply {
            fun to(px: Float, py: Float) = pt(px, py).let { lineTo(it.x, it.y) }
            fun curve(cx: Float, cy: Float, px: Float, py: Float) = pt(cx, cy).let { c -> pt(px, py).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            pt(1.5f, 0f).let { moveTo(it.x, it.y) }
            to(33f, 0f); curve(36f, 0f, 36.9f, 2.6f); to(38f, 8.5f); to(38f, 10.5f); curve(38f, 12f, 36.5f, 12f)
            to(1.5f, 12f); curve(0f, 12f, 0f, 10.5f); to(0f, 1.5f); curve(0f, 0f, 1.5f, 0f)
            close()
        }
        val screen = Path().apply {
            pt(35.6f, 2.5f).let { moveTo(it.x, it.y) }
            pt(36.2f, 2.5f).let { c -> pt(36.4f, 3.2f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            pt(37.1f, 7.2f).let { lineTo(it.x, it.y) }
            pt(35.6f, 7.2f).let { lineTo(it.x, it.y) }
            close()
        }
        part(5f, -1.6f, 14f, 1.9f, paint, 0.8f, 0.8f)
        if (band != null) {
            drawPath(body, paint)
            box(x, 66.5f, 38f, 2f, band)
        } else {
            drawPath(body, paint, style = Stroke(1.2f * d, join = StrokeJoin.Round))
        }
        val glass = p.window
        for ((i, wx) in floatArrayOf(2.5f, 8.5f, 14.5f, 20.5f).withIndex()) part(wx, 2.5f, 5f, 4f, if (i == dim) glass.copy(alpha = 0.6f) else glass, 0.8f, 0.6f)
        part(26.5f, 2.5f, 4.5f, 4f, glass, 0.8f, 0.6f)
        part(32f, 2.5f, 2.8f, 8.2f, glass, 0.6f, 0.6f)
        if (solid) drawPath(screen, glass) else drawPath(screen, paint, style = Stroke(0.6f * d))
        if (solid) {
            box(x + 36.6f, 65.3f, 1.4f, 1.3f, Color(0xFFFEF3C7), 0.5f)
            box(x, 64.4f, 0.9f, 1.8f, Color(0xFFEF4444), 0.4f)
        }
        for (wx in floatArrayOf(7.5f, 26f)) {
            val arch = at(x + wx - 3.2f, 65.8f)
            if (solid) drawArc(Color.Black.copy(alpha = 0.35f), 180f, 180f, true, arch, Size(6.4f * d, 6.4f * d))
            else drawArc(paint, 180f, 180f, false, arch, Size(6.4f * d, 6.4f * d), style = Stroke(1.2f * d))
            drawCircle(Color(0xFF151311), 2.2f * d, at(x + wx, 69f))
            drawCircle(Color(0xFF8A847D), 0.8f * d, at(x + wx, 69f))
        }
    }
    if (road.stop) {
        // The sign: a bus on it, as on a real one.
        drawLine(p.post, at(sx, 70f), at(sx, 44f), 1.6f * d)
        box(sx - 6.5f, 33f, 13f, 13f, p.post, 2.5f)
        box(sx - 3.5f, 35.5f, 7f, 7.5f, p.postInk, 1.5f)
        box(sx - 2.5f, 36.5f, 5f, 3f, p.post, 0.5f)
    }
    val bus = road.bus
    if (bus != null && road.stop) {
        // Your bus pulls up just short of the sign.
        val colour = Color(bus.color)
        val x = (sx - 44 - bus.far.coerceIn(0f, 1f) * (sx - 56)).roundToInt().toFloat()
        bus(x, colour, if (bus.live) Color.White.copy(alpha = 0.85f) else null)
    } else if (road.shuttle) {
        // A shuttle going by, heading right, its headlights on after dark: A1's red along the bottom.
        val x = across(0.58f) - 19f
        if (lights) {
            val beam = listOf(at(x + 38, 66f), at(x + 60, 63f), at(x + 60, 70f))
            drawPath(Path().apply { moveTo(beam[0].x, beam[0].y); beam.drop(1).forEach { lineTo(it.x, it.y) }; close() }, MOON.copy(alpha = 0.12f))
        }
        bus(x, Color(0xFF24211E), Color(0xFFE53935), dim = 3)
    }
}

/** The stars across the room above the words, and the moon among them. */
internal fun DrawScope.starsAndMoon(room: Float, alpha: Float = 1f) {
    for ((x, y, a, r) in STARS) drawCircle(Color.White.copy(alpha = a * alpha), r.dp.toPx(), Offset(size.width * x, room * 0.85f * y / 1.05f + 4.dp.toPx()))
    val r = minOf(28.dp.toPx(), room * 0.3f)
    crescent(Offset(size.width - 16.dp.toPx() - r, room * 0.48f), r, alpha)
}

private operator fun FloatArray.component4() = this[3]

/** A crescent moon centred at [c], of radius [r]: a disc with a slightly smaller one taken out up and to the right. */
internal fun DrawScope.crescent(c: Offset, r: Float, alpha: Float = 1f) {
    val moon = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c, r)) }
    val bite = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c + Offset(r * 0.46f, -r * 0.3f), r * 0.9f)) }
    drawPath(Path.combine(PathOperation.Difference, moon, bite), MOON, alpha = alpha)
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

/**
 * What [SkyInk] adds for words in the sky: the "on time" green, the chip
 * small coloured words (Live, a notice) sit on, darker than a dark sky and
 * lighter than a light one, and the accent for small words (a countdown,
 * the trip's phase), stronger than the headline's. The web's --k-good,
 * --k-chip and --k-accent-small.
 */
internal class SkyTones(val good: Color, val chip: Color, val smallAccent: Color)

internal val LocalSkyTones = staticCompositionLocalOf<SkyTones?> { null }

/**
 * [content] in the sky's ink when [on]: light words on a dark sky, dark on a
 * light one ([light]), with the muted words a shade stronger than the
 * page's, as they're over colour. Every colour, the late red and the
 * warning amber too, reads at 4.5:1 over any hour's sky (large words at
 * 3:1). Cards and tiles on it are glass, a faint pane on a dark sky and
 * frosted on a light one, so they take the sky's colour at every hour
 * rather than sitting on it as a block (the web's --k-surface). Else as it
 * is. Always the same tree, so nothing inside loses its state as the hour
 * or the sky changes.
 */
@Composable
internal fun SkyInk(on: Boolean, light: Boolean, content: @Composable () -> Unit) {
    // A card takes its words' colour from matching its background in the
    // scheme, so the containers are the surface and surfaceVariant differs (Brand.kt).
    fun glass(base: ColorScheme, pane: Color, raised: Color, line: Color, muted: Color, accent: Color, late: Color, warn: Color) = base.copy(
        surface = pane, surfaceContainerLowest = pane, surfaceContainerLow = pane, surfaceContainer = pane,
        surfaceContainerHigh = pane, surfaceContainerHighest = pane, surfaceVariant = raised,
        outlineVariant = line, onSurfaceVariant = muted, primary = accent, error = late, tertiary = warn,
    )
    val scheme = when {
        !on -> MaterialTheme.colorScheme
        light -> glass(BrandDark, Color.White.copy(alpha = 0.08f), Color.White.copy(alpha = 0.13f), Color.White.copy(alpha = 0.18f), c(0xFFE7E5E4), c(0xFFFB923C), c(0xFFFECACA), c(0xFFFCD34D))
        else -> glass(BrandLight, Color.White.copy(alpha = 0.5f), Color.White.copy(alpha = 0.65f), c(0x291C1917), c(0xFF36312D), c(0xFF9A3412), c(0xFF701818), c(0xFF78350F))
    }
    val tones = when {
        !on -> null
        light -> SkyTones(good = c(0xFF86EFAC), chip = Color.Black.copy(alpha = 0.22f), smallAccent = c(0xFFFED7AA))
        else -> SkyTones(good = c(0xFF14532D), chip = Color.White.copy(alpha = 0.65f), smallAccent = c(0xFF6C2710))
    }
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
        CompositionLocalProvider(
            LocalContentColor provides if (on) scheme.onBackground else LocalContentColor.current,
            LocalSkyTones provides tones,
            content = content,
        )
    }
}

/** The accent for small words: in the sky, its stronger one ([SkyTones]). */
@Composable
internal fun smallAccent() = LocalSkyTones.current?.smallAccent ?: MaterialTheme.colorScheme.primary

/**
 * A tab's sky ([SkyState]) that scrolls with [scroll], in [phase] and the
 * page's theme: Now's, and Settings' list's. Still while the phone's
 * "Remove animations" is on (checked again on coming back to the app).
 */
@Composable
internal fun rememberSky(scroll: ScrollState, phase: Phase): SkyState {
    val sky = remember(scroll) { SkyState().apply { this.scroll = { scroll.value } } }
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(sky) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            sky.still = Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }
    }
    val page = MaterialTheme.colorScheme.background
    SideEffect {
        sky.phase = phase
        sky.dark = page.luminance() < 0.5f
    }
    return sky
}

/**
 * The status bar's own strip, [top] high, over a tab whose content scrolls
 * under it ([scroll]): clear at the top, so the sky ([sky], if any) or the page shows
 * through, then filled as the content goes under it.
 */
@Composable
internal fun StatusStrip(sky: SkyState?, top: Dp, scroll: ScrollState) {
    val page = MaterialTheme.colorScheme.background
    Box(
        Modifier
            .fillMaxWidth()
            .height(top)
            .graphicsLayer { alpha = if (top.toPx() > 0f) (scroll.value / top.toPx()).coerceIn(0f, 1f) else 0f }
            .background(if (sky?.end != null) sky.palette.sky[0] else page),
    )
}

/** How much of the horizon the band at the top of Settings' pages shows: the city's top to the near hill. */
private val LOW = 52.dp

/** A few stars beside a page's title in the band, clear of the title: across (0–1), down (0–1 of the title's row). */
private val BAND_STARS = listOf(
    floatArrayOf(0.56f, 0.2f, 0.6f), floatArrayOf(0.63f, 0.7f, 0.45f), floatArrayOf(0.7f, 0.35f, 0.7f),
    floatArrayOf(0.78f, 0.8f, 0.4f), floatArrayOf(0.66f, 0.05f, 0.5f), floatArrayOf(0.95f, 0.85f, 0.45f),
)

/**
 * A slim band of the sky at the top of one of Settings' pages, in [phase]:
 * from the top of the screen, [top] for the status bar, then [content] (the
 * back arrow and the title) in the sky's ink with the moon on the right at
 * night, ending on the low horizon (just the hills, no road). The page's
 * controls stay on the plain page under it. As the web's (.page-band).
 */
@Composable
internal fun SkyBand(phase: Phase, top: Dp, content: @Composable () -> Unit) {
    val page = MaterialTheme.colorScheme.background
    val p = palette(phase, page.luminance() < 0.5f)
    NightStatusBar(p.lightInk)
    Column(
        Modifier.fillMaxWidth().drawBehind {
            val d = 1.dp.toPx()
            val end = size.height
            drawRect(Brush.verticalGradient(0f to p.sky[0], 0.5f to p.sky[1], 0.86f to p.sky[2], 1f to p.sky[3], endY = end))
            // Beside the title, on the right: its row is between the status bar and the hills.
            val row = top.toPx()..(end - LOW.toPx())
            val mid = (row.start + row.endInclusive) / 2
            val r = 11 * d
            val centre = Offset(size.width - 22 * d - r, mid)
            if (phase == Phase.NIGHT) {
                for ((x, y, a) in BAND_STARS) drawCircle(Color.White.copy(alpha = a), 1.1f * d, Offset(size.width * x, row.start + (row.endInclusive - row.start) * y))
                crescent(centre, r + d)
            }
            // The low horizon: the strip's y 6 to 58 dp, at the band's foot.
            val strip = end - 58 * d
            clipRect(top = end - LOW.toPx(), bottom = end) {
                // Just the hills: the sun stays for Now's horizon.
                horizon(strip, page, p, phase, Road(shuttle = false), 0f, withSun = false)
            }
        },
    ) {
        Spacer(Modifier.height(top))
        SkyInk(true, p.lightInk) { Box(Modifier.padding(horizontal = 16.dp)) { content() } }
        Spacer(Modifier.height(LOW))
    }
}

/** Which screen set the status bar's icons last, so one going away doesn't undo the next one's. */
private var statusOwner: Any? = null

/** Light status bar icons over a dark sky, back to the theme's when it goes. */
@Composable
internal fun NightStatusBar(night: Boolean) {
    val view = LocalView.current
    val dark = isSystemInDarkTheme()
    if (view.isInEditMode) return
    DisposableEffect(night, dark) {
        val me = Any()
        statusOwner = me
        val window = view.context.activity()?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.isAppearanceLightStatusBars = !dark && !night
        onDispose {
            // A tab fading out after the next one has set its own: leave them.
            if (statusOwner === me) bars?.isAppearanceLightStatusBars = !dark
        }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
