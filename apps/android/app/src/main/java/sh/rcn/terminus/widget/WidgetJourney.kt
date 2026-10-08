package sh.rcn.terminus.widget

import sh.rcn.terminus.ServerClock
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.RowScope
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.L
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R

/**
 * A trip's steps on the ground of the big widget, under the headline the
 * sky already shows, in the card style chosen in Settings › Appearance:
 * Steps down the side with the ride in its service's colour, the Route
 * across, or the Ticket. How tall each is: [journeyHeight].
 */
@Composable
internal fun WidgetJourney(answer: NextAnswer, journey: Journey, style: String, inks: Inks, page: ColorProvider) {
    when (style) {
        CardStyle.TICKET -> Ticket(answer, journey, inks)
        CardStyle.ROUTE -> Route(journey, inks)
        else -> Steps(journey, inks, page)
    }
}

/** The room [WidgetJourney] takes in [style]: Steps a row a step, the Route its line, the Ticket its badge. */
internal fun journeyHeight(journey: Journey, style: String): Dp = when (style) {
    CardStyle.TICKET -> 58.dp
    CardStyle.ROUTE -> 52.dp
    // The last step is shorter with nothing under its name.
    else -> STEP * (if (journey.bus != null) 3 else 2) - (if (lastUnder(journey) == null) 12.dp else 0.dp)
}

/** Under the last step: "2 min walk from UTown", or a class's "9 min early". */
private fun lastUnder(journey: Journey): String? = journey.walkEnd?.let { JourneyText.arriveWhere(journey) } ?: journey.slack

private fun solid(argb: Long) = ColorProvider(Color(argb))

/** The big line's lines: one, or two when the phone's text is scaled up, so it wraps rather than cuts. */
@Composable
internal fun headLines(): Int = if (LocalContext.current.resources.configuration.fontScale > 1.15f) 2 else 1

/** How much wider a column of times is with the phone's text scaled up. */
@Composable
private fun widen(): Float = LocalContext.current.resources.configuration.fontScale.coerceIn(1f, 1.8f)

/** A step's height: its name and the line under it. */
private val STEP = 38.dp

/** Steps: leave, the bus at its stop, and where you get off, down a line drawn as the trip goes (dotted on foot, the ride in its colour). */
@Composable
private fun Steps(journey: Journey, inks: Inks, page: ColorProvider) {
    val bus = journey.bus
    val now = ServerClock.now()
    Column(GlanceModifier.fillMaxWidth()) {
        journey.walk?.let {
            Step(journey.leave ?: L.s(R.string.journey_now), Dot.YOU, Rail.WALK, L.s(R.string.journey_leave), JourneyText.walk(journey), null, inks, page)
        }
        if (bus != null) {
            Step(bus.board, Dot.STOP, Rail.Ride(bus.color), bus.stop, JourneyText.ride(journey), bus.let { Triple(it.svc, it.color, JourneyText.busIn(journey, now)) }, inks, page)
        }
        val there = if (bus != null) journey.toStop.ifEmpty { journey.place } else journey.place
        Step(journey.arriveStop ?: journey.arrive.orEmpty(), Dot.THERE, null, there, lastUnder(journey), null, inks, page, last = true)
    }
}

private enum class Dot { YOU, STOP, THERE }

private sealed interface Rail {
    data object WALK : Rail
    data class Ride(val color: Long) : Rail
}

@Composable
private fun Step(time: String, dot: Dot, rail: Rail?, name: String, under: String?, bus: Triple<String, Long, String?>?, inks: Inks, page: ColorProvider, last: Boolean = false) {
    Row(GlanceModifier.fillMaxWidth().height(if (last && under == null) STEP - 12.dp else STEP), verticalAlignment = Alignment.Top) {
        Text(time, style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.width(52.dp * widen()))
        Column(GlanceModifier.width(16.dp).padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            when (dot) {
                Dot.YOU -> Box(GlanceModifier.size(12.dp).cornerRadius(6.dp).background(inks.accent)) {}
                // A ring: the stop in ink, where you're going in the accent.
                else -> Box(GlanceModifier.size(12.dp).cornerRadius(6.dp).background(if (dot == Dot.THERE) inks.accent else inks.ink), contentAlignment = Alignment.Center) {
                    Box(GlanceModifier.size(6.dp).cornerRadius(3.dp).background(page)) {}
                }
            }
            when (rail) {
                Rail.WALK -> Column(GlanceModifier.padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    repeat(4) { Box(GlanceModifier.size(2.5.dp).cornerRadius(1.dp).background(inks.muted)) {}; Spacer(GlanceModifier.height(2.5.dp)) }
                }
                is Rail.Ride -> Box(GlanceModifier.padding(top = 2.dp).width(3.dp).height(STEP - 17.dp).cornerRadius(1.5.dp).background(solid(rail.color))) {}
                null -> {}
            }
        }
        Spacer(GlanceModifier.width(6.dp))
        Column(GlanceModifier.defaultWeight()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold), maxLines = 1)
                bus?.let { (svc, color, inAt) ->
                    Spacer(GlanceModifier.width(6.dp))
                    Badge(svc, color)
                    inAt?.let { Spacer(GlanceModifier.width(6.dp)); Small(it, inks.muted, 11.sp) }
                }
            }
            under?.let { Small(it, inks.muted, 11.5.sp) }
        }
    }
}

/** Route: you, the stop and where you're going on a line across, the ride in its service's colour. */
@Composable
private fun Route(journey: Journey, inks: Inks) {
    val bus = journey.bus
    val four = journey.walkEnd != null && LocalSize.current.width >= 300.dp
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        val w = if (four) 46.dp else 56.dp
        journey.walk?.let { walk ->
            Point(L.s(R.string.journey_you), journey.leave ?: L.s(R.string.journey_now), inks.accent, w, inks)
            Stretch(walk, null, inks.muted, 2.dp, inks)
        }
        if (bus == null) {
            Point(journey.place, journey.arrive ?: "", inks.ink, w, inks)
            return@Row
        }
        Point(bus.stop, bus.board, inks.ink, w, inks)
        Stretch(journey.ride.orEmpty(), bus.svc to bus.color, solid(bus.color), 4.dp, inks)
        if (four) {
            Point(journey.toStop, journey.arriveStop ?: "", inks.ink, w, inks)
            Stretch(journey.walkEnd, null, inks.muted, 2.dp, inks)
            Point(journey.place, journey.arrive ?: "", inks.ink, w, inks)
        } else {
            Point(if (journey.walkEnd != null) journey.place else journey.toStop, journey.arrive ?: "", inks.ink, w, inks)
        }
    }
}

private val CAPTION = 16.dp
private val DOT = 10.dp

@Composable
private fun Point(name: String, time: String, dot: ColorProvider, width: Dp, inks: Inks) {
    Column(GlanceModifier.width(width), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(GlanceModifier.height(CAPTION))
        Box(GlanceModifier.size(DOT).cornerRadius(DOT / 2).background(dot)) {}
        Text(name, style = TextStyle(color = inks.ink, fontSize = 11.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center), maxLines = headLines())
        Text(time, style = TextStyle(color = inks.muted, fontSize = 11.sp, textAlign = TextAlign.Center), maxLines = 1)
    }
}

/** Between two points: the walk's minutes, or the bus and its ride, over a bar. */
@Composable
private fun RowScope.Stretch(caption: String, svc: Pair<String, Long>?, color: ColorProvider, thick: Dp, inks: Inks) {
    Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(GlanceModifier.height(CAPTION), verticalAlignment = Alignment.CenterVertically) {
            svc?.let {
                Badge(it.first, it.second)
                Spacer(GlanceModifier.width(4.dp))
            }
            Text(caption, style = TextStyle(color = inks.muted, fontSize = 11.sp), maxLines = 1)
        }
        Box(GlanceModifier.fillMaxWidth().height(DOT), contentAlignment = Alignment.Center) {
            Box(GlanceModifier.fillMaxWidth().height(thick).cornerRadius(thick / 2).background(color)) {}
        }
    }
}

/** Ticket: the bus as a big badge in its colour, its time and stop, then when you get there. On foot, someone walking and the walk. */
@Composable
private fun Ticket(answer: NextAnswer, journey: Journey, inks: Inks) {
    val bus = journey.bus
    Row(verticalAlignment = Alignment.CenterVertically) {
        val side = 48.dp
        if (bus != null) {
            Box(GlanceModifier.size(side).cornerRadius(12.dp).background(solid(bus.color)), contentAlignment = Alignment.Center) {
                Text(bus.svc, style = TextStyle(color = solid(sh.rcn.terminus.Ink.on(bus.color)), fontWeight = FontWeight.Bold, fontSize = 18.sp), maxLines = 1)
            }
        } else {
            Box(GlanceModifier.size(side).cornerRadius(12.dp).background(inks.chip), contentAlignment = Alignment.Center) {
                Image(ImageProvider(R.drawable.ic_walk), contentDescription = null, colorFilter = ColorFilter.tint(inks.ink), modifier = GlanceModifier.size(side / 2))
            }
        }
        Spacer(GlanceModifier.width(12.dp))
        Column {
            Text(
                if (bus != null) listOfNotNull(bus.board, L.s(R.string.journey_from, bus.stop)).joinToString(" ") else L.s(R.string.journey_walk, journey.walk.orEmpty()),
                style = TextStyle(color = inks.ink, fontWeight = FontWeight.Bold, fontSize = 17.sp),
                maxLines = 1,
            )
            JourneyText.arrive(journey)?.let { Small(it, if (answer.leaveLate) inks.late else inks.muted, 12.sp, bold = true) }
        }
    }
}
