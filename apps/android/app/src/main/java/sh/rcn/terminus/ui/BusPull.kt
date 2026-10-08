package sh.rcn.terminus.ui

import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullHint
import sh.rcn.terminus.PullMotion
import sh.rcn.terminus.PullOutcome
import sh.rcn.terminus.PullScene
import sh.rcn.terminus.R
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Pull to refresh, drawn: "the bus pulls in". Dragged down at the top of its
 * content, the page slides down with rounded corners and a shadow, showing
 * a strip of the hour's sky behind it, low hills, a rain tree, the kerb and
 * your stop's sign; a shuttle in your service's colour rolls in to the stop
 * as it comes. Past the stop it kneels, the sign lights and letting go asks
 * again: the door opens, a honk, it drives off, and others go round until
 * the answer's in. The motion and its rules are PullMotion (Pull.kt); the
 * web's pull draws the same scene.
 */

/** The accent the bus is painted in when the screen has no service of its own. */
private const val ACCENT = 0xFFFB923CL

/**
 * [content] with pull to refresh: [onRefresh] asks again (or not, inside
 * [Pull.FRESH_MS]) and says how it went. The bus is in [livery] (null: the
 * accent); others go round in the other services' colours. [top] is the
 * status bar over the page. The chip saying how it went sits on the sky at
 * the right, [chipTop] under the status bar, or with [chipLow] at the foot
 * of the page, where a page with a field across its top has room. Off when
 * not [enabled].
 */
@Composable
internal fun BusPull(
    livery: Long?,
    top: Dp,
    phase: Phase,
    onRefresh: suspend () -> PullOutcome,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    chipTop: Dp = 14.dp,
    chipLow: Boolean = false,
    content: @Composable () -> Unit,
) {
    val view = LocalView.current
    val density = LocalDensity.current.density
    val page = MaterialTheme.colorScheme.background
    val dark = page.luminance() < 0.5f
    val sky = palette(phase, dark)
    val calm = animationsOff()
    val own = livery ?: ACCENT
    val others = remember(own) { LIVERY.map { it.second }.filter { it != own && it != 0xFF8A939CL } }
    val ask by rememberUpdatedState(onRefresh)
    val on by rememberUpdatedState(enabled)
    val scope = rememberCoroutineScope()
    BoxWithConstraints(modifier.fillMaxSize()) {
        val motion = remember(maxWidth, top, others.size) { PullMotion(PullScene(maxWidth.value), top.value, others.size) }
        motion.calm = calm
        // Read while drawing, so a frame redraws the scene and moves the page without composing.
        var frame by remember { mutableIntStateOf(0) }
        var running by remember { mutableStateOf(false) }
        var hint by remember { mutableStateOf<PullHint?>(null) }
        var chip by remember { mutableStateOf<PullOutcome?>(null) }
        var chipKey by remember { mutableIntStateOf(0) }
        var told by remember { mutableStateOf(true) }
        fun kick() {
            frame++
            hint = if (motion.phase == PullMotion.Phase.Idle) null else motion.hint
            if (motion.moving) running = true
        }
        LaunchedEffect(running) {
            if (!running) return@LaunchedEffect
            var last = withFrameNanos { it }
            while (motion.moving) {
                withFrameNanos { now ->
                    motion.step((now - last) / 1e9f)
                    last = now
                }
                // Closing: how it went, said once.
                val r = motion.result
                if (r != null && !told) {
                    told = true
                    chip = r
                    chipKey++
                }
                kick()
            }
            running = false
        }
        LaunchedEffect(chipKey) {
            if (chip == null) return@LaunchedEffect
            delay(Pull.CHIP_MS)
            chip = null
        }
        val connection = remember(motion) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    // Back up: the page goes first, then the content scrolls.
                    if (source != NestedScrollSource.UserInput || available.y >= 0f) return Offset.Zero
                    val used = motion.takeBack(available.y / density)
                    if (used == 0f) return Offset.Zero
                    kick()
                    return Offset(0f, used * density)
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    // Down, with the content already at its top: the page comes with the finger.
                    if (!on || source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
                    if (!motion.canGrab && motion.phase != PullMotion.Phase.Drag) return Offset.Zero
                    if (motion.phase != PullMotion.Phase.Drag) chip = null
                    if (motion.drag(available.y / density)) tick(view)
                    kick()
                    return Offset(0f, available.y)
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (motion.phase != PullMotion.Phase.Drag) return Velocity.Zero
                    if (motion.release()) {
                        told = false
                        scope.launch {
                            val outcome = try {
                                ask()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                PullOutcome.Failed
                            }
                            motion.done(outcome)
                            kick()
                        }
                    }
                    kick()
                    // The page took this drag: the content doesn't fling with it.
                    return available
                }
            }
        }
        Box(Modifier.fillMaxSize().nestedScroll(connection)) {
            val ink = if (sky.lightInk) Color(0xFFF5F3F0) else Color(0xFF1C1917)
            Canvas(Modifier.fillMaxSize()) {
                // Reading the frame redraws it each one.
                if (frame >= 0 && motion.open) pullScene(motion, sky, page, dark, Color(if (motion.colour == 0) own else others.getOrElse(motion.colour - 1) { own }), ink)
            }
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        translationY = if (frame >= 0) motion.pull * density else 0f
                        if (motion.open) {
                            shape = RoundedCornerShape(minOf(26f, motion.pull * 0.35f).dp)
                            clip = true
                            shadowElevation = 10.dp.toPx() * Pull.progress(motion.pull, top.value)
                        } else {
                            shape = RectangleShape
                            clip = false
                            shadowElevation = 0f
                        }
                    }
                    .background(page),
            ) { content() }
            hint?.let { h -> PullWords(h, motion, sky.lightInk, ink, density) { frame } }
            ResultChip(chip, if (chipLow) null else top + chipTop, sky.lightInk, ink, calm)
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

/**
 * The words over the road, beside the sign: "Pull to refresh", "Let go to
 * refresh", "Checking…", said as they change.
 */
@Composable
private fun PullWords(hint: PullHint, motion: PullMotion, lightInk: Boolean, ink: Color, density: Float, frame: () -> Int) {
    val words = stringResource(
        when (hint) {
            PullHint.Pull -> R.string.pull_to_refresh
            PullHint.LetGo -> R.string.pull_let_go
            PullHint.Checking -> R.string.checking
        },
    )
    val scene = motion.scene
    // Level with the sign's plate.
    val above = scene.height - scene.road + 30.5f * scene.scale + 13f
    Box(
        Modifier
            .fillMaxWidth()
            .offset { frame(); IntOffset(0, ((motion.pull - above) * density).roundToInt()) }
            .graphicsLayer { frame(); alpha = motion.hintAlpha },
        contentAlignment = Alignment.TopCenter,
    ) {
        Row(
            Modifier
                .background(skyChip(lightInk), CircleShape)
                .padding(start = if (hint == PullHint.Checking) 11.dp else 9.dp, end = 11.dp, top = 5.dp, bottom = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (hint != PullHint.Checking) Arrow(ink, up = hint == PullHint.LetGo, calm = motion.calm)
            Text(
                words,
                color = ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

/** An arrow down, turning to point up once letting go will ask. */
@Composable
private fun Arrow(ink: Color, up: Boolean, calm: Boolean) {
    val turn by androidx.compose.animation.core.animateFloatAsState(if (up) 180f else 0f, if (calm) tween(0) else tween(200), label = "arrow")
    Canvas(Modifier.size(14.dp).graphicsLayer { rotationZ = turn }) {
        val u = size.minDimension / 24f
        val stroke = Stroke(2.4f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawPath(Path().apply { moveTo(12 * u, 5 * u); lineTo(12 * u, 19 * u); moveTo(6 * u, 13 * u); lineTo(12 * u, 19 * u); lineTo(18 * u, 13 * u) }, ink, style = stroke)
    }
}

/** The chip small words sit on over the sky ([SkyTones]): dark on a light sky's frost, light on a dark one's shade. */
private fun skyChip(lightInk: Boolean) = if (lightInk) Color.Black.copy(alpha = 0.22f) else Color.White.copy(alpha = 0.65f)

/**
 * How the pull went, for [Pull.CHIP_MS]: "Updated just now", "Up to date",
 * "Couldn't update". At the top right on the sky, [y] down; null: at the
 * foot of the page, centred, on the page's own colours.
 */
@Composable
private fun androidx.compose.foundation.layout.BoxScope.ResultChip(outcome: PullOutcome?, y: Dp?, skyInk: Boolean, skyText: Color, calm: Boolean) {
    // Kept while it fades out, after it's gone.
    var last by remember { mutableStateOf(PullOutcome.Updated) }
    if (outcome != null) last = outcome
    AnimatedVisibility(
        visible = outcome != null,
        modifier = if (y != null) Modifier.align(Alignment.TopEnd).padding(top = y, end = 16.dp) else Modifier.align(Alignment.BottomCenter).padding(bottom = 16.dp),
        // In from the edge it sits at.
        enter = if (calm) fadeIn(tween(200)) else fadeIn(tween(250)) + slideInVertically(tween(350)) { if (y != null) -it / 2 else it / 2 },
        exit = if (calm) fadeOut(tween(200)) else fadeOut(tween(250)) + slideOutVertically(tween(250)) { if (y != null) -it / 3 else it / 3 },
    ) {
        val c = MaterialTheme.colorScheme
        // Off the sky, light words on a dark page and dark on a light one, as the sky's are.
        val lightInk = if (y != null) skyInk else c.background.luminance() < 0.5f
        val ink = if (y != null) skyText else c.onSurface
        val good = if (lightInk) Color(0xFF86EFAC) else Color(0xFF14532D)
        val late = if (lightInk) Color(0xFFFECACA) else Color(0xFF701818)
        Row(
            Modifier
                .then(if (y != null) Modifier.background(skyChip(lightInk), CircleShape) else Modifier.shadow(6.dp, CircleShape).background(c.surface, CircleShape))
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            val dot = if (last == PullOutcome.Failed) late else good
            Box(Modifier.size(13.dp).background(dot.copy(alpha = 0.22f), CircleShape).padding(3.dp).background(dot, CircleShape))
            Text(
                stringResource(
                    when (last) {
                        PullOutcome.Updated -> R.string.pull_updated
                        PullOutcome.UpToDate -> R.string.pull_up_to_date
                        PullOutcome.Failed -> R.string.pull_failed
                    },
                ),
                color = ink,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

/* ---------- the scene ---------- */

/** The scene's hills: low, along the strip, x dp across. */
private fun sceneFar(x: Float) = 60f + 5f * sin(x / 41f + 1.2f) + 3f * sin(x / 17f)
private fun sceneNear(x: Float) = 74f + 2.5f * sin(x / 53f + 0.4f) + 1.2f * sin(x / 23f)

private val LIT = Color(0xFFFB923C)

/**
 * The strip the pull shows, its foot on the page's top edge: the hour's sky
 * ([p]), the hills, a rain tree, the kerb, your stop's sign, the puffs and
 * the bus in [livery]. [page] is the near hill, so the ground meets the page.
 */
private fun DrawScope.pullScene(m: PullMotion, p: Palette, page: Color, dark: Boolean, livery: Color, ink: Color) {
    val d = 1.dp.toPx()
    val s = m.scene
    val foot = m.pull * d
    val top = foot - s.height * d
    fun at(x: Float, y: Float) = Offset(x * d, top + y * d)
    clipRect(bottom = foot) {
        // The sky, deepening upwards, and on up under the status bar.
        val high = lerp(p.sky[0], Color(0xFF0B1E33), 0.22f)
        drawRect(Brush.verticalGradient(0f to high, 0.45f to p.sky[0], 0.7f to p.sky[1], startY = top, endY = foot))
        fun ridge(y: (Float) -> Float, color: Color, alpha: Float = 1f) = drawPath(
            Path().apply {
                moveTo(0f, foot + d)
                lineTo(0f, top + y(0f) * d)
                var x = 4f
                while (x < s.width + 4) { lineTo(x * d, top + y(x) * d); x += 4f }
                lineTo(size.width, foot + d)
                close()
            },
            color,
            alpha = alpha,
        )
        ridge(::sceneFar, p.far, 0.75f)
        rainTree(at(30f, sceneNear(30f)), d * 1.15f, p.tree)
        ridge(::sceneNear, page)
        val dash = 9 * d
        drawLine(if (dark) Color(0xFF4A4540) else p.road, at(0f, s.road), at(s.width, s.road), 2 * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash)))
        sign(m, p, at(s.sign, s.road), d * s.scale)
        for (f in m.puffs) {
            val k = f.age / 0.6f
            drawCircle(ink.copy(alpha = 0.35f), (2 + k * 5) * d, at(f.x - k * 14, f.y - k * 7), alpha = 0.5f * (1 - k))
        }
        bus(m, p, dark, livery, ink, at(m.busX, s.busTop), d * s.scale)
    }
}

/** Your stop's sign, its foot at [o]: lit in the accent, with a ring going out from it, while letting go would ask or the bus is at it. */
private fun DrawScope.sign(m: PullMotion, p: Palette, o: Offset, u: Float) {
    fun at(x: Float, y: Float) = Offset(o.x + x * u, o.y + y * u)
    fun box(x: Float, y: Float, w: Float, h: Float, color: Color, r: Float) = drawRoundRect(color, at(x, y), Size(w * u, h * u), CornerRadius(r * u))
    val lit = m.lit
    if (lit && !m.calm) {
        val k = (m.clock % 1.1f) / 1.1f
        drawCircle(LIT, (7 + 9 * k) * u, at(0f, -30.5f), alpha = 0.8f * (1 - k), style = Stroke(1.2f * u))
    }
    drawLine(p.post, at(0f, 0f), at(0f, -26f), 1.6f * u)
    box(-6.5f, -37f, 13f, 13f, if (lit) LIT else p.post, 2.5f)
    box(-3.5f, -34.5f, 7f, 7.5f, if (lit) Color(0xFF1C1917) else p.postInk, 1.5f)
    box(-2.5f, -33.5f, 5f, 3f, if (lit) LIT else p.post, 0.5f)
}

/**
 * The bus, its top left at [o], [u] px a unit: the body bobbing and
 * pitching on its suspension over wheels that turn, the door lit as it
 * opens, a honk, and its headlight on a dark phone.
 */
private fun DrawScope.bus(m: PullMotion, p: Palette, dark: Boolean, livery: Color, ink: Color, o: Offset, u: Float) {
    fun at(x: Float, y: Float) = Offset(o.x + x * u, o.y + y * u)
    val faded = m.alpha < 1f
    if (m.alpha <= 0f) return
    if (faded) drawIntoCanvas { it.saveLayer(androidx.compose.ui.geometry.Rect(at(-2f, -4f), at(66f, 16f)), Paint().apply { alpha = m.alpha }) }
    translate(top = m.bob * u) {
        rotate(m.tilt, pivot = at(7.5f, 12f)) {
            if (dark) drawPath(Path().apply { at(38f, 9f).let { moveTo(it.x, it.y) }; at(64f, 5.5f).let { lineTo(it.x, it.y) }; at(64f, 13.5f).let { lineTo(it.x, it.y) }; close() }, Color(0xFFFDE9C9), alpha = 0.14f)
            shuttle(o, u, livery, Color.White.copy(alpha = 0.85f), p.window, dim = 3, wheels = false)
            if (m.door > 0f) drawRoundRect(Color(0xFFFBBF24), at(32f, 2.5f), Size(2.8f * u, 8.2f * u), CornerRadius(0.6f * u), alpha = m.door)
        }
    }
    for (x in SHUTTLE_WHEELS) shuttleWheel(at(x, 12f), u, m.wheel)
    if (m.honk > 0f) {
        val shift = m.honk * 0.8f
        val arcs = Path().apply {
            at(40.2f + shift, 3.2f).let { moveTo(it.x, it.y) }
            at(41.7f + shift, 5.6f).let { c -> at(40.2f + shift, 8f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
            at(42.4f + shift, 1.6f).let { moveTo(it.x, it.y) }
            at(45.2f + shift, 5.6f).let { c -> at(42.4f + shift, 9.6f).let { quadraticTo(c.x, c.y, it.x, it.y) } }
        }
        drawPath(arcs, ink, alpha = m.honk.coerceIn(0f, 1f), style = Stroke(0.75f * u, cap = StrokeCap.Round))
    }
    if (faded) drawIntoCanvas { it.restore() }
}
