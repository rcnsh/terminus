package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock

@Composable
internal fun AnswerCard(answer: NextAnswer?, loading: Boolean) {
    // The card fills the space kept for it, so a short answer ("You're home",
    // the rest screen) doesn't leave a gap under it; short ones sit centred.
    val short = answer == null || answer.arrived || answer.mode == "rest"
    Card(Modifier.fillMaxWidth().heightIn(min = 180.dp)) {
        Column(
            Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(16.dp),
            verticalArrangement = if (short) Arrangement.spacedBy(4.dp, Alignment.CenterVertically) else Arrangement.spacedBy(4.dp),
        ) {
            if (answer == null) {
                Text(if (loading) "Checking…" else "No answer yet", style = MaterialTheme.typography.titleLarge)
                return@Column
            }
            if (answer.mode == "rest") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_moon), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(answer.label, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                }
                Text(answer.detail)
                Text("No buses until your day starts. Tap a place or Nearby to check one anyway.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            val heading = when {
                answer.mode == "nearby" -> "Nearby"
                answer.why == "gap-home" -> "${answer.destLabel} · long gap"
                else -> answer.destLabel
            }
            if (!answer.isClassPlan) heading?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (answer.arrived) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(answer.label, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                }
                Text(answer.detail)
                return@Column
            }
            if (answer.isClassPlan) {
                ClassPlan(answer)
                return@Column
            }
            val ctx = LocalContext.current
            Text(answer.clockLabel { clock(ctx, it) }, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Countdown(answer)
            Text(answer.detail)
            LeaveLine(answer)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                answer.timingText?.let { Pill(it, timingColor(answer.timingStatus)) }
                answer.crowdText?.let { Pill(it, MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            // The alternative is already at the end of `detail`.
            answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * A class: when to leave is the headline, the bus that goes with it and when
 * it gets you there underneath, and the next bus as the "or go now" option.
 * Every arrival sits next to the bus it belongs to.
 */
@Composable
internal fun ClassPlan(answer: NextAnswer) {
    val ctx = LocalContext.current
    val at = answer.leaveAtMs ?: return
    val fmt = { ms: Long -> clock(ctx, ms) }
    // Minute resolution is enough for "in 24 min"; seconds near the end.
    val now by produceState(System.currentTimeMillis(), at) {
        while (true) {
            value = System.currentTimeMillis()
            delay(if (at - value < 120_000) 1_000 else 15_000)
        }
    }
    val late = answer.leaveLate
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(
        listOfNotNull(answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · "),
        color = muted,
    )
    Text(
        answer.leaveHeadline(now).orEmpty(),
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
    val left = (at - now) / 1000
    if (left > 0) {
        Text(
            if (left >= 120) "in ${(left + 30) / 60} min" else "in ${left / 60} min ${left % 60} s",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
    // The bus to catch, and underneath when it gets you there. The stop is
    // named here, so no separate "board at" or general detail line below.
    val tone = if (late) MaterialTheme.colorScheme.error else goodColor()
    answer.catchHow?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = tone) }
    answer.catchArrive?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = tone) }
    answer.leaveNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary) }
    answer.card?.estimate?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
    answer.goNowLine?.let {
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium)
        Countdown(answer)
    }
    answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 6.dp)) }
}

@Composable
internal fun goodColor() = if (isSystemInDarkTheme()) GoodDark else GoodLight

/** "Leave by 09:38 · D2 from PGP", turning into "Leave now" when the time comes. */
@Composable
internal fun LeaveLine(answer: NextAnswer) {
    val at = answer.leaveAtMs ?: return
    val ctx = LocalContext.current
    val now by produceState(System.currentTimeMillis(), at) {
        while (value < at) {
            delay((at - value).coerceIn(1_000, 30_000))
            value = System.currentTimeMillis()
        }
    }
    answer.leaveText(now)?.let {
        Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
    }
}

/** Ticks every second from `departsAt`, so the app never shows an old "4 min". */
@Composable
internal fun Countdown(answer: NextAnswer) {
    val at = answer.departsAtMs ?: return
    val now by produceState(System.currentTimeMillis(), at) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val left = (at - now) / 1000
    val text = when {
        left > 60 -> "Leaves in ${left / 60} min ${left % 60} s"
        left > 0 -> "Leaves in $left s"
        else -> "Left ${(-left + 59) / 60} min ago · refreshing"
    }
    Text(text, style = MaterialTheme.typography.titleSmall, color = if (left > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Three states, three colours: "tight" is the one that must not look calm. */
@Composable
internal fun timingColor(status: String?) = when (status) {
    "late" -> MaterialTheme.colorScheme.error
    "tight" -> MaterialTheme.colorScheme.tertiary
    else -> goodColor()
}

@Composable
internal fun Pill(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = Modifier
            .background(color.copy(alpha = 0.12f), androidx.compose.foundation.shape.RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}
