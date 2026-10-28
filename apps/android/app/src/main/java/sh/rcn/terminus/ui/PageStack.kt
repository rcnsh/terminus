package sh.rcn.terminus.ui

import androidx.activity.BackEventCompat
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.rememberTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.dp
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * A home screen and the pages opened over it, [stack] the open pages (the last on top, empty for home). [content] draws the top page, or
 * home for null. A page slides in from the right and off again; back pops one.
 *
 * Back looks like Android's own predictive back: the page underneath is there from the start, still and solid, and a back gesture peels the
 * top page off it, shrinking it into a rounded card that leans toward the thumb. Let go, and the card slides away that way, carrying on to
 * its full shrink; [onBack] is told once the gesture completes. Cancel, and it grows back. With [stack] empty, back is left to whoever
 * handles it outside.
 */
@Composable
internal fun <T> PageStack(
    stack: List<T>,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable (T?) -> Unit,
) {
    val pages = remember { SeekableTransitionState(stack) }
    val scope = rememberCoroutineScope()
    val back by rememberUpdatedState(onBack)
    LaunchedEffect(stack) { pages.animateTo(stack) }
    // The pages a back gesture is taking off, how far it has gone and which
    // way the card leans (1 from the left edge, -1 from the right), for that
    // page (and only that one) to follow. Kept after the gesture completes,
    // so it leaves from where it was let go; dropped once anything else opens.
    var leaving by remember { mutableStateOf<List<T>?>(null) }
    var backProgress by remember { mutableFloatStateOf(0f) }
    var lean by remember { mutableFloatStateOf(1f) }
    var settle by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(stack) { if (stack != leaving?.dropLast(1)) leaving = null }
    PredictiveBackHandler(enabled = stack.isNotEmpty()) { events ->
        val from = stack
        settle?.cancel()
        leaving = from
        backProgress = 0f
        lean = 1f
        var seeking = false
        try {
            events.collect {
                backProgress = it.progress
                lean = if (it.swipeEdge == BackEventCompat.EDGE_RIGHT) -1f else 1f
                // Only the page underneath is shown, held at the start: the card
                // follows the gesture by itself and slides away once let go.
                if (!seeking) {
                    seeking = true
                    pages.seekTo(0f, targetState = from.dropLast(1))
                }
            }
            settle = scope.launch { animate(backProgress, 1f, animationSpec = tween(300)) { v, _ -> backProgress = v } }
            back()
        } catch (e: CancellationException) {
            settle = scope.launch {
                animate(backProgress, 0f, animationSpec = tween(200)) { v, _ -> backProgress = v }
                leaving = null
            }
            scope.launch { pages.animateTo(from) }
            throw e
        }
    }

    rememberTransition(pages, label = "pages").AnimatedContent(
        transitionSpec = {
            if (targetState.size > initialState.size) {
                (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { it } + fadeIn(tween(300))).togetherWith(
                    slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeOut(tween(200))
                )
            } else {
                // Back: the page underneath stays put and solid, and the top
                // page slides off it without fading, the way the card leans.
                val way = if (initialState == leaving) lean else 1f
                (EnterTransition.None togetherWith slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { (it * way).toInt() })
                    .apply { targetContentZIndex = -1f }
            }
        },
        modifier = modifier,
    ) { shown ->
        val page = shown.lastOrNull()
        if (page == null) {
            content(null)
        } else {
            Box(
                Modifier.fillMaxSize()
                    .graphicsLayer {
                        // Following the back gesture: the page shrinks into a card with
                        // rounded corners and a shadow, lifted off the one behind it,
                        // and leans a little toward the thumb.
                        val progress = if (shown == leaving) backProgress else 0f
                        val scale = 1f - progress * 0.1f
                        scaleX = scale
                        scaleY = scale
                        translationX = lean * progress * (size.width / 20f - 8.dp.toPx()).coerceAtLeast(0f)
                        if (progress > 0f) {
                            shape = RoundedCornerShape(progress * 28.dp.toPx())
                            clip = true
                            shadowElevation = 8.dp.toPx()
                        }
                    }
                    .background(MaterialTheme.colorScheme.background)
            ) {
                content(page)
            }
        }
    }
}
