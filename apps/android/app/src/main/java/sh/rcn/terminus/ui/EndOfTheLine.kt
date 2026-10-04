package sh.rcn.terminus.ui

import android.os.SystemClock
import android.widget.Toast
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.rcn.terminus.R
import kotlin.math.roundToInt
import kotlin.math.sin

/** Taps that count as one go at the egg, as on the web app. */
private const val TAPS = 5
private const val TAP_WINDOW_MS = 1_500L

/**
 * Now's wordmark. Five quick taps and a bus drives across the header to the
 * end of the line: terminus is where the bus stops. Taps aren't a semantics
 * action, so TalkBack still reads it as the title.
 */
@Composable
fun RowScope.HeaderWordmark() {
    val ctx = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val drive = remember { Animatable(0f) }
    val taps = remember { ArrayDeque<Long>() }
    val message = stringResource(R.string.end_of_the_line)
    val bus = 28.dp
    val busPx = with(LocalDensity.current) { bus.toPx() }
    val bob = with(LocalDensity.current) { 2.dp.toPx() }

    BoxWithConstraints(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
        val widthPx = constraints.maxWidth.toFloat()
        Box(
            Modifier.pointerInput(message) {
                detectTapGestures {
                    val now = SystemClock.uptimeMillis()
                    taps.addLast(now)
                    while (taps.isNotEmpty() && now - taps.first() > TAP_WINDOW_MS) taps.removeFirst()
                    if (taps.size >= TAPS && !drive.isRunning) {
                        taps.clear()
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        Toast.makeText(ctx, message, Toast.LENGTH_SHORT).show()
                        scope.launch {
                            drive.snapTo(0f)
                            drive.animateTo(1f, tween(2_400, easing = LinearEasing))
                            drive.snapTo(0f)
                        }
                    }
                }
            },
        ) { Wordmark(MaterialTheme.typography.titleLarge) }
        if (drive.isRunning) {
            // In from the right edge, out past the left, bouncing a little on the road.
            Icon(
                painterResource(R.drawable.ic_bus),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier
                    .size(bus)
                    .offset { IntOffset(((widthPx + busPx) * (1 - drive.value) - busPx).roundToInt(), 0) }
                    .graphicsLayer { translationY = sin(drive.value * 60f) * bob },
            )
        }
    }
}
