package sh.rcn.terminus.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock

/**
 * Today at a glance, from /me/day: each class with its leave-by, and the
 * trips home. What's done is dimmed. Anything still to come has an × to take
 * it off today, whether it's timetabled or one you added (a swipe does the
 * same); it goes at once, and its row says so with Undo for [UNDO_MS], as
 * on the web app.
 */
@Composable
internal fun DayTimeline(
    day: DayPlan,
    removed: TodayNote?,
    onRemove: (DayItem) -> Unit,
    onUndo: () -> Unit,
    onDismiss: (String) -> Unit,
) {
    if (day.items.isEmpty() && removed == null) return
    val ctx = LocalContext.current
    val fmt = { ms: Long -> clock(ctx, ms) }
    // Above the entry that followed it, else where it was.
    val noteAt = removed?.let { n -> day.items.indexOfFirst { it.key == n.before }.takeIf { n.before != null && it >= 0 } ?: minOf(n.at, day.items.size) }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text(stringResource(R.string.today_heading).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
        for ((i, item) in day.items.withIndex()) {
            if (i == noteAt && removed != null) RemovedRow(removed, fmt, onUndo, onDismiss)
            // Keyed, so a swiped row's state doesn't pass to the one moving up.
            key(item.key) {
                if (item.removable) Swipeable(item, onRemove) { DayRow(item, fmt) { RemoveButton(item, onRemove) } } else DayRow(item, fmt)
            }
        }
        if (noteAt == day.items.size && removed != null) RemovedRow(removed, fmt, onUndo, onDismiss)
    }
}

/** How long a removed entry's Undo stays: as long as the web app's. */
private const val UNDO_MS = 20_000L

/** What a removed entry is called in its row: the trip home, or the class without its venue. */
internal fun DayItem.shortName(): String = if (kind == "home") L.s(R.string.trip_home) else label.substringBefore(" @ ")

/** The × at the end of a row that can be taken off today. */
@Composable
private fun RemoveButton(item: DayItem, onRemove: (DayItem) -> Unit) {
    IconButton(onClick = { onRemove(item) }) {
        Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.remove_from_today, item.shortName()), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

/**
 * Where an entry was, just taken off: "GEA1000 removed from today · Undo",
 * or why it couldn't be (the entry is back, just below). Said aloud as it
 * appears, and gone after [UNDO_MS].
 */
@Composable
private fun RemovedRow(note: TodayNote, fmt: (Long) -> String, onUndo: () -> Unit, onDismiss: (String) -> Unit) {
    LaunchedEffect(note) {
        delay(UNDO_MS)
        onDismiss(note.item.key)
    }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // Laid out as the entry was, so the time stays in its column when the words wrap.
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }, verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
            Text(fmt(note.item.startsAtMs), style = MaterialTheme.typography.bodyMedium, color = muted, modifier = Modifier.widthIn(min = 72.dp).padding(end = 8.dp))
            Text(
                if (note.failed) stringResource(R.string.cant_remove) else stringResource(R.string.taken_off_today, note.item.shortName()),
                color = if (note.failed) MaterialTheme.colorScheme.error else muted,
            )
        }
        // Its word ends where the ×s do, past the button's own padding.
        if (!note.failed) TextButton(onClick = onUndo, modifier = Modifier.offset(x = 6.dp)) { Text(stringResource(R.string.undo), fontWeight = FontWeight.SemiBold) }
    }
}

/**
 * Swipe either way to take it off today, a shortcut for the ×. The row
 * lifts onto a card as it moves; behind it a bin, grey until it's far
 * enough to let go, then red.
 */
@Composable
private fun Swipeable(item: DayItem, onRemove: (DayItem) -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        if (state.currentValue != SwipeToDismissBoxValue.Settled) onRemove(item)
    }
    val moving = state.dismissDirection != SwipeToDismissBoxValue.Settled
    val armed = state.targetValue != SwipeToDismissBoxValue.Settled
    val c = MaterialTheme.colorScheme
    val behind by animateColorAsState(if (armed) c.errorContainer else c.surfaceContainerHighest, label = "behind")
    val bin by animateFloatAsState(if (armed) 1.15f else 1f, label = "bin")
    val shape = RoundedCornerShape(12.dp)
    SwipeToDismissBox(
        state = state,
        // A little wider than the page's column, so the card has room round the words, which stay in line with the other rows.
        modifier = Modifier.layout { m, k ->
            val out = 8.dp.roundToPx()
            val p = m.measure(k.copy(minWidth = k.minWidth + 2 * out, maxWidth = k.maxWidth + 2 * out))
            layout(p.width - 2 * out, p.height) { p.place(-out, 0) }
        },
        backgroundContent = {
            // Only while swiping: otherwise it's hidden under the row, and screen readers would read it.
            if (!moving) return@SwipeToDismissBox
            Box(
                Modifier.fillMaxSize().background(behind, shape).padding(horizontal = 20.dp),
                contentAlignment = if (state.dismissDirection == SwipeToDismissBoxValue.StartToEnd) Alignment.CenterStart else Alignment.CenterEnd,
            ) {
                Icon(painterResource(R.drawable.ic_delete), contentDescription = null, tint = if (armed) c.onErrorContainer else c.onSurfaceVariant, modifier = Modifier.size(22.dp).scale(bin))
            }
        },
    ) {
        Box(
            (if (moving) Modifier.shadow(2.dp, shape).background(c.surfaceContainerHigh, shape) else Modifier.background(c.background))
                .padding(start = 8.dp),
        ) { content() }
    }
}

/** One entry of the day: its time, what it is, and how you get there (or that it's off). */
@Composable
private fun DayRow(item: DayItem, fmt: (Long) -> String, end: (@Composable () -> Unit)? = null) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val past = item.status == "done" || item.status == "skipped"
    val current = item.status == "next" || item.status == "now"
    // Every row as tall as the × at least, so the list keeps one rhythm; the × centred on the row, as Material lists have it.
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).padding(vertical = 5.dp), verticalAlignment = Alignment.Top) {
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
        end?.invoke()
    }
}
