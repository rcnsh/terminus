package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.TextButton
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.first
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.widget.clock
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L
import androidx.compose.foundation.layout.widthIn

/**
 * Today at a glance, from /me/day: each class with its leave-by, and the
 * trips home. What's done is dimmed. Anything still to come can be swiped
 * away to take it off today, whether it's timetabled or one you added; it
 * goes at once, leaving a row in its place with Undo for a few seconds, so
 * nothing below it moves. Until a row has been swiped,
 * the heading says so, and the first few times the first row nudges aside
 * to show what's under it.
 */
@Composable
internal fun DayTimeline(
    day: DayPlan,
    removed: DayItem?,
    removedAt: Int,
    removeError: String?,
    hint: Boolean,
    peek: Boolean,
    onRemove: (DayItem) -> Unit,
    onUndo: () -> Unit,
    onDismissUndo: () -> Unit,
    onPeeked: () -> Unit,
) {
    if (day.items.isEmpty() && removed == null && removeError == null) return
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
        if (removed == null && removeError != null) ErrorBar(removeError, onDismissUndo)
        val at = removedAt.coerceIn(0, day.items.size)
        day.items.forEachIndexed { i, item ->
            if (i == at && removed != null) androidx.compose.runtime.key("removed:${removed.key}") { RemovedRow(removed, fmt, onUndo, onDismissUndo) }
            // Keyed, so a swiped row's state doesn't pass to the one moving up.
            androidx.compose.runtime.key(item.key) {
                if (item.removable) Swipeable(item, peek && item.key == firstRemovable, onRemove, onPeeked) { Row(item, fmt) } else Row(item, fmt)
            }
        }
        if (at == day.items.size && removed != null) androidx.compose.runtime.key("removed:${removed.key}") { RemovedRow(removed, fmt, onUndo, onDismissUndo) }
    }
}

/** Swipe either way to take it off today. With `peek`, it slides aside once by itself and back, showing what's under it. */
@Composable
private fun Swipeable(item: DayItem, peek: Boolean, onRemove: (DayItem) -> Unit, onPeeked: () -> Unit, content: @Composable () -> Unit) {
    val state = androidx.compose.material3.rememberSwipeToDismissBoxState()
    val remove = stringResource(R.string.remove_from_today)
    val nudge = androidx.compose.runtime.remember { androidx.compose.animation.core.Animatable(0f) }
    val nudgePx = with(androidx.compose.ui.platform.LocalDensity.current) { 180.dp.toPx() }
    androidx.compose.runtime.LaunchedEffect(state.currentValue) {
        if (state.currentValue != androidx.compose.material3.SwipeToDismissBoxValue.Settled) onRemove(item)
    }
    // Wholly on screen: Today is often below the fold, and a nudge nobody sees teaches nothing.
    var shown by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    androidx.compose.runtime.LaunchedEffect(peek) {
        if (!peek) return@LaunchedEffect
        androidx.compose.runtime.snapshotFlow { shown }.first { it }
        // Once it has been on screen a moment, so it's seen.
        kotlinx.coroutines.delay(600)
        nudge.animateTo(-nudgePx, androidx.compose.animation.core.tween(380, easing = androidx.compose.animation.core.FastOutSlowInEasing))
        kotlinx.coroutines.delay(700)
        nudge.animateTo(0f, androidx.compose.animation.core.spring(dampingRatio = 0.6f, stiffness = 300f))
        onPeeked()
    }
    Box(
        if (!peek) Modifier else Modifier.onGloballyPositioned { c ->
            shown = c.size.height > 0 && c.boundsInWindow().height >= c.size.height - 1
        },
    ) {
        // Under the row while it nudges aside: the same as a swipe to the left shows.
        if (nudge.value != 0f) RemoveBehind(remove, toEnd = false, Modifier.matchParentSize())
        androidx.compose.material3.SwipeToDismissBox(
            state = state,
            backgroundContent = {
                // Only while swiping: otherwise it's hidden under the row, and screen readers would read it.
                if (state.dismissDirection == androidx.compose.material3.SwipeToDismissBoxValue.Settled) return@SwipeToDismissBox
                RemoveBehind(remove, toEnd = state.dismissDirection == androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd, Modifier.fillMaxSize())
            },
            modifier = Modifier.semantics {
                customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(remove) { onRemove(item); true })
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

/** Where a row was swiped off: "GEA1000 taken off today · Undo", for a few seconds, in the list's own colours. */
@Composable
private fun RemovedRow(item: DayItem, fmt: (Long) -> String, onUndo: () -> Unit, onDismiss: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(item.key) {
        kotlinx.coroutines.delay(6_000)
        onDismiss()
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val name = if (item.kind == "home") stringResource(R.string.trip_home) else item.label.substringBefore(" @ ")
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(fmt(item.startsAtMs), style = MaterialTheme.typography.bodyMedium, color = muted, modifier = Modifier.widthIn(min = 72.dp).padding(end = 8.dp))
        Text(stringResource(R.string.taken_off_today, name), color = muted, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onUndo) { Text(stringResource(R.string.undo), fontWeight = FontWeight.SemiBold) }
    }
}

/** A swipe that didn't take: the row is back, and this says why, for a few seconds. */
@Composable
private fun ErrorBar(text: String, onDismiss: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(text) {
        kotlinx.coroutines.delay(6_000)
        onDismiss()
    }
    Text(
        text,
        color = MaterialTheme.colorScheme.onErrorContainer,
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.fillMaxWidth().padding(bottom = 6.dp).background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(10.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
    )
}

@Composable
private fun Row(item: DayItem, fmt: (Long) -> String) {
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
            val title = if (item.kind == "home") stringResource(R.string.home_from, item.fromName ?: stringResource(R.string.your_last_class)) else item.label
            Text(
                title,
                fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                color = if (past) muted else MaterialTheme.colorScheme.onSurface,
                textDecoration = if (item.status == "skipped") TextDecoration.LineThrough else null,
            )
            val sub = when (item.status) {
                "skipped" -> stringResource(R.string.not_going_today)
                "done" -> null
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
