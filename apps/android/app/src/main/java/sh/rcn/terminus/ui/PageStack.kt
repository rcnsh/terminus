package sh.rcn.terminus.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException

@Composable
internal fun <T> PageStack(
    stack: List<T>,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (T?) -> Unit,
) {
    val back by rememberUpdatedState(onBack)
    val motion = remember { Motion(stack) }
    motion.follow(stack)
    motion.version
    val peel = motion.peel
    val enter = motion.enter

    PredictiveBackHandler(enabled = stack.isNotEmpty()) { events ->
        var swipe: Peeling<T>? = null
        try {
            events.collect { event ->
                val p =
                    swipe
                        ?: Peeling(stack.dropLast(1), stack.last(), stack.size, event.swipeEdge == BackEventCompat.EDGE_RIGHT, event.touchY)
                            .also {
                                swipe = it
                                motion.start(it)
                            }
                p.progress = event.progress
                p.dy = event.touchY - p.startY
            }
            swipe?.phase = PeelPhase.Released
            back()
        } catch (e: CancellationException) {
            swipe?.phase = PeelPhase.Cancelled
            throw e
        }
    }

    val phase = peel?.phase
    LaunchedEffect(peel, phase) {
        val p = peel ?: return@LaunchedEffect
        when (phase) {
            PeelPhase.Released -> {
                p.release.animateTo(1f, tween(Peel.RELEASE_MS, easing = LinearEasing)) {
                    if (value >= 0.2f) p.cardGone = true
                }
                motion.end(p)
            }
            PeelPhase.Cancelled -> {
                val dy = p.dy
                val from = p.progress
                animate(from, 0f, animationSpec = tween(200)) { v, _ ->
                    p.progress = v
                    p.dy = if (from > 0f) dy * v / from else 0f
                }
                motion.end(p)
            }
            else -> Unit
        }
    }
    LaunchedEffect(enter) {
        val e = enter ?: return@LaunchedEffect
        e.alpha.animateTo(1f, tween(150))
        motion.endEnter(e)
    }

    val background = MaterialTheme.colorScheme.background
    val dimMost = if (background.luminance() < 0.5f) Peel.DIM_DARK else Peel.DIM_LIGHT
    val layers = buildList {
        if (peel != null) {
            add(
                Layer(
                    peel.under.size,
                    peel.under.lastOrNull(),
                    Modifier.graphicsLayer {
                        val f = peel.frame(size, this)
                        place(f.under)
                        shape = RoundedCornerShape(f.underRound * 28.dp.toPx())
                        clip = true
                    },
                )
            )
            add(Layer(-1, null, Modifier.drawBehind { drawRect(Color.Black, alpha = dimMost * peel.frame(size, this).dim) }, page = false))
            if (!peel.cardGone) {
                add(
                    Layer(
                        peel.depth,
                        peel.card,
                        Modifier.graphicsLayer {
                            val f = peel.frame(size, this)
                            place(f.card)
                            shape = RoundedCornerShape(f.round * 28.dp.toPx())
                            clip = true
                            shadowElevation = f.round * 6.dp.toPx()
                        },
                    )
                )
            }
        } else {
            if (enter != null) add(Layer(enter.from.size, enter.from.lastOrNull(), Modifier))
            add(
                Layer(
                    stack.size,
                    stack.lastOrNull(),
                    if (enter != null) Modifier.graphicsLayer { alpha = enter.alpha.value } else Modifier,
                )
            )
        }
    }
    Box(modifier) {
        for (layer in layers) {
            key(layer.depth, layer.key) {
                if (layer.page) {
                    Box(Modifier.fillMaxSize().then(layer.modifier).background(background)) {
                        CompositionLocalProvider(LocalPageDepth provides layer.depth) { content(layer.key) }
                    }
                } else {
                    Box(Modifier.fillMaxSize().then(layer.modifier))
                }
            }
        }
    }
}

internal val LocalPageDepth = compositionLocalOf { 0 }

private class Layer<T>(val depth: Int, val key: T?, val modifier: Modifier, val page: Boolean = true)

private enum class PeelPhase {
    Held,
    Released,
    Cancelled,
}

private class Peeling<T>(val under: List<T>, val card: T, val depth: Int, val fromRight: Boolean, val startY: Float) {
    var phase by mutableStateOf(PeelPhase.Held)
    var progress by mutableFloatStateOf(0f)
    var dy by mutableFloatStateOf(0f)
    val release = Animatable(0f)
    var cardGone by mutableStateOf(false)

    fun frame(size: Size, density: Density): Peel.Frame =
        with(density) {
            Peel.frame(
                progress,
                fromRight,
                dy,
                size.width,
                size.height,
                Peel.MARGIN_DP.dp.toPx(),
                Peel.ENTER_OFFSET_DP.dp.toPx(),
                release.value,
            )
        }

    companion object {
        fun <T> tapped(under: List<T>, card: T, depth: Int) = Peeling(under, card, depth, false, 0f).apply { phase = PeelPhase.Released }
    }
}

private class Entering<T>(val from: List<T>) {
    val alpha = Animatable(0f)
}

private class Motion<T>(private var seen: List<T>) {
    var version by mutableIntStateOf(0)
    var peel: Peeling<T>? = null
        private set

    var enter: Entering<T>? = null
        private set

    fun follow(stack: List<T>) {
        if (stack == seen) return
        val was = seen
        seen = stack
        val p = peel
        when {
            p != null && p.phase == PeelPhase.Released && stack == p.under -> Unit
            stack.size > was.size && stack.take(was.size) == was -> {
                peel = null
                enter = Entering(was)
            }
            stack.size < was.size && was.take(stack.size) == stack -> {
                enter = null
                peel = Peeling.tapped(stack, was.last(), was.size)
            }
            else -> {
                peel = null
                enter = null
            }
        }
    }

    fun start(p: Peeling<T>) {
        peel = p
        enter = null
        version++
    }

    fun end(p: Peeling<T>) {
        if (peel !== p) return
        peel = null
        version++
    }

    fun endEnter(e: Entering<T>) {
        if (enter !== e) return
        enter = null
        version++
    }
}

private fun androidx.compose.ui.graphics.GraphicsLayerScope.place(at: Peel.Place) {
    scaleX = at.scale
    scaleY = at.scale
    translationX = at.x
    translationY = at.y
    alpha = at.alpha
}
