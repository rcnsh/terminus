package sh.rcn.terminus.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import kotlinx.coroutines.delay

/*
 * Skeletons: the shape of what's coming, while it comes, so nothing moves when it lands. Bars stand where the server's words will be,
 * centred in the line box of the text they stand for; what's known already (headings, a service's badge) draws as itself. One soft
 * highlight sweeps across every bar on the screen together, and stands still with the phone's animations off.
 */

/** The sweep's progress, 0 to 1, shared by every bar under one [Skeleton]; null when it stands still. */
private val LocalSweep = staticCompositionLocalOf<State<Float>?> { null }

/** How far the bars have faded in; what's real inside a skeleton draws at once. */
private val LocalFade = staticCompositionLocalOf<State<Float>?> { null }

private const val SWEEP_MS = 1_600L

/** Before this, nothing shows: a quick answer never flashes grey. */
private const val SHOW_AFTER_MS = 150L

/** A skeleton: [content]'s bars, said as [said] (the screen's own "Checking…") and nothing else, its shapes hidden from a screen reader. */
@Composable
internal fun Skeleton(
    said: String,
    modifier: Modifier = Modifier,
    verticalArrangement: Arrangement.Vertical = Arrangement.Top,
    content: @Composable ColumnScope.() -> Unit,
) {
    val still = animationsOff()
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(SHOW_AFTER_MS)
        shown = true
    }
    val fade = animateFloatAsState(if (shown) 1f else 0f, if (still) tween(0) else tween(200), label = "skeleton")
    val sweep = if (still) null else sweep()
    CompositionLocalProvider(LocalSweep provides sweep, LocalFade provides fade) {
        Column(
            modifier.clearAndSetSemantics { contentDescription = said },
            verticalArrangement = verticalArrangement,
            content = content,
        )
    }
}

/**
 * The sweep's phase from the frame clock itself (one monotonic clock for the whole app), so skeletons that appear at different moments
 * still sweep in step.
 */
@Composable
private fun sweep(): State<Float> = produceState(0f) { while (true) withFrameMillis { value = (it % SWEEP_MS) / SWEEP_MS.toFloat() } }

/**
 * One placeholder shape. On the ground, a shade off the surface (darker in light, lighter in dark); in the sky ([sky]), the sky's ink
 * thinly, so the hour's colours show through.
 */
@Composable
internal fun Bar(modifier: Modifier = Modifier, shape: Shape = RoundedCornerShape(6.dp), sky: Boolean = false) {
    val c = MaterialTheme.colorScheme
    val ink = LocalContentColor.current
    val dark = c.surface.luminance() < 0.5f
    val base: Color
    val hi: Color
    if (sky) {
        base = ink.copy(alpha = 0.12f)
        hi = ink.copy(alpha = 0.16f)
    } else {
        base = lerp(c.surface, c.onSurface, if (dark) 0.07f else 0.09f)
        hi = if (dark) lerp(c.surface, c.onSurface, 0.16f) else lerp(base, Color.White, 0.7f)
    }
    val sweep = LocalSweep.current
    val fade = LocalFade.current
    val screen = LocalWindowInfo.current.containerSize.width.toFloat()
    var x by remember { mutableFloatStateOf(0f) }
    Box(
        modifier
            .onGloballyPositioned { x = it.positionInRoot().x }
            .graphicsLayer { alpha = fade?.value ?: 1f }
            .clip(shape)
            .drawBehind {
                drawRect(base)
                val p = sweep?.value ?: return@drawBehind
                // The band is the screen's width, its middle the highlight, crossing from off the left to off the right.
                val band = maxOf(screen, size.width)
                val start = -band + FastOutSlowInEasing.transform(p) * (screen + band) - x
                drawRect(
                    Brush.horizontalGradient(
                        0.3f to Color.Transparent,
                        0.5f to hi,
                        0.7f to Color.Transparent,
                        startX = start,
                        endX = start + band,
                    )
                )
            }
    )
}

/**
 * A bar standing for a line of [style]'s text: the line's height, with a bar about as tall as its letters in the middle. [width] fixed, or
 * a [fraction] of the room.
 */
@Composable
internal fun TextBar(
    style: TextStyle = LocalTextStyle.current,
    modifier: Modifier = Modifier,
    width: Dp? = null,
    fraction: Float = 1f,
    sky: Boolean = false,
) {
    val density = LocalDensity.current
    val (line, bar) =
        with(density) {
            val size = if (style.fontSize.isSpecified) style.fontSize else LocalTextStyle.current.fontSize
            val line = if (style.lineHeight.isSpecified) style.lineHeight.toDp() else (size * 1.3f).toDp()
            line to (size * 0.72f).toDp()
        }
    Box(modifier.height(line), contentAlignment = Alignment.CenterStart) {
        Bar((if (width != null) Modifier.width(width) else Modifier.fillMaxWidth(fraction)).height(bar), sky = sky)
    }
}

/** Bar widths for rows of a list, so it reads as names of different lengths rather than a barcode: the same every time. */
internal fun barFraction(row: Int, set: Int = 0): Float = WIDTHS[set % WIDTHS.size].let { it[row % it.size] }

private val WIDTHS =
    arrayOf(
        floatArrayOf(0.70f, 0.58f, 0.64f, 0.52f, 0.66f, 0.60f, 0.72f),
        floatArrayOf(0.50f, 0.62f, 0.44f, 0.56f, 0.48f, 0.40f, 0.54f),
    )
