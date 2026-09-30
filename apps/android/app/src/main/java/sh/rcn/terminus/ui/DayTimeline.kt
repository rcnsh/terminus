package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.Column
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
 * trips home. What's done is dimmed, a skipped class struck through.
 */
@Composable
internal fun DayTimeline(day: DayPlan) {
    if (day.items.isEmpty()) return
    val ctx = LocalContext.current
    val fmt = { ms: Long -> clock(ctx, ms) }
    Column(Modifier.fillMaxWidth().padding(top = 16.dp)) {
        Text("TODAY", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 6.dp))
        for (item in day.items) Row(item, fmt)
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
                else -> item.leaveAtMs?.let { at ->
                    val by = "Leave by ${if (item.leaveEstimated) "~" else ""}${fmt(at)}"
                    listOfNotNull(by, item.svc?.let { "$it from ${item.fromName}" } ?: "walk", item.timingText.takeIf { item.timingStatus == "late" }).joinToString(" · ")
                }
            }
            sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
    }
}
