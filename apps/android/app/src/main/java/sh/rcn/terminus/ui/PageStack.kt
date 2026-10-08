package sh.rcn.terminus.ui

import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.SeekableTransitionState
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
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/**
 * A home screen and the pages opened over it, [stack] the open pages (the
 * last on top, empty for home). [content] draws the top page, or home for
 * null. A page slides in from the right and off again; back pops one.
 *
 * Moving between them is one transition that a back gesture can seek, as
 * Android's own apps do: the page underneath is drawn from the start,
 * sliding and fading in as the top page goes, rather than the page moving
 * over nothing. Let go, and it carries on from there; [onBack] is told
 * once the gesture completes. With [stack] empty, back is left to whoever
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
    // The pages a back gesture is taking off, and how far it has gone, for
    // that page (and only that one) to shrink as it follows. Kept after the
    // gesture completes, so it leaves at the size it was let go; dropped
    // once anything else opens.
    var leaving by remember { mutableStateOf<List<T>?>(null) }
    var backProgress by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(stack) { if (stack != leaving?.dropLast(1)) leaving = null }
    PredictiveBackHandler(enabled = stack.isNotEmpty()) { events ->
        val from = stack
        leaving = from
        backProgress = 0f
        try {
            events.collect {
                backProgress = it.progress
                pages.seekTo(it.progress, targetState = from.dropLast(1))
            }
            back()
        } catch (e: CancellationException) {
            backProgress = 0f
            leaving = null
            scope.launch { pages.animateTo(from) }
            throw e
        }
    }

    rememberTransition(pages, label = "pages").AnimatedContent(
        transitionSpec = {
            if (targetState.size > initialState.size) {
                (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { it } + fadeIn(tween(300)))
                    .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeOut(tween(200)))
            } else {
                // Back: the page stays solid as it slides off, so a back gesture
                // holds a page, not a ghost of one; the one under fades up behind it.
                ((slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeIn(tween(300)))
                    .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { it }))
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
                Modifier.fillMaxSize().graphicsLayer {
                    // Following the back gesture (the transition slides it): the page
                    // shrinks a little into a card with rounded corners and a shadow,
                    // lifted off the one behind it.
                    val progress = if (shown == leaving) backProgress else 0f
                    val scale = 1f - progress * 0.1f
                    scaleX = scale
                    scaleY = scale
                    if (progress > 0f) {
                        shape = RoundedCornerShape((progress * 5f).coerceAtMost(1f) * 28.dp.toPx())
                        clip = true
                        shadowElevation = 8.dp.toPx()
                    }
                }.background(MaterialTheme.colorScheme.background),
            ) {
                content(page)
            }
        }
    }
}
