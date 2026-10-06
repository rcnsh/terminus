package sh.rcn.terminus.ui

import android.app.Activity
import androidx.compose.ui.text.rememberTextMeasurer
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
 * the sun, the moon and the stars at half speed, fading out by 160 dp; the
 * clouds a little faster; the far hills and the city sinking behind the near
 * hill, by 18 dp at most. The near hill, the road and your bus stay with the
 * page. The web's numbers (daylight.js parallax).
 */
internal data class Parallax(val sky: Float, val clouds: Float, val far: Float, val fade: Float)

internal fun parallax(s: Float): Parallax {
    val y = s.coerceAtLeast(0f)
    return Parallax(y * 0.5f, y * 0.35f, minOf(y * 0.12f, 18f), (1 - y / 160f).coerceAtLeast(0f))
}

/**
 * Your bus on the horizon's road: when it's due ("D2 · 8 min"), its colour,
 * how far off it is (0 at the stop, 1 a quarter of an hour away), and
 * whether that's live. A timetable guess is drawn as an outline.
 */
internal data class RoadBus(val text: String, val color: Long, val far: Float, val live: Boolean)

/** What's on the horizon's road: your stop's sign and your bus, or a shuttle going by. */
internal data class Road(val stop: String? = null, val bus: RoadBus? = null, val shuttle: Boolean = true)

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
 * the city, the sun and its glow, clouds, a setting sun, and whether the
 * words over it are light. On a dark phone every hour is deep and muted, so
 * the sky never glares; the words are light.
 */
internal class Palette(
    val sky: List<Color>,
    val far: Color,
    val tree: Color,
    val city: Color,
    val lightInk: Boolean,
    val sun: Color? = null,
    val glow: Color = Color.Transparent,
    val cloud: Color? = null,
    val setting: Color? = null,
    val road: Color,
    val post: Color,
    val postInk: Color,
    val pill: Color,
    val pillInk: Color,
    val window: Color,
)

private fun c(argb: Long) = Color(argb)

internal fun palette(phase: Phase, dark: Boolean): Palette {
    val road = c(if (dark) 0xFF2C2926 else 0xFFD6CFC7)
    val post = c(if (dark) 0xFFD6D3D1 else 0xFF1C1917)
    val postInk = c(if (dark) 0xFF0F0E0D else 0xFFFAFAF9)
    val lit = c(0xFFFDE9C9)
    // Dark words on a light sky get a dark label; light words a light one.
    fun make(sky: List<Long>, far: Long, tree: Long, city: Long, light: Boolean, sun: Long? = null, glow: Color = Color.Transparent, cloud: Color? = null, setting: Long? = null, window: Color) = Palette(
        sky.map(::c), c(far), c(tree), c(city), light, sun?.let(::c), glow, cloud, setting?.let(::c), road, post, postInk,
        pill = if (dark) c(0xFFF5F3F0) else if (light) Color.White else c(0xFF1C1917),
        pillInk = if (dark) c(0xFF0F0E0D) else if (light) c(0xFF1C1917) else Color.White,
        window = window,
    )
    val day = c(if (dark) 0xFFB9C7D6 else 0xFFDBEAFE)
    return if (dark) when (phase) {
        Phase.DAWN -> make(listOf(0xFF1D3550, 0xFF2F4D68, 0xFF6B5A66, 0xFF8A6656), 0xFF2A3446, 0xFF151C24, 0xFF3D4658, true, 0xFFF3DCC0, c(0x4DF3DCC0), window = day)
        Phase.DAY -> make(listOf(0xFF173350, 0xFF22486B, 0xFF35607F, 0xFF3F6B86), 0xFF20384A, 0xFF132330, 0xFF35506A, true, 0xFFFBE3A6, c(0x73FFCD78), c(0x29DCE6F0), window = day)
        Phase.GOLDEN -> make(listOf(0xFF1F3550, 0xFF3A4A5E, 0xFF7A6046, 0xFF9A6A3C), 0xFF3A3326, 0xFF1A1712, 0xFF4D4536, true, 0xFFF3D29A, c(0x59F3D29A), c(0x24DCE6F0), window = day)
        Phase.DUSK -> make(listOf(0xFF1A1C3A, 0xFF362F5A, 0xFF7A4A6A, 0xFFB8644F), 0xFF2B2340, 0xFF17121F, 0xFF4F4266, true, setting = 0xFFF0915E, window = lit)
        Phase.NIGHT -> make(listOf(0xFF121A33, 0xFF181A30, 0xFF24243A, 0xFF2E2A44), 0xFF191826, 0xFF121110, 0xFF45405F, true, window = lit)
    } else when (phase) {
        Phase.DAWN -> make(listOf(0xFF8FC1E8, 0xFFB7D6EE, 0xFFF1D6C2, 0xFFF7C9A4), 0xFFB3B0C3, 0xFF6A7568, 0xFFCFC8D8, false, 0xFFFFF1D6, c(0xBFFFD6AA), window = day)
        Phase.DAY -> make(listOf(0xFF4F9EE0, 0xFF86BFEB, 0xFFC7E2F4, 0xFFE3F0F8), 0xFF9FBCAE, 0xFF4F6F58, 0xFFB7CBD9, false, 0xFFFFFBEA, c(0xE6FFFADC), c(0xD9FFFFFF), window = day)
        Phase.GOLDEN -> make(listOf(0xFF6FA3D6, 0xFFA7C3DC, 0xFFF0CF9C, 0xFFF4B46C), 0xFFC4A983, 0xFF5E5A42, 0xFFDCC6A2, false, 0xFFFFE2A8, c(0xCCFFBE6E), c(0xCCFFFFFF), window = day)
        Phase.DUSK -> make(listOf(0xFF2C3566, 0xFF5B4F86, 0xFFC6708A, 0xFFF19A6C), 0xFF4B3F62, 0xFF2C2440, 0xFF7D6A90, true, setting = 0xFFFFB37A, window = lit)
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

/** The strip at the foot of the sky where the horizon is drawn. */
internal val HORIZON = 92.dp

/** The sky behind Now's content, down to the horizon, once something on it has said where that is. */
internal fun Modifier.skyBehind(sky: SkyState, page: Color, measurer: TextMeasurer): Modifier = drawBehind {
    val end = sky.end ?: return@drawBehind
    val p = sky.palette
    drawRect(
        Brush.verticalGradient(0f to p.sky[0], 0.5f to p.sky[1], 0.86f to p.sky[2], 1f to p.sky[3], endY = end),
        size = Size(size.width, end),
    )
    horizon(end - HORIZON.toPx(), page, p, sky.phase == Phase.DUSK || sky.phase == Phase.NIGHT, sky.road, measurer, sky.depth(1.dp.toPx()).far)
}

/**
 * The top of what Now shows, up in the sky in the sky's ink, with [room]
 * above it for the sun, the clouds, or the stars and the moon. Off Now (no
 * [LocalSky]), just [content].
 */
@Composable
internal fun SkyHead(room: Dp = 66.dp, content: @Composable ColumnScope.() -> Unit) {
    val sky = LocalSky.current
    if (sky == null) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
        return
    }
    SkyInk(true, sky.palette.lightInk) {
        Column(
            Modifier.fillMaxWidth().drawBehind { celestial(sky.phase, sky.palette, room.toPx(), sky.depth(1.dp.toPx())) }.padding(top = room),
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
 * What's up in the room above the words at [phase]: the sun and a few
 * clouds, the stars and the moon, or (at dusk) nothing, the sun setting
 * behind the hills. Lagging behind the page as it scrolls, by [depth], and
 * fading behind the words.
 */
private fun DrawScope.celestial(phase: Phase, p: Palette, room: Float, depth: Parallax) {
    val d = 1.dp.toPx()
    val fade = depth.fade
    if (fade <= 0f) return
    if (phase == Phase.NIGHT) return translate(top = depth.sky * d) { starsAndMoon(room, fade) }
    val sun = p.sun ?: return
    // Top and right edge, then size, in dp: low at dawn, high at noon, lower again.
    val (top, right, across) = when (phase) {
        Phase.DAWN -> Triple(10f, 30f, 40f)
        Phase.DAY -> Triple(4f, 44f, 34f)
        else -> Triple(14f, 24f, 40f)
    }
    val r = across / 2 * d
    val centre = Offset(size.width - right * d - r, (top + depth.sky) * d + r)
    drawCircle(Brush.radialGradient(0.4f to p.glow, 1f to Color.Transparent, center = centre, radius = r * 2.4f), r * 2.4f, centre, alpha = fade)
    drawCircle(sun, r, centre, alpha = fade)
    // Singapore's heaped-up afternoon clouds.
    val cloud = p.cloud ?: return
    for ((x, y, s) in listOf(Triple(70f, 34f, 0.9f), Triple(205f, 48f, 0.6f), Triple(150f, 14f, 0.45f))) {
        fun at(cx: Float, cy: Float) = Offset((x + cx * s) * d, (y + depth.clouds + cy * s) * d)
        drawOval(cloud, at(-26f, 1f), Size(52 * s * d, 14 * s * d), alpha = fade)
        drawCircle(cloud, 8 * s * d, at(-10f, 3f), alpha = fade)
        drawCircle(cloud, 11 * s * d, at(4f, -1f), alpha = fade)
        drawCircle(cloud, 7 * s * d, at(16f, 4f), alpha = fade)
    }
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
 * city, in [p]'s colours, with the lights on when [lights]. The near hill is
 * [page]'s own colour, so the sky meets the ground instead of fading into
 * the page. On the road, [road]'s sign and bus, or a shuttle going by.
 */
private fun DrawScope.horizon(top: Float, page: Color, p: Palette, lights: Boolean, road: Road, measurer: TextMeasurer, far: Float) {
    val d = 1.dp.toPx()
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
    // Your stop's sign left of the flag, whatever its name's length; the
    // flag right of anything on the road; the city clear of the flag and
    // of the screen's edge.
    val name = road.stop?.let { measurer.measure(it, TextStyle(color = p.postInk, fontSize = 7.5.sp, fontWeight = FontWeight.Bold)) }
    val plate = name?.let { it.size.width / d + 10 } ?: 0f
    val sx = if (name != null) minOf(across(0.7f), across(0.74f) - plate / 2) else 0f
    val flag = across(0.76f)
    // The far layer sinks behind the near hill as Now scrolls ([far] dp), kept to the strip.
    clipRect(top = top, bottom = top + 92 * d) { translate(top = far * d) {
    p.setting?.let { drawCircle(it, 26 * d, at(across(0.5f), 40f)) }
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
    fun tyres(x: Float) {
        for (wx in floatArrayOf(8f, 30f)) {
            drawCircle(Color(0xFF151311), 2.2f * d, at(x + wx, 69f))
            drawCircle(Color(0xFF8A847D), 0.8f * d, at(x + wx, 69f))
        }
    }
    if (name != null) {
        drawLine(p.post, at(sx, 70f), at(sx, 44f), 1.6f * d)
        box(sx - plate / 2, 35f, plate, 11f, p.post, 2.5f)
        drawText(name, topLeft = Offset(sx * d - name.size.width / 2f, top + 40.5f * d - name.size.height / 2f))
    }
    val bus = road.bus
    if (bus != null && name != null) {
        // Your bus pulls up just short of the sign; its label keeps clear of the sign.
        val colour = Color(bus.color)
        val x = (sx - 44 - bus.far.coerceIn(0f, 1f) * (sx - 56)).roundToInt().toFloat()
        if (bus.live) {
            box(x, 57f, 38f, 12f, colour, 3f)
            box(x, 66.5f, 38f, 2.5f, Color.White.copy(alpha = 0.85f), 1f)
            for (wx in floatArrayOf(3f, 10f, 17f, 24f)) box(x + wx, 59.5f, 5f, 4f, p.window, 1f)
            box(x + 32, 59.5f, 4f, 6f, p.window, 1f)
        } else {
            drawRoundRect(colour, at(x + 0.75f, 57.75f), Size(36.5f * d, 10.5f * d), CornerRadius(3 * d), style = Stroke(1.5f * d))
        }
        tyres(x)
        val label = measurer.measure(bus.text, TextStyle(color = p.pillInk, fontSize = 8.sp, fontWeight = FontWeight.Bold))
        val lw = label.size.width / d + 14
        val lx = maxOf(4f, minOf(x + 19 - lw / 2, sx - plate / 2 - 4 - lw))
        box(lx, 42f, lw, 12f, p.pill, 6f)
        drawText(label, topLeft = Offset((lx + lw / 2) * d - label.size.width / 2f, top + 48f * d - label.size.height / 2f))
    } else if (road.shuttle) {
        // A shuttle going by, heading right, its headlights on after dark: A1's red along the bottom.
        val x = across(0.58f) - 19f
        if (lights) {
            val beam = listOf(at(x + 38, 63f), at(x + 60, 60f), at(x + 60, 68f))
            drawPath(Path().apply { moveTo(beam[0].x, beam[0].y); beam.drop(1).forEach { lineTo(it.x, it.y) }; close() }, MOON.copy(alpha = 0.12f))
        }
        box(x, 57f, 38f, 12f, Color(0xFF24211E), 3f)
        box(x, 66.5f, 38f, 2.5f, Color(0xFFE53935), 1f)
        for (wx in floatArrayOf(3f, 10f, 17f, 24f)) box(x + wx, 59.5f, 5f, 4f, if (wx == 24f) p.window.copy(alpha = 0.6f) else p.window, 1f)
        box(x + 32, 59.5f, 4f, 6f, p.window, 1f)
        tyres(x)
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
 * [content] in the sky's ink when [on]: light words on a dark sky, dark on a
 * light one ([light]), with the muted words a shade stronger than the
 * page's, as they're over colour. Cards and tiles on it are glass, a faint
 * pane on a dark sky and frosted on a light one, so they take the sky's
 * colour at every hour rather than sitting on it as a block (the web's
 * --k-surface). Else as it is. Always the same tree, so nothing inside
 * loses its state as the hour or the sky changes.
 */
@Composable
internal fun SkyInk(on: Boolean, light: Boolean, content: @Composable () -> Unit) {
    // A card takes its words' colour from matching its background in the
    // scheme, so the containers are the surface and surfaceVariant differs (Brand.kt).
    fun glass(base: ColorScheme, pane: Color, raised: Color, line: Color, muted: Color) = base.copy(
        surface = pane, surfaceContainerLowest = pane, surfaceContainerLow = pane, surfaceContainer = pane,
        surfaceContainerHigh = pane, surfaceContainerHighest = pane, surfaceVariant = raised,
        outlineVariant = line, onSurfaceVariant = muted,
    )
    val scheme = when {
        !on -> MaterialTheme.colorScheme
        light -> glass(BrandDark, Color.White.copy(alpha = 0.08f), Color.White.copy(alpha = 0.13f), Color.White.copy(alpha = 0.18f), Color(0xFFD6D3D1))
        else -> glass(BrandLight, Color.White.copy(alpha = 0.5f), Color.White.copy(alpha = 0.65f), Color(0x291C1917), Color(0xFF3F3A36))
    }
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
        CompositionLocalProvider(LocalContentColor provides if (on) scheme.onBackground else LocalContentColor.current, content = content)
    }
}

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
 * under it ([scroll]): clear at the top, so the sky (or the page) shows
 * through, then filled as the content goes under it.
 */
@Composable
internal fun StatusStrip(sky: SkyState, top: Dp, scroll: ScrollState) {
    val page = MaterialTheme.colorScheme.background
    Box(
        Modifier
            .fillMaxWidth()
            .height(top)
            .graphicsLayer { alpha = if (top.toPx() > 0f) (scroll.value / top.toPx()).coerceIn(0f, 1f) else 0f }
            .background(if (sky.end != null) sky.palette.sky[0] else page),
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
 * back arrow and the title) in the sky's ink with a small sun or moon on the
 * right, ending on the low horizon (just the hills, no road). The page's
 * controls stay on the plain page under it. As the web's (.page-band).
 */
@Composable
internal fun SkyBand(phase: Phase, top: Dp, content: @Composable () -> Unit) {
    val page = MaterialTheme.colorScheme.background
    val p = palette(phase, page.luminance() < 0.5f)
    val measurer = rememberTextMeasurer()
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
            } else p.sun?.let { sun ->
                drawCircle(Brush.radialGradient(0.4f to p.glow, 1f to Color.Transparent, center = centre, radius = r * 2.4f), r * 2.4f, centre)
                drawCircle(sun, r, centre)
            }
            // The low horizon: the strip's y 6 to 58 dp, at the band's foot.
            val strip = end - 58 * d
            clipRect(top = end - LOW.toPx(), bottom = end) {
                horizon(strip, page, p, phase == Phase.DUSK || phase == Phase.NIGHT, Road(shuttle = false), measurer, 0f)
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
