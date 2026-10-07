package sh.rcn.terminus.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock

/**
 * Today at a glance, from /me/day: each class with its leave-by, and the
 * trips home. What's done is dimmed. Anything still to come can be swiped
 * away to take it off today, whether it's timetabled or one you added; it
 * goes at once, and a bar at the foot of the screen offers Undo for a few
 * seconds (MainActivity). Until a row has been swiped, the heading says so,
 * and the first time the first row nudges aside a little to show what's under it.
 */
@Composable
internal fun DayTimeline(
    day: DayPlan,
    hint: Boolean,
    peek: Boolean,
    onRemove: (DayItem) -> Unit,
    onPeeked: () -> Unit,
) {
    if (day.items.isEmpty()) return
    val ctx = LocalContext.current
    val fmt = { ms: Long -> clock(ctx, ms) }
    val firstRemovable = day.items.firstOrNull { it.removable }?.key
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.today_heading), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (hint && firstRemovable != null) {
                Text(stringResource(R.string.swipe_to_remove), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        for (item in day.items) {
            // Keyed, so a swiped row's state doesn't pass to the one moving up.
            key(item.key) {
                if (item.removable) Swipeable(item, peek && item.key == firstRemovable, onRemove, onPeeked) { DayRow(item, fmt) } else DayRow(item, fmt)
            }
        }
    }
}

/** What a removed entry is called in the Undo bar: the trip home, or the class without its venue. */
internal fun DayItem.shortName(): String = if (kind == "home") L.s(R.string.trip_home) else label.substringBefore(" @ ")

/** Swipe either way to take it off today. With `peek`, it slides aside once by itself and back, showing what's under it. */
@Composable
private fun Swipeable(item: DayItem, peek: Boolean, onRemove: (DayItem) -> Unit, onPeeked: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState()
    val remove = stringResource(R.string.remove_from_today)
    val nudge = remember { Animatable(0f) }
    // Just the edge of what's under it: enough to say "this moves", not a swipe of its own.
    val nudgePx = with(LocalDensity.current) { 44.dp.toPx() }
    LaunchedEffect(state.currentValue) {
        if (state.currentValue != SwipeToDismissBoxValue.Settled) onRemove(item)
    }
    // Wholly on screen: Today is often below the fold, and a nudge nobody sees teaches nothing.
    var shown by remember { mutableStateOf(false) }
    LaunchedEffect(peek) {
        if (!peek) return@LaunchedEffect
        snapshotFlow { shown }.first { it }
        // Once it has been on screen a moment, so it's seen.
        delay(600)
        // Eased both ways, with no bounce back: a gentle hint, not a jolt.
        val ease = tween<Float>(320, easing = FastOutSlowInEasing)
        nudge.animateTo(-nudgePx, ease)
        delay(450)
        nudge.animateTo(0f, ease)
        onPeeked()
    }
    Box(
        if (!peek) Modifier else Modifier.onGloballyPositioned { c ->
            shown = c.size.height > 0 && c.boundsInWindow().height >= c.size.height - 1
        },
    ) {
        // Under the row while it nudges aside: the same red a swipe shows, without the word, which the nudge would cut in half.
        if (nudge.value != 0f) Box(Modifier.matchParentSize().background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(10.dp)))
        SwipeToDismissBox(
            state = state,
            backgroundContent = {
                // Only while swiping: otherwise it's hidden under the row, and screen readers would read it.
                if (state.dismissDirection == SwipeToDismissBoxValue.Settled) return@SwipeToDismissBox
                RemoveBehind(remove, toEnd = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd, Modifier.fillMaxSize())
            },
            modifier = Modifier.semantics {
                customActions = listOf(CustomAccessibilityAction(remove) { onRemove(item); true })
            },
        ) {
            Box(Modifier.graphicsLayer { translationX = nudge.value }.background(MaterialTheme.colorScheme.background)) { content() }
        }
    }
}

@Composable
private fun RemoveBehind(text: String, toEnd: Boolean, modifier: Modifier) {
    Box(
        modifier.background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp),
        contentAlignment = if (toEnd) Alignment.CenterStart else Alignment.CenterEnd,
    ) {
        Text(text, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.labelLarge)
    }
}

/** One entry of the day: its time, what it is, and how you get there (or that it's off). */
@Composable
private fun DayRow(item: DayItem, fmt: (Long) -> String) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val past = item.status == "done" || item.status == "skipped"
    val current = item.status == "next" || item.status == "now"
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
        Text(
            fmt(item.startsAtMs),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
            color = if (past) muted else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.widthIn(min = 72.dp).padding(end = 8.dp),
        )
        Column(Modifier.weight(1f)) {
            // The server's words (`title`, `line`); worked out here only for an older server.
            val title = item.title ?: if (item.kind == "home") stringResource(R.string.home_from, item.fromName ?: stringResource(R.string.your_last_class)) else item.label
            Text(
                title,
                fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                color = if (past) muted else MaterialTheme.colorScheme.onSurface,
                textDecoration = if (item.status == "skipped") TextDecoration.LineThrough else null,
            )
            val sub = when {
                item.status == "done" -> null
                item.line != null -> item.line
                item.status == "skipped" -> stringResource(R.string.not_going_today)
                else -> item.onBus?.let { b ->
                    listOfNotNull(L.s(R.string.on_the, b.svc), b.off?.let { L.s(R.string.off_at, it) }, b.arriveMs?.let { L.s(R.string.arrive_at, fmt(it)) }).joinToString(" · ")
                } ?: item.leaveAtMs?.let { at ->
                    val time = if (item.leaveEstimated) L.s(R.string.approx, fmt(at)) else fmt(at)
                    val by = L.s(R.string.leave_by, time)
                    listOfNotNull(by, item.svc?.let { L.s(R.string.svc_from, it, item.leaveStop ?: item.fromName.orEmpty()) } ?: L.s(R.string.walk), item.timingText.takeIf { item.timingStatus == "late" }).joinToString(" · ")
                }
            }
            sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
    }
}
