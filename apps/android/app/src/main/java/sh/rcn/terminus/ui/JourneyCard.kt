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
import androidx.compose.material3.Icon
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
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
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
 * A trip by bus, or on foot the whole way, drawn in the style chosen in
 * Settings › Appearance ([CardStyle]). All three lead with when to leave and
 * end with when you get there; the words and times are the server's
 * (`card.journey`), and only the countdowns tick here.
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
    // On foot, the bus's data quality isn't about the walk: `why` says what matters.
    if (journey.bus != null && !journey.live) answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 4.dp)) }
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

/** The line itself: a dashed walk, the bus's stretch in its colour, how long each takes under it. On foot, you and the place, the walk between. */
@Composable
internal fun RouteLine(journey: Journey, modifier: Modifier = Modifier) {
    val fg = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val dashed: androidx.compose.ui.graphics.drawscope.DrawScope.() -> Unit = {
        drawLine(muted, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 6.dp.toPx())))
    }
    val bus = journey.bus
    if (bus == null) {
        Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
            Point(stringResource(R.string.journey_you), journey.leave ?: stringResource(R.string.journey_now), MaterialTheme.colorScheme.primary)
            Stretch(Modifier.weight(1f), {}, journey.walk.orEmpty(), dashed)
            Point(journey.place, journey.arrive ?: "", fg)
        }
        return
    }
    val paint = Color(bus.color)
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        journey.walk?.let { walk ->
            Point(stringResource(R.string.journey_you), journey.leave ?: stringResource(R.string.journey_now), MaterialTheme.colorScheme.primary, narrow = journey.walkEnd != null)
            Stretch(Modifier.weight(1f), {}, walk, dashed)
        }
        Point(bus.stop, bus.board, fg, narrow = journey.walkEnd != null)
        Stretch(Modifier.weight(1.4f), { BusBadge(bus.svc, bus.color, 12.sp, paid = bus.paid) }, journey.ride.orEmpty()) {
            drawLine(paint, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 5.dp.toPx(), StrokeCap.Round)
        }
        Point(journey.toStop, (if (journey.walkEnd != null) journey.arriveStop else journey.arrive) ?: "", fg, narrow = journey.walkEnd != null)
        // On from the stop to the room or building: a fourth point, so the points take only the room their words need.
        journey.walkEnd?.let { walk ->
            Stretch(Modifier.weight(1f), {}, walk, dashed)
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

/** Ticket: the bus first, as you'd look for it on the road, then when to leave and when you get there. On foot, the walk in its place. */
@Composable
private fun Ticket(answer: NextAnswer, journey: Journey, now: Long) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(JourneyText.to(answer, journey, clockOf()), color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    val bus = journey.bus
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 10.dp)) {
        if (bus != null) {
            Box(Modifier.size(64.dp).background(Color(bus.color), RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
                Text(badgeText(bus.svc, bus.paid), color = Color.White, fontWeight = FontWeight.ExtraBold, fontSize = 26.sp, maxLines = 1)
            }
        } else {
            Box(Modifier.size(64.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(16.dp)), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_walk), contentDescription = null, tint = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(34.dp))
            }
        }
        Spacer(Modifier.width(14.dp))
        Column {
            if (bus != null) {
                Row(verticalAlignment = Alignment.Bottom) {
                    Text(bus.board, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    JourneyText.busIn(journey, now)?.let { Text(" $it", style = MaterialTheme.typography.titleSmall, color = muted, modifier = Modifier.padding(bottom = 2.dp)) }
                }
                Text(
                    listOfNotNull(stringResource(R.string.journey_from, bus.stop), journey.walk?.let { stringResource(R.string.journey_walk, it) }).joinToString(" · "),
                    style = MaterialTheme.typography.bodyLarge,
                )
            } else {
                Text(stringResource(R.string.journey_walk, journey.walk.orEmpty()), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                // Why not the bus, which the others say under the trip.
                Text(journey.why ?: stringResource(R.string.journey_walk_to, journey.place), style = MaterialTheme.typography.bodyLarge)
            }
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
    if (bus != null) Tags(answer, journey)
}

/**
 * Steps: the trip as a line diagram, as on a bus's route map. Each point
 * has its time on the left and a dot on the line; between them the walk is
 * dotted and the ride is drawn in the bus's colour; the last point, where
 * you're going, is ringed in the accent.
 */
@Composable
private fun Steps(answer: NextAnswer, journey: Journey, now: Long) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val late = answer.leaveLate
    Text(JourneyText.to(answer, journey, clockOf()), color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    LeaveHead(answer, journey, now)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOfNotNull(JourneyText.by(answer, journey, now), journey.slack).joinToString(" · ").takeIf { it.isNotEmpty() }?.let {
            Text(it, color = if (late) MaterialTheme.colorScheme.error else muted, modifier = Modifier.weight(1f, fill = false))
        }
        if (journey.live) Pill(stringResource(R.string.journey_live), goodColor())
        if (!answer.isClassPlan) answer.card?.crowd?.let { Pill(it, muted) }
    }
    val bus = journey.bus
    Column(Modifier.padding(top = 18.dp)) {
        val walk = journey.walk
        if (walk != null) {
            LinePoint(journey.leave ?: stringResource(R.string.journey_now), Dot.START, Line.Walk, stringResource(R.string.journey_walk, walk)) {
                Text(stringResource(R.string.journey_leave), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
        }
        // On foot the whole way, the walk runs straight from leaving to the place.
        if (bus != null) LinePoint(
            bus.board, if (walk == null) Dot.START else Dot.STOP, Line.Ride(Color(bus.color)),
            listOfNotNull(journey.ride?.let { stringResource(R.string.journey_ride, it) }, journey.off?.let { stringResource(R.string.off_at, it) }).joinToString(" · "),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(bus.stop, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                BusBadge(bus.svc, bus.color, 13.sp, paid = bus.paid)
                JourneyText.busIn(journey, now)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1) }
            }
        }
        journey.walkEnd?.let { w ->
            LinePoint(journey.arriveStop ?: "", Dot.STOP, Line.Walk, stringResource(R.string.journey_walk, w)) {
                Text(journey.toStop, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            }
        }
        LinePoint(journey.arrive ?: "", Dot.END, null, journey.slack, late = late) {
            Text(if (bus == null || journey.walkEnd != null) journey.place else journey.toStop, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        }
    }
    JourneyText.backup(answer, journey)?.let {
        Text(
            it,
            style = MaterialTheme.typography.bodyMedium,
            color = muted,
            modifier = Modifier.padding(top = 14.dp).fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(14.dp)).padding(horizontal = 14.dp, vertical = 11.dp),
        )
    }
}

private enum class Dot { START, STOP, END }

/** The stretch after a point: a walk (dotted) or a ride (the bus's colour). */
private sealed interface Line {
    data object Walk : Line
    data class Ride(val color: Color) : Line
}

/**
 * A point on the line: its time, its dot, what's there, and under it how
 * long the stretch to the next point takes, which the line runs beside.
 */
@Composable
private fun LinePoint(time: String, dot: Dot, line: Line?, below: String?, late: Boolean = false, title: @Composable () -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(Modifier.height(IntrinsicSize.Min)) {
        Text(time, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.width(72.dp).padding(top = 3.dp))
        Column(Modifier.width(26.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            val ring = c.onSurface
            val bg = c.background
            val accent = c.primary
            Canvas(Modifier.padding(top = 4.dp).size(20.dp)) {
                val mid = center
                when (dot) {
                    Dot.START -> drawCircle(accent, 7.dp.toPx(), mid)
                    Dot.STOP -> {
                        drawCircle(bg, 7.dp.toPx(), mid)
                        drawCircle(ring, 5.5.dp.toPx(), mid, style = Stroke(3.dp.toPx()))
                    }
                    Dot.END -> {
                        drawCircle(bg, 10.dp.toPx(), mid)
                        drawCircle(accent, 7.dp.toPx(), mid, style = Stroke(5.5.dp.toPx()))
                    }
                }
            }
            if (line != null) {
                val walkInk = c.onSurfaceVariant
                Canvas(Modifier.weight(1f).fillMaxWidth().padding(vertical = 3.dp)) {
                    val x = size.width / 2
                    when (line) {
                        Line.Walk -> drawLine(walkInk, Offset(x, 0f), Offset(x, size.height), 3.dp.toPx(), StrokeCap.Round, PathEffect.dashPathEffect(floatArrayOf(2.dp.toPx(), 6.dp.toPx())))
                        is Line.Ride -> drawLine(line.color, Offset(x, 0f), Offset(x, size.height), 7.dp.toPx(), StrokeCap.Round)
                    }
                }
            }
        }
        Column(Modifier.padding(start = 10.dp, top = 1.dp, bottom = if (line == null) 0.dp else 14.dp)) {
            title()
            below?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (late) c.error else c.onSurfaceVariant,
                    // A ride's stretch is longer: the line is the trip's backbone.
                    modifier = Modifier.padding(top = if (line is Line.Ride) 14.dp else 6.dp, bottom = if (line is Line.Ride) 14.dp else 0.dp),
                )
            }
        }
    }
}

/** Clock times in the account's style, for a class's start. */
@Composable
private fun clockOf(): (Long) -> String {
    val ctx = LocalContext.current
    return { clock(ctx, it) }
}

/**
 * "Leave in 6 min" as one line at one size, with only the time in the
 * accent, so it reads first without a giant digit crowding the lines round
 * it. "Leave now" is all accent; too late to be on time, all red.
 */
@Composable
private fun LeaveHead(answer: NextAnswer, journey: Journey, now: Long) {
    val text = JourneyText.leaveIn(answer, journey, now)
    val time = JourneyText.leaveTime(answer, journey, now)
    val c = MaterialTheme.colorScheme
    val accent = c.primary
    val head = buildAnnotatedString {
        append(text)
        val at = time?.let { text.indexOf(it) } ?: -1
        when {
            answer.leaveLate -> {}
            at >= 0 -> addStyle(SpanStyle(color = accent), at, at + time!!.length)
            time == null -> addStyle(SpanStyle(color = accent), 0, text.length)
        }
    }
    Text(
        head,
        fontSize = 34.sp,
        lineHeight = 38.sp,
        fontWeight = FontWeight.ExtraBold,
        letterSpacing = (-0.5).sp,
        color = if (answer.leaveLate) c.error else c.onSurface,
        modifier = Modifier.padding(top = 2.dp, bottom = 2.dp),
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
