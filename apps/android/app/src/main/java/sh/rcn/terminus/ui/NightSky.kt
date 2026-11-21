package sh.rcn.terminus.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.provider.Settings
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullScene

internal enum class Phase {
    NIGHT,
    DAWN,
    DAY,
    GOLDEN,
    DUSK,
}

internal fun phaseAt(min: Int): Phase =
    when {
        min < 390 || min >= 1180 -> Phase.NIGHT
        min < 510 -> Phase.DAWN
        min < 990 -> Phase.DAY
        min < 1125 -> Phase.GOLDEN
        else -> Phase.DUSK
    }

internal data class Parallax(val sky: Float, val far: Float, val fade: Float)

internal fun parallax(s: Float): Parallax {
    val y = s.coerceAtLeast(0f)
    return Parallax(y * 0.5f, minOf(y * 0.12f, 18f), (1 - y / 160f).coerceAtLeast(0f))
}

internal data class RoadBus(val color: Long, val far: Float, val live: Boolean)

internal data class Road(val stop: Boolean = false, val bus: RoadBus? = null, val shuttle: Boolean = true)

@Stable
internal class SkyState {
    var contentTop by mutableFloatStateOf(0f)

    var groundBottom by mutableStateOf<Float?>(null)

    var phase by mutableStateOf(Phase.NIGHT)
    var dark by mutableStateOf(false)
    var road by mutableStateOf(Road())

    var short by mutableStateOf(false)

    var scroll: () -> Int = { 0 }

    var still by mutableStateOf(false)

    fun depth(dp: Float): Parallax = parallax(if (still) 0f else scroll() / dp)

    val end: Float?
        get() = groundBottom?.let { it - contentTop }

    val palette: Palette
        get() = palette(phase, dark)
}

internal val LocalSky = staticCompositionLocalOf<SkyState?> { null }

internal val NIGHT = listOf(Color(0xFF121A33), Color(0xFF181A30), Color(0xFF1C1B26))
internal val MOON = Color(0xFFFDE9C9)

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
    fun make(sky: List<Long>, far: Long, tree: Long, city: Long, light: Boolean, sun: Long? = null, window: Color) =
        Palette(
            sky.map(::c),
            c(far),
            c(tree),
            c(city),
            light,
            sun?.let(::c),
            road,
            post,
            postInk,
            window = window,
        )
    val day = c(if (dark) 0xFFB9C7D6 else 0xFFDBEAFE)
    return if (dark)
        when (phase) {
            Phase.DAWN ->
                make(
                    listOf(0xFF1D3550, 0xFF2A465F, 0xFF5C4D58, 0xFF8A6656),
                    0xFF2A3446,
                    0xFF151C24,
                    0xFF3D4658,
                    true,
                    0xFFF3DCC0,
                    window = day,
                )
            Phase.DAY ->
                make(listOf(0xFF173350, 0xFF1F4262, 0xFF2D5674, 0xFF3F6B86), 0xFF20384A, 0xFF132330, 0xFF35506A, true, window = day)
            Phase.GOLDEN ->
                make(
                    listOf(0xFF1F3550, 0xFF334356, 0xFF5E4A37, 0xFF9A6A3C),
                    0xFF3A3326,
                    0xFF1A1712,
                    0xFF4D4536,
                    true,
                    0xFFF3D29A,
                    window = day,
                )
            Phase.DUSK ->
                make(
                    listOf(0xFF1A1C3A, 0xFF322B54, 0xFF6C4260, 0xFFB8644F),
                    0xFF2B2340,
                    0xFF17121F,
                    0xFF4F4266,
                    true,
                    0xFFF0915E,
                    window = lit,
                )
            Phase.NIGHT ->
                make(listOf(0xFF121A33, 0xFF181A30, 0xFF24243A, 0xFF2E2A44), 0xFF191826, 0xFF121110, 0xFF45405F, true, window = lit)
        }
    else
        when (phase) {
            Phase.DAWN ->
                make(
                    listOf(0xFF8FC1E8, 0xFFB7D6EE, 0xFFF1D6C2, 0xFFF7C9A4),
                    0xFFB3B0C3,
                    0xFF6A7568,
                    0xFFCFC8D8,
                    false,
                    0xFFFFF1D6,
                    window = day,
                )
            Phase.DAY ->
                make(listOf(0xFF5EA8E5, 0xFF8EC4EC, 0xFFC7E2F4, 0xFFE3F0F8), 0xFF9FBCAE, 0xFF4F6F58, 0xFFB7CBD9, false, window = day)
            Phase.GOLDEN ->
                make(
                    listOf(0xFF78AADB, 0xFFA7C3DC, 0xFFF0CF9C, 0xFFF4B46C),
                    0xFFC4A983,
                    0xFF5E5A42,
                    0xFFDCC6A2,
                    false,
                    0xFFFFE2A8,
                    window = day,
                )
            Phase.DUSK ->
                make(
                    listOf(0xFF2C3566, 0xFF4A4275, 0xFF6C4260, 0xFFE08A62),
                    0xFF4B3F62,
                    0xFF2C2440,
                    0xFF7D6A90,
                    true,
                    0xFFFFB37A,
                    window = lit,
                )
            Phase.NIGHT ->
                make(listOf(0xFF121A33, 0xFF181A30, 0xFF24243A, 0xFF2E2A44), 0xFF3A3550, 0xFF5B5568, 0xFF45405F, true, window = lit)
        }
}

private val STARS =
    listOf(
        floatArrayOf(0.06f, 0.30f, 0.7f, 1.3f),
        floatArrayOf(0.17f, 0.62f, 0.5f, 1.1f),
        floatArrayOf(0.29f, 0.18f, 0.8f, 1.4f),
        floatArrayOf(0.38f, 0.80f, 0.4f, 1.0f),
        floatArrayOf(0.47f, 0.42f, 0.6f, 1.2f),
        floatArrayOf(0.55f, 0.10f, 0.5f, 1.0f),
        floatArrayOf(0.63f, 0.68f, 0.45f, 1.1f),
        floatArrayOf(0.72f, 0.28f, 0.7f, 1.3f),
        floatArrayOf(0.84f, 0.88f, 0.4f, 1.0f),
        floatArrayOf(0.92f, 0.50f, 0.55f, 1.2f),
        floatArrayOf(0.11f, 0.95f, 0.35f, 1.0f),
        floatArrayOf(0.33f, 1.05f, 0.4f, 1.1f),
        floatArrayOf(0.58f, 0.98f, 0.3f, 1.0f),
        floatArrayOf(0.97f, 0.16f, 0.45f, 1.1f),
    )

internal const val ROAD_SCALE = 1.25f

internal val HORIZON = 115.dp

internal fun skyBrush(p: Palette, end: Float) =
    Brush.verticalGradient(0f to p.sky[0], 0.5f to p.sky[1], 0.86f to p.sky[2], 1f to p.sky[3], endY = end)

internal fun Modifier.skyBehind(sky: SkyState, page: Color, pull: PullView? = null): Modifier = drawBehind {
    val end = sky.end ?: return@drawBehind
    val p = sky.palette
    drawRect(skyBrush(p, end), size = Size(size.width, end))
    if (sky.short) {
        lowHorizon(end, page, p, sky.phase, pull)
        return@drawBehind
    }
    horizon(end - HORIZON.toPx(), page, p, sky.phase, sky.road, sky.depth(1.dp.toPx()).far * 1.dp.toPx(), ROAD_SCALE, pull = pull)
}

internal fun roadScene(width: Float, road: Road): PullScene {
    val w = width / ROAD_SCALE
    val sign = Pull.roadSign(w)
    val card = road.bus?.takeIf { road.stop }
    return PullScene(w, sign, card?.let { Pull.roadBus(sign, it.far) } ?: shuttleX(w).takeIf { road.shuttle })
}

internal fun shuttleX(w: Float): Float = (w * 0.58f).roundToInt().toFloat() - 19f

@Composable
internal fun SkyHead(room: Dp = 34.dp, content: @Composable ColumnScope.() -> Unit) {
    val sky = LocalSky.current
    if (sky == null) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
        return
    }
    val pull = LocalPull.current
    SkyInk(true, sky.palette.lightInk) {
        Column(
            Modifier.fillMaxWidth().drawBehind {
                celestial(sky.phase, room.toPx() + (pull?.read()?.pull ?: 0f) * 1.dp.toPx(), room.toPx(), sky.depth(1.dp.toPx()))
            }
        ) {
            PullRoom(room, above = 14.dp)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp), content = content)
        }
    }
}

@Composable
internal fun SkyGround(road: Road = Road()) {
    val sky = LocalSky.current ?: return
    SideEffect { sky.road = road }
    Spacer(
        Modifier.fillMaxWidth().height(10.dp + if (sky.short) LOW else HORIZON).onGloballyPositioned {
            sky.groundBottom = it.positionInRoot().y + it.size.height
        }
    )
}

private fun DrawScope.celestial(phase: Phase, room: Float, moonRoom: Float, depth: Parallax) {
    if (phase != Phase.NIGHT || depth.fade <= 0f) return
    translate(top = depth.sky * 1.dp.toPx()) { starsAndMoon(room, depth.fade, moonRoom) }
}

private fun farY(x: Float) = 30f + 6f * sin(x / 47f + 0.6f) + 4f * sin(x / 19f + 2.1f)

internal fun nearY(x: Float) = 52f + 3f * sin(x / 61f + 1.3f) + 1.5f * sin(x / 27f)

private fun dip(lo: Float, hi: Float): Float {
    var best = lo
    var x = lo
    while (x <= hi) {
        if (farY(x) > farY(best)) best = x
        x += 2f
    }
    return best
}

internal fun DrawScope.horizon(
    top: Float,
    page: Color,
    p: Palette,
    phase: Phase,
    road: Road,
    far: Float,
    scale: Float = 1f,
    withSun: Boolean = true,
    pull: PullView? = null,
) {
    val d = 1.dp.toPx() * scale
    val lights = phase == Phase.DUSK || phase == Phase.NIGHT
    val w = size.width / d
    fun at(x: Float, y: Float) = Offset(x * d, top + y * d)
    fun box(x: Float, y: Float, bw: Float, bh: Float, color: Color, r: Float = 0f) =
        drawRoundRect(color, at(x, y), Size(bw * d, bh * d), CornerRadius(r * d))
    fun shape(color: Color, vararg pts: Pair<Float, Float>) =
        drawPath(
            Path().apply {
                pts.forEachIndexed { i, (x, y) -> at(x, y).let { if (i == 0) moveTo(it.x, it.y) else lineTo(it.x, it.y) } }
                close()
            },
            color,
        )
    fun ridge(y: (Float) -> Float, color: Color) =
        drawPath(
            Path().apply {
                moveTo(0f, top + 92 * d)
                lineTo(0f, top + y(0f) * d)
                var x = 4f
                while (x < w + 4) {
                    lineTo(x * d, top + y(x) * d)
                    x += 4f
                }
                lineTo(size.width, top + 92 * d)
                close()
            },
            color,
        )
    val lit = MOON
    val dim = MOON.copy(alpha = 0.6f)
    fun across(f: Float) = (w * f).roundToInt().toFloat()
    val sx = Pull.roadSign(w)
    val flag = across(0.76f)
    clipRect(top = top, bottom = top + 92 * d) {
        translate(top = far) {
            p.sun
                ?.takeIf { withSun }
                ?.let { sun ->
                    when (phase) {
                        Phase.DAWN -> drawCircle(sun, 16 * d, at(across(0.3f), 42f))
                        Phase.GOLDEN -> drawCircle(sun, 16 * d, at(across(0.36f), 36f))
                        else -> drawCircle(sun, 26 * d, at(across(0.5f), 40f))
                    }
                }
            val mbs = dip(maxOf(across(0.8f) - 40, flag + 30), minOf(across(0.8f) + 40, w - 29))
            if (mbs + 25 <= w) {
                val city = farY(mbs) + 3
                for (x in floatArrayOf(-13f, -2f, 9f)) shape(
                    p.city,
                    mbs + x to city,
                    mbs + x + 1 to city - 26,
                    mbs + x + 5 to city - 26,
                    mbs + x + 6 to city,
                )
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
        }
    }
    for (f in floatArrayOf(0.06f, 0.45f, 0.9f)) {
        val c = across(f)
        rainTree(at(c, nearY(c)), d, p.tree)
    }
    val pole = nearY(flag)
    drawLine(p.tree, at(flag, pole + 2), at(flag, pole - 24), 1.2f * d)
    val red = Color(0xFFEF3340)
    val white = Color(0xFFF2EFEB)
    box(flag + 0.6f, pole - 24, 12f, 4f, red)
    box(flag + 0.6f, pole - 20, 12f, 4f, white)
    drawCircle(white, 1.5f * d, at(flag + 3.2f, pole - 22))
    drawCircle(red, 1.3f * d, at(flag + 3.8f, pole - 22))
    for (i in 0 until 5) {
        val a = i * 2 * PI.toFloat() / 5
        drawCircle(white, 0.35f * d, at(flag + 5.2f + 0.85f * sin(a), pole - 22 - 0.85f * cos(a)))
    }
    ridge(::nearY, page)
    drawLine(p.road, at(0f, 70f), at(w, 70f), 1.5f * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6 * d, 6 * d)))
    fun bus(x: Float, paint: Color, band: Color?, dim: Int = -1) = shuttle(at(x, 57f), d, paint, band, p.window, dim)
    if (pull?.read()?.open == true) {
        pullRoad(pull, p, top, d, sx, ownSign = road.stop, live = road.bus?.live != false, lights = lights)
        return
    }
    if (road.stop) {
        drawLine(p.post, at(sx, 70f), at(sx, 44f), 1.6f * d)
        box(sx - 6.5f, 33f, 13f, 13f, p.post, 2.5f)
        box(sx - 3.5f, 35.5f, 7f, 7.5f, p.postInk, 1.5f)
        box(sx - 2.5f, 36.5f, 5f, 3f, p.post, 0.5f)
    }
    val yours = road.bus
    if (yours != null && road.stop) {
        val colour = Color(yours.color)
        val x = Pull.roadBus(sx, yours.far)
        bus(x, colour, if (yours.live) Color.White.copy(alpha = 0.85f) else null)
    } else if (road.shuttle) {
        val x = shuttleX(w)
        if (lights) {
            val beam = listOf(at(x + 38, 66f), at(x + 60, 63f), at(x + 60, 70f))
            drawPath(
                Path().apply {
                    moveTo(beam[0].x, beam[0].y)
                    beam.drop(1).forEach { lineTo(it.x, it.y) }
                    close()
                },
                MOON.copy(alpha = 0.12f),
            )
        }
        bus(x, Color(SHUTTLE), SHUTTLE_BAND, dim = 3)
    }
}

internal fun DrawScope.rainTree(foot: Offset, d: Float, color: Color) {
    fun at(x: Float, y: Float) = Offset(foot.x + x * d, foot.y + y * d)
    val trunk = listOf(-1.5f to 2f, -1.5f to -7f, -7f to -13f, -4.5f to -13f, 0f to -9f, 4.5f to -13f, 7f to -13f, 1.5f to -7f, 1.5f to 2f)
    drawPath(
        Path().apply {
            trunk.forEachIndexed { i, (x, y) -> at(x, y).let { if (i == 0) moveTo(it.x, it.y) else lineTo(it.x, it.y) } }
            close()
        },
        color,
    )
    fun oval(cx: Float, cy: Float, rx: Float, ry: Float) = drawOval(color, at(cx - rx, cy - ry), Size(2 * rx * d, 2 * ry * d))
    oval(0f, -18f, 21f, 5.5f)
    oval(-8f, -21.5f, 11f, 4.5f)
    oval(8f, -22f, 12f, 4.5f)
}

internal fun DrawScope.shuttle(o: Offset, d: Float, paint: Color, band: Color?, glass: Color, dim: Int = -1, wheels: Boolean = true) {
    val solid = band != null
    fun pt(px: Float, py: Float) = Offset(o.x + px * d, o.y + py * d)
    fun part(bx: Float, by: Float, bw: Float, bh: Float, color: Color, r: Float, line: Float) =
        if (solid) drawRoundRect(color, pt(bx, by), Size(bw * d, bh * d), CornerRadius(r * d))
        else drawRoundRect(paint, pt(bx, by), Size(bw * d, bh * d), CornerRadius(r * d), style = Stroke(line * d))
    val body =
        Path().apply {
            fun to(px: Float, py: Float) = pt(px, py).let { lineTo(it.x, it.y) }
            fun curve(cx: Float, cy: Float, px: Float, py: Float) =
                pt(cx, cy).let { c -> pt(px, py).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            pt(1.5f, 0f).let { moveTo(it.x, it.y) }
            to(33f, 0f)
            curve(36f, 0f, 36.9f, 2.6f)
            to(38f, 8.5f)
            to(38f, 10.5f)
            curve(38f, 12f, 36.5f, 12f)
            to(1.5f, 12f)
            curve(0f, 12f, 0f, 10.5f)
            to(0f, 1.5f)
            curve(0f, 0f, 1.5f, 0f)
            close()
        }
    val screen =
        Path().apply {
            pt(35.6f, 2.5f).let { moveTo(it.x, it.y) }
            pt(36.2f, 2.5f).let { c -> pt(36.4f, 3.2f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            pt(37.1f, 7.2f).let { lineTo(it.x, it.y) }
            pt(35.6f, 7.2f).let { lineTo(it.x, it.y) }
            close()
        }
    part(5f, -1.6f, 14f, 1.9f, paint, 0.8f, 0.8f)
    if (band != null) {
        drawPath(body, paint)
        drawRoundRect(band, pt(0f, 9.5f), Size(38 * d, 2 * d), CornerRadius(0f))
    } else {
        drawPath(body, paint, style = Stroke(1.2f * d, join = StrokeJoin.Round))
    }
    for ((i, wx) in floatArrayOf(2.5f, 8.5f, 14.5f, 20.5f).withIndex()) part(
        wx,
        2.5f,
        5f,
        4f,
        if (i == dim) glass.copy(alpha = 0.6f) else glass,
        0.8f,
        0.6f,
    )
    part(26.5f, 2.5f, 4.5f, 4f, glass, 0.8f, 0.6f)
    part(32f, 2.5f, 2.8f, 8.2f, glass, 0.6f, 0.6f)
    if (solid) drawPath(screen, glass) else drawPath(screen, paint, style = Stroke(0.6f * d))
    if (solid) {
        drawRoundRect(Color(0xFFFEF3C7), pt(36.6f, 8.3f), Size(1.4f * d, 1.3f * d), CornerRadius(0.5f * d))
        drawRoundRect(Color(0xFFEF4444), pt(0f, 7.4f), Size(0.9f * d, 1.8f * d), CornerRadius(0.4f * d))
    }
    for (wx in SHUTTLE_WHEELS) {
        val arch = pt(wx - 3.2f, 8.8f)
        if (solid) drawArc(Color.Black.copy(alpha = 0.35f), 180f, 180f, true, arch, Size(6.4f * d, 6.4f * d))
        else drawArc(paint, 180f, 180f, false, arch, Size(6.4f * d, 6.4f * d), style = Stroke(1.2f * d))
        if (wheels) shuttleWheel(pt(wx, 12f), d)
    }
}

internal const val SHUTTLE = 0xFF24211EL
internal val SHUTTLE_BAND = Color(0xFFD32F2F)

internal val SHUTTLE_WHEELS = floatArrayOf(7.5f, 26f)

internal fun DrawScope.shuttleWheel(c: Offset, d: Float, turn: Float? = null) {
    val tyre = Color(0xFF151311)
    drawCircle(tyre, 2.2f * d, c)
    drawCircle(Color(0xFF8A847D), 0.8f * d, c)
    if (turn != null)
        rotate(turn * 180f / PI.toFloat(), pivot = c) {
            drawRect(tyre, Offset(c.x - 0.22f * d, c.y - 0.85f * d), Size(0.44f * d, 0.6f * d))
        }
}

internal fun DrawScope.starsAndMoon(room: Float, alpha: Float = 1f, moonRoom: Float = room, moonAt: Offset? = null) {
    for ((x, y, a, r) in STARS) drawCircle(
        Color.White.copy(alpha = a * alpha),
        r.dp.toPx(),
        Offset(size.width * x, room * 0.85f * y / 1.05f + 4.dp.toPx()),
    )
    val r = minOf(28.dp.toPx(), moonRoom * 0.3f)
    crescent(moonAt ?: Offset(size.width - 16.dp.toPx() - r, moonRoom * 0.48f), r, alpha)
}

internal fun DrawScope.crescent(c: Offset, r: Float, alpha: Float = 1f) {
    val moon = Path().apply { addOval(Rect(c, r)) }
    val bite = Path().apply { addOval(Rect(c + Offset(r * 0.46f, -r * 0.3f), r * 0.9f)) }
    drawPath(Path.combine(PathOperation.Difference, moon, bite), MOON, alpha = alpha)
}

@Composable
internal fun NightTheme(on: Boolean, content: @Composable () -> Unit) {
    val scheme = if (on) BrandDark else MaterialTheme.colorScheme
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
        CompositionLocalProvider(LocalContentColor provides if (on) scheme.onBackground else LocalContentColor.current, content = content)
    }
}

internal class SkyTones(val good: Color, val chip: Color, val smallAccent: Color)

internal val LocalSkyTones = staticCompositionLocalOf<SkyTones?> { null }

@Composable
internal fun SkyInk(on: Boolean, light: Boolean, content: @Composable () -> Unit) {
    fun glass(base: ColorScheme, pane: Color, raised: Color, line: Color, muted: Color, accent: Color, late: Color, warn: Color) =
        base.copy(
            surface = pane,
            surfaceContainerLowest = pane,
            surfaceContainerLow = pane,
            surfaceContainer = pane,
            surfaceContainerHigh = pane,
            surfaceContainerHighest = pane,
            surfaceVariant = raised,
            outlineVariant = line,
            onSurfaceVariant = muted,
            primary = accent,
            error = late,
            tertiary = warn,
        )
    val scheme =
        when {
            !on -> MaterialTheme.colorScheme
            light ->
                glass(
                    BrandDark,
                    Color.White.copy(alpha = 0.08f),
                    Color.White.copy(alpha = 0.13f),
                    Color.White.copy(alpha = 0.18f),
                    c(0xFFE7E5E4),
                    c(0xFFFB923C),
                    c(0xFFFECACA),
                    c(0xFFFCD34D),
                )
            else ->
                glass(
                    BrandLight,
                    Color.White.copy(alpha = 0.5f),
                    Color.White.copy(alpha = 0.65f),
                    c(0x291C1917),
                    c(0xFF36312D),
                    c(0xFF9A3412),
                    c(0xFF701818),
                    c(0xFF78350F),
                )
        }
    val tones =
        when {
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

@Composable internal fun smallAccent() = LocalSkyTones.current?.smallAccent ?: MaterialTheme.colorScheme.primary

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

@Composable
internal fun StatusStrip(sky: SkyState?, top: Dp, scroll: ScrollState) {
    val page = MaterialTheme.colorScheme.background
    StatusStrip(if (sky?.end != null) sky.palette.sky[0] else page, top, scroll)
}

@Composable
internal fun StatusStrip(phase: Phase, top: Dp, scroll: ScrollState) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    StatusStrip(palette(phase, dark).sky[0], top, scroll)
}

@Composable
private fun StatusStrip(color: Color, top: Dp, scroll: ScrollState) {
    Box(
        Modifier.fillMaxWidth()
            .height(top)
            .graphicsLayer { alpha = if (top.toPx() > 0f) (scroll.value / top.toPx()).coerceIn(0f, 1f) else 0f }
            .background(color)
    )
}

private val MOON_LINE = 24.dp

private val LOW = 52.dp

private val SHORT_FOOT = 12.dp

private fun DrawScope.lowHorizon(end: Float, page: Color, p: Palette, phase: Phase, pull: PullView?) {
    val d = 1.dp.toPx()
    val strip = end - 58 * d
    clipRect(top = end - LOW.toPx(), bottom = end) {
        horizon(strip, page, p, phase, Road(shuttle = false), 0f, withSun = false)
        if (pull?.read()?.open == true) pullHill(pull, p, strip, d, size.width / d, lights = phase == Phase.DUSK || phase == Phase.NIGHT)
    }
}

private val BAND_STARS =
    listOf(
        floatArrayOf(0.56f, 0.2f, 0.6f),
        floatArrayOf(0.63f, 0.7f, 0.45f),
        floatArrayOf(0.7f, 0.35f, 0.7f),
        floatArrayOf(0.78f, 0.8f, 0.4f),
        floatArrayOf(0.66f, 0.05f, 0.5f),
        floatArrayOf(0.95f, 0.85f, 0.45f),
    )

private val LOW_STARS =
    listOf(
        floatArrayOf(0.69f, 0.3f, 0.6f),
        floatArrayOf(0.74f, 0.75f, 0.45f),
        floatArrayOf(0.79f, 0.2f, 0.7f),
        floatArrayOf(0.83f, 0.65f, 0.4f),
        floatArrayOf(0.98f, 0.55f, 0.45f),
    )

@Composable
internal fun SkyBand(
    phase: Phase,
    top: Dp,
    moonLow: Boolean = false,
    content: @Composable () -> Unit,
) {
    val page = MaterialTheme.colorScheme.background
    val p = palette(phase, page.luminance() < 0.5f)
    val pull = LocalPull.current
    NightStatusBar(p.lightInk, p.sky[0])
    val pane = LocalSkyPane.current
    val short = windowShort()
    val hills = if (short) 0.dp else LOW
    val band = remember { Any() }
    if (pane != null) DisposableEffect(pane) { onDispose { pane.skies.gone(band) } }
    val shown = pane?.leading != true && !(short && moonLow)
    var natural by remember { mutableIntStateOf(0) }
    val grow = with(LocalDensity.current) { ((pane?.skies?.tallest ?: 0) - natural).coerceAtLeast(0).toDp() }
    Column(
        Modifier.fillMaxWidth().drawBehind {
            val d = 1.dp.toPx()
            val end = size.height
            drawRect(skyBrush(p, end))
            val floor = end - hills.toPx() - if (short) SHORT_FOOT.toPx() else 0f
            val row = if (moonLow) (floor - MOON_LINE.toPx())..floor else top.toPx()..floor
            val mid = (row.start + row.endInclusive) / 2
            val r = 11 * d
            val centre = Offset(size.width - 22 * d - r, mid)
            if (phase == Phase.NIGHT && shown) {
                for ((x, y, a) in if (moonLow) LOW_STARS else BAND_STARS) drawCircle(
                    Color.White.copy(alpha = a),
                    1.1f * d,
                    Offset(size.width * x, row.start + (row.endInclusive - row.start) * y),
                )
                crescent(centre, r + d)
            }
            if (!short) lowHorizon(end, page, p, phase, pull)
        }
    ) {
        Column(
            Modifier.onSizeChanged {
                natural = it.height
                pane?.skies?.report(band, it.height)
            }
        ) {
            Spacer(Modifier.height(top))
            SkyInk(true, p.lightInk) { Box(Modifier.column().padding(horizontal = 16.dp)) { content() } }
            if (moonLow && !short) Spacer(Modifier.height(MOON_LINE))
        }
        Spacer(Modifier.height(grow + if (short) SHORT_FOOT else LOW))
    }
}

private var statusOwner: Any? = null

internal object StatusSky {
    var color by mutableStateOf<Color?>(null)
}

@Composable
internal fun NightStatusBar(night: Boolean, sky: Color) {
    val view = LocalView.current
    val dark = isSystemInDarkTheme()
    if (view.isInEditMode) return
    DisposableEffect(night, dark, sky) {
        val me = Any()
        statusOwner = me
        val window = view.context.activity()?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.isAppearanceLightStatusBars = !dark && !night
        StatusSky.color = if (night) sky else null
        onDispose {
            if (statusOwner === me) {
                bars?.isAppearanceLightStatusBars = !dark
                StatusSky.color = null
            }
        }
    }
}

private tailrec fun Context.activity(): Activity? =
    when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.activity()
        else -> null
    }
