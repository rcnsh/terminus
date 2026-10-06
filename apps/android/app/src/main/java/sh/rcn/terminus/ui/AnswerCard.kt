package sh.rcn.terminus.ui

import sh.rcn.terminus.Suggestion
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.TextButton
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
import sh.rcn.terminus.CardAction
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock
import androidx.compose.ui.res.stringResource

@Composable
internal fun AnswerCard(
    answer: NextAnswer?,
    loading: Boolean,
    onAction: (CardAction) -> Unit = {},
    busy: Boolean = false,
    onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> },
    onPlace: (String) -> Unit = {},
) {
    // On the page, not in a box: the answer is the screen. A minimum height
    // keeps what's under it from jumping as answers come and go.
    Column(
        Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (answer == null) {
            Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.no_answer_yet), style = MaterialTheme.typography.titleLarge)
            return@Column
        }
        if (answer.mode == "rest" || answer.isFree || answer.arrived) {
            // Nothing to catch: said plainly, with no bus to mistake for advice.
            DayDone(answer, night = answer.mode == "rest", onPlace)
            if (answer.mode != "rest") Actions(answer, onAction, busy, onSuggestion)
            return@Column
        }
        // NUS's live times are down: said once, above the answer.
        answer.card?.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary) }
        // Where the trip is, when one is under way: the same on every device.
        answer.phaseText?.let { Pill(it, MaterialTheme.colorScheme.primary) }
        // On the bus: how far along the ride, and the next stop, as the live notification shows.
        answer.card?.ride?.let { RideProgress(it) }
        answer.card?.warning?.let { Text(it, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.tertiary) }
        // A trip by bus or on foot, drawn in the style chosen in Settings › Appearance.
        answer.card?.journey?.takeIf { !answer.arrived }?.let { journey ->
            JourneyCard(answer, journey, CardStyle.pref(LocalContext.current))
            Actions(answer, onAction, busy, onSuggestion)
            return@Column
        }
        val heading = when {
            answer.mode == "nearby" -> stringResource(R.string.chip_nearby)
            answer.why == "gap-home" -> stringResource(R.string.long_gap, answer.destLabel.orEmpty())
            else -> answer.destLabel
        }
        if (!answer.isClassPlan) heading?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (answer.isClassPlan) {
            ClassPlan(answer)
            Actions(answer, onAction, busy, onSuggestion)
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
        Actions(answer, onAction, busy, onSuggestion)
    }
}

@OptIn(ExperimentalLayoutApi::class)
/**
 * The server's buttons (plans only: "Not going", "Not on campus today",
 * undo), in its order: the first one filled, the rest outlined. Then
 * anything terminus has to suggest.
 */
@Composable
internal fun Actions(answer: NextAnswer, onAction: (CardAction) -> Unit, busy: Boolean, onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> }) {
    // "Catch the D2 at Museum", and you don't know where Museum is: walking
    // directions there, as the one filled button; the server's go beside it.
    val walkTo = answer.card?.walkTo
    val actions = answer.card?.actions.orEmpty()
    walkTo?.let { w ->
        val ctx = LocalContext.current
        Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, w.mapsUri())) } },
                modifier = Modifier.weight(1f).height(48.dp),
            ) { Text(stringResource(R.string.directions_to, w.name), maxLines = 1) }
            actions.firstOrNull()?.let { a -> OutlinedButton(onClick = { onAction(a) }, enabled = !busy, modifier = Modifier.height(48.dp)) { Text(a.label, maxLines = 1) } }
        }
    }
    val rest = if (walkTo != null) actions.drop(1) else actions
    if (rest.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = if (walkTo != null) 6.dp else 10.dp)) {
            rest.forEachIndexed { i, a ->
                if (i == 0 && walkTo == null && a.id != "skipped" && a.id != "reset") {
                    Button(onClick = { onAction(a) }, enabled = !busy) { Text(a.label) }
                } else {
                    OutlinedButton(onClick = { onAction(a) }, enabled = !busy) { Text(a.label) }
                }
            }
        }
    }
    answer.card?.suggestion?.let { s ->
        androidx.compose.material3.OutlinedCard(Modifier.padding(top = 14.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(s.text, style = MaterialTheme.typography.bodyMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    Button(onClick = { onSuggestion(s, true) }, enabled = !busy) { Text(s.accept) }
                    OutlinedButton(onClick = { onSuggestion(s, false) }, enabled = !busy) { Text(s.dismiss) }
                }
            }
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
    val starts = answer.classAtMs?.let { stringResource(R.string.starts_at, fmt(it)) }
    Text(
        listOfNotNull(answer.destLabel, starts).joinToString(" · "),
        color = muted,
    )
    Text(
        answer.leaveHeadline(now).orEmpty(),
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
    // Counting down to leaving; at the stop the headline is the bus and its time.
    val left = if (answer.card?.phase == "waiting") 0 else (at - now) / 1000
    if (left > 0) {
        Text(
            if (left >= 120) stringResource(R.string.in_min, ((left + 30) / 60).toInt()) else stringResource(R.string.in_min_s, (left / 60).toInt(), (left % 60).toInt()),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
    // The bus to catch, and underneath when it gets you there. The stop is
    // named here, so no separate "board at" or general detail line below.
    // One colour for "go" (the countdown above); red only when it's late.
    val error = MaterialTheme.colorScheme.error
    answer.catchHow?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = if (late) error else MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 4.dp)) }
    answer.catchArrive?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (late) error else muted) }
    // A busy bus and an estimate are small print, not more headlines.
    listOfNotNull(answer.leaveNote, answer.card?.estimate).takeIf { it.isNotEmpty() }?.let {
        Text(it.joinToString(" "), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 4.dp))
    }
    answer.goNowLine?.let {
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium, color = muted)
    }
    answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 6.dp)) }
}

/**
 * The day's done, or there's nothing to catch: the label large on a panel
 * (a night sky after your day, plain otherwise), what's next under it, then
 * your favourites to plan a trip to instead.
 */
@Composable
private fun DayDone(answer: NextAnswer, night: Boolean, onPlace: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val ink = if (night) NIGHT_INK else c.onSurface
    val sub = if (night) NIGHT_SUB else c.onSurfaceVariant
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(28.dp))
            .background(if (night) Brush.verticalGradient(NIGHT) else Brush.verticalGradient(listOf(c.surfaceVariant, c.surfaceVariant))),
    ) {
        if (night) NightSky(Modifier.matchParentSize())
        Column(Modifier.padding(start = 22.dp, end = 22.dp, top = if (night) 104.dp else 28.dp, bottom = 24.dp)) {
            Text(answer.label, color = ink, fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp)
            if (answer.detail.isNotEmpty()) Text(answer.detail, color = sub, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
        }
    }
    if (answer.places.isNotEmpty()) {
        Label(stringResource(R.string.going_anyway), Modifier.padding(top = 22.dp, bottom = 10.dp))
        for (row in answer.places.chunked(3)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (p in row) {
                    LinkTile({ onPlace(p.key) }, Modifier.weight(1f).fillMaxHeight()) {
                        Text(p.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.height(18.dp))
                        Text(stringResource(R.string.plan_trip), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                    }
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    } else {
        Text(
            stringResource(if (night) R.string.rest_hint_none else R.string.free_hint_none),
            style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp),
        )
    }
}

/** A few stars and a crescent moon, for the night panel. Fixed, so it never twinkles into a distraction. */
@Composable
private fun NightSky(modifier: Modifier) {
    Canvas(modifier) {
        val w = size.width
        for ((x, y, a) in STARS) drawCircle(Color.White.copy(alpha = a), 1.3.dp.toPx(), Offset(w * x, 14.dp.toPx() + y * 80.dp.toPx()))
        val moon = Offset(w - 60.dp.toPx(), 52.dp.toPx())
        drawCircle(MOON, 24.dp.toPx(), moon)
        drawCircle(NIGHT.first(), 22.dp.toPx(), moon + Offset(11.dp.toPx(), -7.dp.toPx()))
    }
}

private val NIGHT = listOf(Color(0xFF121A33), Color(0xFF181A30), Color(0xFF1C1B26))
private val NIGHT_INK = Color(0xFFF2EFEB)
private val NIGHT_SUB = Color(0xFFC9C3BD)
private val MOON = Color(0xFFFDE9C9)
private val STARS = listOf(
    Triple(0.08f, 0.3f, 0.7f), Triple(0.22f, 0.9f, 0.5f), Triple(0.35f, 0.15f, 0.8f), Triple(0.48f, 0.7f, 0.4f),
    Triple(0.6f, 0.2f, 0.6f), Triple(0.15f, 1.1f, 0.35f), Triple(0.7f, 1.05f, 0.5f), Triple(0.92f, 1.2f, 0.4f),
)

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
        left > 60 -> stringResource(R.string.leaves_in_min_s, (left / 60).toInt(), (left % 60).toInt())
        left > 0 -> stringResource(R.string.leaves_in_s, left.toInt())
        else -> stringResource(R.string.left_ago, ((-left + 59) / 60).toInt())
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

/** On the bus: a bar from boarding to getting off, and "Next: Opp NUSS · 3 stops to go". */
@Composable
private fun RideProgress(ride: sh.rcn.terminus.Ride) {
    val now by produceState(System.currentTimeMillis(), ride) {
        while (value < ride.arriveMs) {
            delay(5_000)
            value = System.currentTimeMillis()
        }
    }
    androidx.compose.material3.LinearProgressIndicator(
        progress = { ride.progress(now) },
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    )
    Text(ride.nextText(now), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp, bottom = 4.dp))
}
