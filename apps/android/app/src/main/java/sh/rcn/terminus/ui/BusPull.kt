package sh.rcn.terminus.ui

import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullHint
import sh.rcn.terminus.PullMotion
import sh.rcn.terminus.PullOutcome
import sh.rcn.terminus.PullScene
import sh.rcn.terminus.R
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.roundToInt

/*
 * Pull to refresh, drawn: "the sky stretches". Pulled down at the top of its
 * content, the screen's own sky grows: the room above the card's words (or
 * the stop's name) opens by the pull ([PullRoom]), the header and chips
 * come down a little with it ([pullLead]), and the sky's gradient runs on
 * down to the horizon's new place, so the top of the screen is the sky's
 * own colour throughout and there is no edge anywhere. A pill in the sky's
 * ink in the middle of the room says what's happening. The horizon is the
 * animation: on Now a bus drives along its road to your stop's sign
 * ([pullRoad]); on Buses a sign grows out of the near hill and the bus
 * drives along the hilltop to it ([pullHill]). The motion and its rules are
 * PullMotion (Pull.kt); the web's pull draws the same.
 */

/** P's grey, left out of the buses going round: it would look like no service at all. */
private const val GREY = 0xFF8A939CL

private val LIT = Color(0xFFFB923C)
private val GOOD = Color(0xFF22C55E)

/**
 * A pull in progress, for what's drawn and laid out with it: the room, the
 * pill, the header's lead, and the horizon. Reading [read] while drawing or
 * laying out follows it frame by frame without composing.
 */
@Stable
internal class PullView(val motion: PullMotion) {
    internal var frame by mutableIntStateOf(0)

    /** The pill's words; null at rest, so it's only composed while pulling. */
    var hint by mutableStateOf<PullHint?>(null)
    /** With [PullHint.UpToDate]: the seconds until new times come, when the screen knows ([Pull.inS]). */
    var nextInS by mutableStateOf<Int?>(null)
    /** The bus's paint; with no service of its own, the horizon's shuttle ([SHUTTLE]). */
    var livery = SHUTTLE
    var others: List<Long> = emptyList()

    /** The motion, read so that whatever reads it redraws (or lays out again) each frame. */
    fun read(): PullMotion {
        frame
        return motion
    }

    /** The bus's paint: the screen's own service, else the one going round. */
    fun colour(m: PullMotion) = Color(if (m.colour == 0) livery else others.getOrElse(m.colour - 1) { livery })

    /** The stripe along its bottom: white on a service's colour, red on the shuttle. */
    fun band(m: PullMotion) = if (m.colour == 0 && livery == SHUTTLE) SHUTTLE_BAND else Color.White.copy(alpha = 0.85f)
}

/** The pull around what's shown; null where there's none (Settings' bands). */
internal val LocalPull = staticCompositionLocalOf<PullView?> { null }

/**
 * [content] with pull to refresh: [onRefresh] asks again (or not, inside
 * [Pull.FRESH_MS]) and says how it went; when it didn't ask, [nextUpdateAt]
 * (null: unknown) is when the screen's timed refresh brings new times, for
 * the pill to say. The bus is in [livery] (null: the
 * horizon's shuttle); others go round in the other services' colours. [scene] gives the
 * horizon's places for the screen's width in dp. [content] lays out the
 * room ([PullRoom]) and draws the horizon with the [PullView] it's given
 * (also in [LocalPull]). Off when not [enabled].
 */
@Composable
internal fun BusPull(
    livery: Long?,
    scene: (Float) -> PullScene,
    onRefresh: suspend () -> PullOutcome,
    modifier: Modifier = Modifier,
    nextUpdateAt: () -> Long? = { null },
    enabled: Boolean = true,
    content: @Composable (PullView) -> Unit,
) {
    val view = LocalView.current
    val density = LocalDensity.current.density
    val calm = animationsOff()
    val own = livery ?: SHUTTLE
    val others = remember(own) { LIVERY.map { it.second }.filter { it != own && it != GREY } }
    val ask by rememberUpdatedState(onRefresh)
    val nextAt by rememberUpdatedState(nextUpdateAt)
    val on by rememberUpdatedState(enabled)
    val sceneOf by rememberUpdatedState(scene)
    val scope = rememberCoroutineScope()
    BoxWithConstraints(modifier.fillMaxSize()) {
        val width by rememberUpdatedState(maxWidth.value)
        val pv = remember { PullView(PullMotion(sceneOf(width), others.size)) }
        val motion = pv.motion
        motion.calm = calm
        motion.others = others.size
        pv.livery = own
        pv.others = others
        var running by remember { mutableStateOf(false) }
        fun kick() {
            pv.frame++
            pv.hint = motion.hint
            if (motion.moving) running = true
        }
        LaunchedEffect(running) {
            if (!running) return@LaunchedEffect
            var last = withFrameNanos { it }
            while (motion.moving) {
                withFrameNanos { now ->
                    // The card's bus may have moved with the answer: it comes back to where it is now.
                    motion.scene = sceneOf(width)
                    motion.step((now - last) / 1e9f)
                    last = now
                }
                kick()
            }
            running = false
        }
        val connection = remember(motion) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    // Back up: the sky closes first, then the content scrolls.
                    if (source != NestedScrollSource.UserInput || available.y >= 0f) return Offset.Zero
                    val used = motion.takeBack(available.y / density)
                    if (used == 0f) return Offset.Zero
                    kick()
                    return Offset(0f, used * density)
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    // Down, with the content at its top since the finger went down: the sky stretches with the finger.
                    if (source == NestedScrollSource.UserInput && consumed.y != 0f) motion.contentScrolled()
                    if (!on || source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
                    if (!motion.canGrab && motion.phase != PullMotion.Phase.Drag) return Offset.Zero
                    if (motion.phase == PullMotion.Phase.Idle) motion.scene = sceneOf(width)
                    if (motion.drag(available.y / density)) tick(view)
                    kick()
                    return Offset(0f, available.y)
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (motion.phase != PullMotion.Phase.Drag) return Velocity.Zero
                    if (motion.release()) {
                        scope.launch {
                            val outcome = try {
                                ask()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                PullOutcome.Failed
                            }
                            pv.nextInS = if (outcome == PullOutcome.UpToDate) Pull.inS(nextAt(), System.currentTimeMillis()) else null
                            motion.done(outcome)
                            kick()
                        }
                    }
                    kick()
                    // The pull took this drag: the content doesn't fling with it.
                    return available
                }
            }
        }
        CompositionLocalProvider(LocalPull provides pv) {
            Box(
                Modifier
                    .fillMaxSize()
                    // Each touch starts afresh: seen before the content takes it, and left for it.
                    .pointerInput(motion) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                            motion.touch()
                        }
                    }
                    .nestedScroll(connection),
            ) { content(pv) }
        }
    }
}

/** A light tick as the bus reaches the stop: the gesture's own where the phone has it. */
private fun tick(view: View) {
    view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 34) HapticFeedbackConstants.GESTURE_THRESHOLD_ACTIVATE else HapticFeedbackConstants.CLOCK_TICK)
}

/** The phone's "Remove animations" is on (checked again on coming back to the app). */
@Composable
internal fun animationsOff(): Boolean {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    fun read() = Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    var off by remember { mutableStateOf(read()) }
    LaunchedEffect(Unit) { lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { off = read() } }
    return off
}

/** What's above the room comes down a little with the pull ([Pull.LEAD]). */
internal fun Modifier.pullLead(pv: PullView?): Modifier =
    if (pv == null) this else graphicsLayer { translationY = pv.read().lead * density }

/**
 * The room in the sky above the words: [base] at rest, and taller by the
 * pull, with the pill in the middle of what opened, between what's [above]
 * it (its gap over the room) and the words [below]. Outside a pull, just
 * [base]. In the sky's ink ([SkyInk]).
 */
@Composable
internal fun PullRoom(base: Dp = 0.dp, above: Dp = 0.dp, below: Dp = 0.dp) {
    val pv = LocalPull.current
    if (pv == null) {
        if (base > 0.dp) Spacer(Modifier.height(base))
        return
    }
    val hint = pv.hint
    Layout(content = { if (hint != null) Pill(hint, pv.motion.calm, pv.nextInS) }, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
        val m = pv.read()
        val pills = measurables.map { it.measure(Constraints()) }
        val room = (base.toPx() + m.pull * density).roundToInt()
        layout(constraints.maxWidth, room) {
            val centre = Pull.pillCentre(above.value, base.value + m.pull + below.value, m.pull) * density
            val show = m.hintAlpha
            for (p in pills) {
                p.placeWithLayer((constraints.maxWidth - p.width) / 2, (centre - p.height / 2f).roundToInt()) {
                    alpha = show
                    scaleX = 0.92f + 0.08f * show
                    scaleY = scaleX
                }
            }
        }
    }
}

/**
 * The pill: "Pull to refresh" with an arrow down, "Let go to refresh" with
 * it up, "Checking…" turning, then how it went with a dot: green, or amber
 * for "Couldn't update". Only what changes on its own is read out.
 */
@Composable
private fun Pill(hint: PullHint, calm: Boolean, nextInS: Int?) {
    val ink = LocalContentColor.current
    val tones = LocalSkyTones.current
    val chip = tones?.chip ?: MaterialTheme.colorScheme.surfaceVariant
    val good = tones?.good ?: GOOD
    val words = if (hint == PullHint.UpToDate && nextInS != null) stringResource(R.string.pull_up_to_date_next_s, nextInS) else stringResource(
        when (hint) {
            PullHint.Pull -> R.string.pull_to_refresh
            PullHint.LetGo -> R.string.pull_let_go
            PullHint.Checking -> R.string.checking
            PullHint.Updated -> R.string.pull_updated
            PullHint.UpToDate -> R.string.pull_up_to_date
            PullHint.Failed -> R.string.pull_failed
        },
    )
    val said = hint != PullHint.Pull && hint != PullHint.LetGo
    Row(
        Modifier.background(chip, CircleShape).padding(start = 10.dp, end = 13.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        when (hint) {
            PullHint.Pull, PullHint.LetGo -> Arrow(ink, up = hint == PullHint.LetGo, calm = calm)
            PullHint.Checking -> if (!calm) CircularProgressIndicator(Modifier.size(12.dp), color = ink, strokeWidth = 2.dp)
            PullHint.Updated, PullHint.UpToDate -> Box(Modifier.size(7.dp).background(good, CircleShape))
            PullHint.Failed -> Box(Modifier.size(7.dp).background(MaterialTheme.colorScheme.tertiary, CircleShape))
        }
        Text(
            words,
            color = ink,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = if (said) Modifier.semantics { liveRegion = LiveRegionMode.Polite } else Modifier,
        )
    }
}

/** An arrow down, turning to point up once letting go will ask. */
@Composable
private fun Arrow(ink: Color, up: Boolean, calm: Boolean) {
    val turn by animateFloatAsState(if (up) 180f else 0f, if (calm) tween(0) else tween(200), label = "arrow")
    Canvas(Modifier.size(14.dp).graphicsLayer { rotationZ = turn }) {
        val u = size.minDimension / 24f
        val stroke = Stroke(2.4f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawPath(Path().apply { moveTo(12 * u, 5 * u); lineTo(12 * u, 19 * u); moveTo(6 * u, 13 * u); lineTo(12 * u, 19 * u); lineTo(18 * u, 13 * u) }, ink, style = stroke)
    }
}

/* ---------- on the horizon ---------- */

/**
 * The pull on Now's horizon, in place of the road's own sign and bus: the
 * sign at [sign] (faded in by the pull when the road has none, [ownSign]),
 * the puffs, and the bus on the road. [top] is the horizon's top and [d]
 * its px a unit; a timetable guess's bus stays an outline (not [live]).
 * [lights]: after dark, its headlight on as it drives.
 */
internal fun DrawScope.pullRoad(v: PullView, p: Palette, top: Float, d: Float, sign: Float, ownSign: Boolean, live: Boolean, lights: Boolean) {
    val m = v.read()
    val road = { _: Float -> 70f }
    pullSign(m, p, Offset(sign * d, top + 70 * d), d, post = 26f, grow = if (ownSign) 1f else m.signGrow, rise = false)
    pullBus(v, m, p, top, d, road, slope = false, band = live || m.colour != 0, lights = lights)
}

/**
 * The pull on the low horizon (Buses), from its strip's [top], [d] px a
 * unit, [width] units across: a sign growing out of the near hill, and the
 * bus along the hilltop to it, tilting with the slope.
 */
internal fun DrawScope.pullHill(v: PullView, p: Palette, top: Float, d: Float, width: Float, lights: Boolean) {
    val m = v.read()
    val hill = { x: Float -> nearY(x) + 0.6f }
    val sx = Pull.hillSign(width)
    pullSign(m, p, Offset(sx * d, top + hill(sx) * d), d, post = 22f, grow = m.signGrow, rise = true)
    pullBus(v, m, p, top, d, hill, slope = true, band = true, lights = lights)
}

/**
 * The stop's sign, its foot at [o], [u] px a unit, its post [post] tall:
 * lit in the accent with a ring going out from it while letting go would
 * ask and while it asks, green once the answer's in. [grow] (0–1) fades it
 * in, or with [rise] grows it up out of the ground.
 */
private fun DrawScope.pullSign(m: PullMotion, p: Palette, o: Offset, u: Float, post: Float, grow: Float, rise: Boolean) {
    if (grow <= 0f) return
    val alpha = if (rise) 1f else grow
    fun at(x: Float, y: Float) = Offset(o.x + x * u, o.y + y * u)
    fun box(x: Float, y: Float, w: Float, h: Float, color: Color, r: Float) = drawRoundRect(color, at(x, y), Size(w * u, h * u), CornerRadius(r * u), alpha = alpha)
    val plate = -(post + 11)
    val face = when {
        m.good -> GOOD
        m.lit -> LIT
        else -> p.post
    }
    val mark = if (face == p.post) p.postInk else Color(0xFF1C1917)
    scale(1f, if (rise) grow else 1f, pivot = o) {
        if (m.lit && !m.calm) {
            val k = (m.clock % 1.1f) / 1.1f
            drawCircle(LIT, (7 + 9 * k) * u, at(0f, plate + 6.5f), alpha = 0.8f * (1 - k) * alpha, style = Stroke(1.2f * u))
        }
        drawLine(p.post, at(0f, 0f), at(0f, -post), 1.6f * u, alpha = alpha)
        box(-6.5f, plate, 13f, 13f, face, 2.5f)
        box(-3.5f, plate + 2.5f, 7f, 7.5f, mark, 1.5f)
        box(-2.5f, plate + 3.5f, 5f, 3f, face, 0.5f)
    }
}

/**
 * The bus at the motion's place on [ground] (units down the strip at x),
 * its puffs behind it: the body bobbing and pitching on its suspension
 * over wheels that turn, along the [slope] of the hill, the door lit as it
 * opens, and a honk. Without a [band] it's an outline, as a timetable
 * guess is on the horizon.
 */
private fun DrawScope.pullBus(v: PullView, m: PullMotion, p: Palette, top: Float, d: Float, ground: (Float) -> Float, slope: Boolean, band: Boolean, lights: Boolean) {
    for (f in m.puffs) {
        val k = f.age / 0.6f
        drawCircle(Color.White, (1.4f + k * 3.6f) * d, Offset((f.x - k * 10) * d, top + (ground(f.x) - 4.2f - k * 5) * d), alpha = 0.55f * (1 - k))
    }
    if (m.alpha <= 0f) return
    val x = m.busX
    val o = Offset(x * d, top + (ground(x + 19) - 13f) * d)
    fun at(bx: Float, by: Float) = Offset(o.x + bx * d, o.y + by * d)
    val angle = if (slope) (atan2(ground(x + 30) - ground(x + 8), 22f) * 180f / PI.toFloat()) else 0f
    val faded = m.alpha < 1f
    if (faded) drawIntoCanvas { it.saveLayer(Rect(at(-4f, -6f), at(66f, 18f)), Paint().apply { alpha = m.alpha }) }
    rotate(angle, pivot = at(19f, 13f)) {
        translate(top = m.bob * d) {
            rotate(m.tilt, pivot = at(7.5f, 12f)) {
                if (lights && m.drive != PullMotion.Drive.Follow) {
                    drawPath(Path().apply { at(38f, 9f).let { moveTo(it.x, it.y) }; at(60f, 6f).let { lineTo(it.x, it.y) }; at(60f, 13f).let { lineTo(it.x, it.y) }; close() }, MOON, alpha = 0.14f)
                }
                shuttle(o, d, v.colour(m), if (band) v.band(m) else null, p.window, dim = 3, wheels = false)
                if (m.door > 0f) drawRoundRect(Color(0xFFFBBF24), at(32f, 2.5f), Size(2.8f * d, 8.2f * d), CornerRadius(0.6f * d), alpha = m.door)
            }
        }
        for (wx in SHUTTLE_WHEELS) shuttleWheel(at(wx, 12f), d, m.wheel)
        if (m.honk > 0f) {
            val shift = m.honk * 0.8f
            val arcs = Path().apply {
                at(40.2f + shift, 3.2f).let { moveTo(it.x, it.y) }
                at(41.7f + shift, 5.6f).let { c -> at(40.2f + shift, 8f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
                at(42.4f + shift, 1.6f).let { moveTo(it.x, it.y) }
                at(45.2f + shift, 5.6f).let { c -> at(42.4f + shift, 9.6f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            }
            drawPath(arcs, if (p.lightInk) Color(0xFFF5F3F0) else Color(0xFF1C1917), alpha = m.honk.coerceIn(0f, 1f), style = Stroke(0.75f * d, cap = StrokeCap.Round))
        }
    }
    if (faded) drawIntoCanvas { it.restore() }
}
