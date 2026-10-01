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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.widget.clock

/**
 * Today at a glance, from /me/day: each class with its leave-by, and the
 * trips home. What's done is dimmed. Anything still to come can be swiped
 * away to take it off today, whether it's timetabled or one you added; it
 * goes at once, with Undo for a few seconds.
 */
@Composable
internal fun DayTimeline(day: DayPlan, removed: DayItem?, onRemove: (DayItem) -> Unit, onUndo: () -> Unit, onDismissUndo: () -> Unit) {
    if (day.items.isEmpty() && removed == null) return
    val ctx = LocalContext.current
    val fmt = { ms: Long -> clock(ctx, ms) }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text("TODAY", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
        if (removed != null) UndoBar(removed, onUndo, onDismissUndo)
        for (item in day.items) {
            // Keyed, so a swiped row's state doesn't pass to the one moving up.
            androidx.compose.runtime.key(item.key) {
                if (item.removable) Swipeable(item, onRemove) { Row(item, fmt) } else Row(item, fmt)
            }
        }
    }
}

/** Swipe either way to take it off today. */
@Composable
private fun Swipeable(item: DayItem, onRemove: (DayItem) -> Unit, content: @Composable () -> Unit) {
    val state = androidx.compose.material3.rememberSwipeToDismissBoxState()
    androidx.compose.runtime.LaunchedEffect(state.currentValue) {
        if (state.currentValue != androidx.compose.material3.SwipeToDismissBoxValue.Settled) onRemove(item)
    }
    androidx.compose.material3.SwipeToDismissBox(
        state = state,
        backgroundContent = {
            val toEnd = state.dismissDirection == androidx.compose.material3.SwipeToDismissBoxValue.StartToEnd
            // Only while swiping: otherwise it's hidden under the row, and screen readers would read it.
            if (state.dismissDirection == androidx.compose.material3.SwipeToDismissBoxValue.Settled) return@SwipeToDismissBox
            Box(
                Modifier.fillMaxSize().background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(10.dp)).padding(horizontal = 16.dp),
                contentAlignment = if (toEnd) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                Text("Remove from today", color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.labelLarge)
            }
        },
        modifier = Modifier.semantics {
            customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction("Remove from today") { onRemove(item); true })
        },
    ) {
        Box(Modifier.background(MaterialTheme.colorScheme.background)) { content() }
    }
}

/** "GEA1000 taken off today · Undo", for a few seconds after a swipe. */
@Composable
private fun UndoBar(item: DayItem, onUndo: () -> Unit, onDismiss: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(item.key) {
        kotlinx.coroutines.delay(6_000)
        onDismiss()
    }
    val name = if (item.kind == "home") "The trip home" else item.label.substringBefore(" @ ")
    Row(
        Modifier.fillMaxWidth().padding(bottom = 6.dp).background(MaterialTheme.colorScheme.inverseSurface, RoundedCornerShape(10.dp)).padding(start = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("$name taken off today", color = MaterialTheme.colorScheme.inverseOnSurface, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        TextButton(onClick = onUndo) { Text("Undo", color = MaterialTheme.colorScheme.inversePrimary) }
    }
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
            modifier = Modifier.width(72.dp),
        )
        Column(Modifier.weight(1f)) {
            val title = if (item.kind == "home") "Home, from ${item.fromName ?: "your last class"}" else item.label
            Text(
                title,
                fontWeight = if (current) FontWeight.SemiBold else FontWeight.Normal,
                color = if (past) muted else MaterialTheme.colorScheme.onSurface,
                textDecoration = if (item.status == "skipped") TextDecoration.LineThrough else null,
            )
            val sub = when (item.status) {
                "skipped" -> "Not going today"
                "done" -> null
                else -> item.onBus?.let { b ->
                    listOfNotNull("On the ${b.svc}", b.off?.let { "off at $it" }, b.arriveMs?.let { "arrive ${fmt(it)}" }).joinToString(" · ")
                } ?: item.leaveAtMs?.let { at ->
                    val by = "Leave by ${if (item.leaveEstimated) "~" else ""}${fmt(at)}"
                    listOfNotNull(by, item.svc?.let { "$it from ${item.leaveStop ?: item.fromName}" } ?: "walk", item.timingText.takeIf { item.timingStatus == "late" }).joinToString(" · ")
                }
            }
            sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
    }
}
