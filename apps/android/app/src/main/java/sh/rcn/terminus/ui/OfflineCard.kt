package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.isOld

/**
 * Offline with the plan's answer gone stale (or none yet): the next thing on
 * the day plan kept for it (OfflineDay), as the widget shows it. Otherwise
 * [content], the usual card.
 */
@Composable
internal fun OfflinePlanOr(offline: Boolean, answer: NextAnswer?, fetchedAt: Long?, day: DayPlan?, content: @Composable () -> Unit) {
    // Ticks, so "Leave by" turns into "Leave now" without a refresh to prompt it.
    val now by produceState(System.currentTimeMillis(), offline, day) {
        while (true) {
            value = System.currentTimeMillis()
            delay(15_000)
        }
    }
    val pick = if (offline && (answer == null || isOld(answer, fetchedAt, now))) OfflineDay.next(day, now) else null
    if (pick == null) {
        content()
        return
    }
    val ctx = LocalContext.current
    val lines = OfflineDay.lines(pick) { clock(ctx, it) }
    // Up in Now's sky, as any answer is.
    SkyHead { OfflinePlan(lines) }
    SkyGround()
}

@Composable
private fun OfflinePlan(lines: OfflineDay.Lines) {
    Card(Modifier.fillMaxWidth().heightIn(min = 180.dp)) {
        Column(Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                "${stringResource(R.string.offline)} · ${lines.head}",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(lines.big, style = MaterialTheme.typography.headlineSmall)
            lines.how?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
        }
    }
}
