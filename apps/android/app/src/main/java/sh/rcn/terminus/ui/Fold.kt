package sh.rcn.terminus.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal const val FOLD_MS = 220

@Composable
internal fun rememberDrawn(): Boolean {
    var drawn by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { drawn = true }
    return drawn
}

@Composable
internal fun FoldRow(shown: Boolean, arriving: Boolean, content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(!arriving) }
    state.targetState = shown
    val wash = remember { Animatable(if (arriving) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (wash.value == 0f) return@LaunchedEffect
        delay(600)
        wash.animateTo(0f, tween(900))
    }
    val accent = MaterialTheme.colorScheme.primary
    AnimatedVisibility(
        state,
        enter =
            expandVertically(tween(260, easing = FastOutSlowInEasing), expandFrom = Alignment.Top) + fadeIn(tween(200, delayMillis = 100)),
        exit = fadeOut(tween(150)) + shrinkVertically(tween(FOLD_MS, easing = FastOutSlowInEasing), shrinkTowards = Alignment.Top),
    ) {
        Box(Modifier.drawBehind { if (wash.value > 0f) drawRect(accent.copy(alpha = 0.14f * wash.value)) }) { content() }
    }
}

internal fun CoroutineScope.afterFold(then: () -> Unit) =
    launch(start = CoroutineStart.UNDISPATCHED) {
        withContext(NonCancellable) {
            delay(FOLD_MS.toLong())
            then()
        }
    }
