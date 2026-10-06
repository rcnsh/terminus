package sh.rcn.terminus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock

/**
 * A trip by bus, drawn in the style chosen in Settings › Appearance
 * ([CardStyle]). All three lead with when to leave and end with when you get
 * there; the words and times are the server's (`card.journey`), and only the
 * countdowns tick here.
 */
@Composable
internal fun JourneyCard(answer: NextAnswer, journey: Journey, style: String) {
    // Every second near the end, so "Leave in 45 s" is never a stale 45.
    val now by produceState(System.currentTimeMillis(), answer.leaveAtMs, journey.boardAtMs) {
        while (true) {
            value = System.currentTimeMillis()
            val soonest = listOfNotNull(answer.leaveAtMs, journey.boardAtMs).filter { it > value }.minOrNull()
            delay(if (soonest != null && soonest - value < 150_000) 1_000 else 15_000)
        }
    }
    when (style) {
        CardStyle.TICKET -> Ticket(answer, journey, now)
        CardStyle.STEPS -> Steps(answer, journey, now)
        else -> Route(answer, journey, now)
    }
    // A busy bus and an estimate are small print, not more headlines.
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    listOfNotNull(answer.leaveNote, answer.card?.estimate).takeIf { it.isNotEmpty() }?.let {
        Text(it.joinToString(" "), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 8.dp))
    }
    if (!journey.live) answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 4.dp)) }
}

/** Route: you, the stop and where you're going on a line, the times under each. */
@Composable
private fun Route(answer: NextAnswer, journey: Journey, now: Long) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(JourneyText.to(answer, journey, clockOf()), color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    LeaveHead(answer, journey, now)
    val under = listOfNotNull(JourneyText.by(answer, journey, now), JourneyText.arrive(journey)).joinToString(" · ")
    if (under.isNotEmpty()) Text(under, color = if (answer.leaveLate) MaterialTheme.colorScheme.error else muted)
    RouteLine(journey, Modifier.padding(top = 16.dp, bottom = 4.dp))
    Tags(answer, journey)
}

/** The line itself: a dashed walk, the bus's stretch in its colour, how long each takes under it. */
@Composable
internal fun RouteLine(journey: Journey, modifier: Modifier = Modifier) {
    val fg = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val bus = Color(journey.bus.color)
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        journey.walk?.let { walk ->
            Point(stringResource(R.string.journey_you), journey.leave ?: stringResource(R.string.journey_now), MaterialTheme.colorScheme.primary, narrow = journey.walkEnd != null)
            Stretch(Modifier.weight(1f), {}, walk) {
                drawLine(muted, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 6.dp.toPx())))
            }
        }
        Point(journey.bus.stop, journey.bus.board, fg, narrow = journey.walkEnd != null)
        Stretch(Modifier.weight(1.4f), { BusBadge(journey.bus.svc, journey.bus.color, 12.sp, paid = journey.bus.paid) }, journey.ride) {
            drawLine(bus, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 5.dp.toPx(), StrokeCap.Round)
        }
        Point(journey.toStop, (if (journey.walkEnd != null) journey.arriveStop else journey.arrive) ?: "", fg, narrow = journey.walkEnd != null)
        // On from the stop to the room or building: a fourth point, so the points take only the room their words need.
        journey.walkEnd?.let { walk ->
            Stretch(Modifier.weight(1f), {}, walk) {
                drawLine(muted, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 6.dp.toPx())))
            }
            Point(journey.place, journey.arrive ?: "", fg, narrow = true)
        }
    }
}

/** A point on the line: a dot, its name and its time. */
@Composable
private fun Point(name: String, time: String, dot: Color, narrow: Boolean = false) {
    Column(if (narrow) Modifier.widthIn(min = 44.dp, max = 64.dp) else Modifier.width(76.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(Modifier.height(CAPTION))
        Box(Modifier.size(DOT), contentAlignment = Alignment.Center) { Box(Modifier.size(14.dp).background(dot, CircleShape)) }
        Text(name, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
        Text(time, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, textAlign = TextAlign.Center)
    }
}

/** Between two points: the bus above the line (nothing for a walk), the line level with the dots, how long under it. */
@Composable
private fun Stretch(modifier: Modifier, above: @Composable () -> Unit, takes: String, line: androidx.compose.ui.graphics.drawscope.DrawScope.() -> Unit) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.height(CAPTION), contentAlignment = Alignment.Center) { above() }
        Canvas(Modifier.fillMaxWidth().height(DOT)) { line() }
        // Wider than a short stretch ("5 min" between two 12-hour times): drawn past its ends, over the gap beside the names, not cut.
        Text(takes, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, softWrap = false, overflow = TextOverflow.Visible, modifier = Modifier.padding(top = 4.dp).wrapContentWidth(unbounded = true))
    }
}

private val CAPTION = 22.dp
private val DOT = 18.dp

/** Ticket: the bus first, as you'd look for it on the road, then when to leave and when you get there. */
@Composable
private fun Ticket(answer: NextAnswer, journey: Journey, now: Long) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(JourneyText.to(answer, journey, clockOf()), color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
        Box(Modifier.size(64.dp).background(Color(journey.bus.color), RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
            Text(badgeText(journey.bus.svc, journey.bus.paid), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp, maxLines = 1)
        }
        Spacer(Modifier.width(14.dp))
        Column {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(journey.bus.board, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                JourneyText.busIn(journey, now)?.let { Text(" $it", style = MaterialTheme.typography.titleSmall, color = muted, modifier = Modifier.padding(bottom = 2.dp)) }
            }
            Text(
                listOfNotNull(stringResource(R.string.journey_from, journey.bus.stop), journey.walk?.let { stringResource(R.string.journey_walk, it) }).joinToString(" · "),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
    val tint = if (answer.leaveLate) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Row(
        Modifier.padding(top = 14.dp).fillMaxWidth().background(tint.copy(alpha = 0.12f), RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(JourneyText.leaveIn(answer, journey, now), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = tint)
            JourneyText.by(answer, journey, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
        }
        journey.arrive?.let { arrive ->
            Column(horizontalAlignment = Alignment.End) {
                Text(stringResource(R.string.journey_arrive_time, arrive), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                // Late is said in red, as on the line and in the steps.
                Text(journey.slack ?: journey.walkEnd?.let { stringResource(R.string.journey_walk_from, it, journey.toStop) } ?: stringResource(R.string.journey_at, journey.toStop), style = MaterialTheme.typography.bodySmall, color = if (answer.leaveLate) MaterialTheme.colorScheme.error else muted)
            }
        }
    }
    Tags(answer, journey)
}

/** Steps: walk, bus, arrive, one under the other, each with its time. */
@Composable
private fun Steps(answer: NextAnswer, journey: Journey, now: Long) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(
        listOfNotNull(JourneyText.to(answer, journey, clockOf()), journey.arrive?.takeIf { !answer.isClassPlan }?.let { stringResource(R.string.journey_arrive_time, it) }).joinToString(" · "),
        color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
    LeaveHead(answer, journey, now)
    JourneyText.by(answer, journey, now)?.let { Text(it, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary) }
    Column(Modifier.padding(top = 14.dp)) {
        journey.walk?.let { walk ->
            Step(journey.leave ?: stringResource(R.string.journey_now), first = true, last = false, { Text(stringResource(R.string.journey_walk_to, journey.bus.stop), style = MaterialTheme.typography.bodyLarge) }, walk)
        }
        Step(
            journey.bus.board, first = journey.walk == null, last = false,
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    BusBadge(journey.bus.svc, journey.bus.color, 14.sp, paid = journey.bus.paid)
                    Text(stringResource(R.string.journey_from, journey.bus.stop), style = MaterialTheme.typography.bodyLarge)
                    if (journey.live) LiveTag()
                }
            },
            listOfNotNull(stringResource(R.string.journey_ride, journey.ride), journey.off?.let { stringResource(R.string.off_at, it) }).joinToString(" · "),
        )
        journey.walkEnd?.let { walk ->
            Step(journey.arriveStop ?: "", first = false, last = false, { Text(stringResource(R.string.journey_walk_to, journey.place), style = MaterialTheme.typography.bodyLarge) }, walk)
        }
        Step(journey.arrive ?: "", first = false, last = true, { Text(stringResource(R.string.journey_arrive_place, journey.to), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }, journey.slack, late = answer.leaveLate)
    }
    JourneyText.backup(answer, journey)?.let {
        HorizontalDivider(Modifier.padding(vertical = 10.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium, color = muted)
    }
}

/** One step: its time, a dot on the rail (filled for the first), what to do and for how long. */
@Composable
private fun Step(time: String, first: Boolean, last: Boolean, title: @Composable () -> Unit, sub: String?, late: Boolean = false) {
    val rail = MaterialTheme.colorScheme.outlineVariant
    Row(Modifier.height(IntrinsicSize.Min)) {
        Text(time, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.width(76.dp).padding(top = 2.dp))
        Column(Modifier.width(14.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            // The step you're on is filled; those to come are rings.
            val dot = Modifier.padding(top = 5.dp).size(12.dp)
            if (first) Box(dot.background(MaterialTheme.colorScheme.primary, CircleShape))
            else Box(dot.border(2.dp, MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
            if (!last) Box(Modifier.width(2.dp).weight(1f).background(rail))
        }
        Column(Modifier.padding(start = 12.dp, bottom = if (last) 0.dp else 14.dp)) {
            title()
            sub?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/** Clock times in the account's style, for a class's start. */
@Composable
private fun clockOf(): (Long) -> String {
    val ctx = LocalContext.current
    return { clock(ctx, it) }
}

/** "Leave in 45 s" or "Leave now", red when it's too late to be on time. */
@Composable
private fun LeaveHead(answer: NextAnswer, journey: Journey, now: Long) {
    Text(
        JourneyText.leaveIn(answer, journey, now),
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = if (answer.leaveLate) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
}

/** Live (or not), the crowd, and the backup bus, as tags under the trip. */
@Composable
private fun Tags(answer: NextAnswer, journey: Journey) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
        if (journey.live) Pill(stringResource(R.string.journey_live), goodColor())
        // The crowd is the headline bus's: a class's leave-by bus can be another.
        if (!answer.isClassPlan) answer.card?.crowd?.let { Pill(it, muted) }
    }
    JourneyText.backup(answer, journey)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = muted, modifier = Modifier.padding(top = 8.dp)) }
}

/** "Live", with a green dot. */
@Composable
private fun LiveTag() {
    val good = goodColor()
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).background(good, CircleShape))
        Spacer(Modifier.width(4.dp))
        Text(stringResource(R.string.journey_live), style = MaterialTheme.typography.labelMedium, color = good)
    }
}

/** The badge's text: the service, with a $ after a public bus's number so the fare is never a surprise. */
internal fun badgeText(svc: String, paid: Boolean): String = if (paid) "$svc \$" else svc

/** A service as it's painted on the bus: white on its colour. */
@Composable
internal fun BusBadge(svc: String, color: Long, size: TextUnit, pad: Dp = 6.dp, paid: Boolean = false) {
    val fare = stringResource(R.string.public_bus_fare)
    Text(
        badgeText(svc, paid),
        color = Color.White,
        fontWeight = FontWeight.ExtraBold,
        fontSize = size,
        maxLines = 1,
        modifier = Modifier
            .background(Color(color), RoundedCornerShape(6.dp))
            .padding(horizontal = pad, vertical = 1.dp)
            .semantics { contentDescription = if (paid) "$svc, $fare" else svc },
    )
}
