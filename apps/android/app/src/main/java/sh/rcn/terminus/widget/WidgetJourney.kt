package sh.rcn.terminus.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
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
import sh.rcn.terminus.JourneyBus
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock

/**
 * A trip's steps on the ground of the big widget, under the headline the sky already shows, in the card style chosen in Settings ›
 * Appearance: Steps down the side with the ride in its service's colour, or the Route across. How tall each is: [journeyHeight].
 */
@Composable
internal fun WidgetJourney(journey: Journey, style: String, inks: Inks, page: ColorProvider) {
    when (style) {
        CardStyle.ROUTE -> Route(journey, inks)
        else -> Steps(journey, inks, page)
    }
}

/** The room [WidgetJourney] takes in [style]: Steps a row a step, the Route its line. */
internal fun journeyHeight(journey: Journey, style: String): Dp =
    when (style) {
        CardStyle.ROUTE -> 52.dp
        // The rows Steps draws: leave (only with a walk first), the bus, and
        // where you end up; the last is shorter with nothing under its name.
        else -> STEP * stepRows(journey) - (if (lastUnder(journey) == null) 12.dp else 0.dp)
    }

/**
 * How many steps [Steps] draws: leave when there's a walk first, the bus when there is one, the second bus of a change, and where you end
 * up.
 */
internal fun stepRows(journey: Journey): Int =
    (if (journey.walk != null) 1 else 0) + (if (journey.bus != null) 1 else 0) + (if (journey.change != null) 1 else 0) + 1

/** Under the last step: "2 min walk from UTown", or a class's "9 min early". */
private fun lastUnder(journey: Journey): String? = journey.walkEnd?.let { JourneyText.arriveWhere(journey) } ?: journey.slack

private fun solid(argb: Long) = ColorProvider(Color(argb))

/** The big line's lines: one, or two when the phone's text is scaled up, so it wraps rather than cuts. */
@Composable internal fun headLines(): Int = if (LocalContext.current.resources.configuration.fontScale > 1.15f) 2 else 1

/** How much wider a column of times is with the phone's text scaled up. */
@Composable private fun widen(): Float = LocalContext.current.resources.configuration.fontScale.coerceIn(1f, 1.8f)

/** A step's height: its name and the line under it. */
private val STEP = 38.dp

/**
 * Steps: leave, the bus at its stop, and where you get off, down a line drawn as the trip goes (dotted on foot, the ride in its colour).
 */
@Composable
private fun Steps(journey: Journey, inks: Inks, page: ColorProvider) {
    val bus = journey.bus
    val now = ServerClock.now()
    Column(GlanceModifier.fillMaxWidth()) {
        journey.walk?.let {
            Step(
                journey.leave ?: L.s(R.string.journey_now),
                Dot.YOU,
                Rail.WALK,
                L.s(R.string.journey_leave),
                JourneyText.walk(journey),
                null,
                inks,
                page,
            )
        }
        if (bus != null) {
            Step(
                bus.board,
                Dot.STOP,
                Rail.Ride(bus.color),
                bus.stop,
                journey.change?.firstRideText ?: JourneyText.ride(journey),
                bus to JourneyText.busIn(journey, now),
                inks,
                page,
            )
        }
        journey.change?.let { c ->
            Step(c.bus.board, Dot.STOP, Rail.Ride(c.bus.color), c.stop, c.changeText, c.bus to null, inks, page)
        }
        val there = if (bus != null) journey.toStop.ifEmpty { journey.place } else journey.place
        Step(journey.arriveStop ?: journey.arrive.orEmpty(), Dot.THERE, null, there, lastUnder(journey), null, inks, page, last = true)
    }
}

private enum class Dot {
    YOU,
    STOP,
    THERE,
}

private sealed interface Rail {
    data object WALK : Rail

    data class Ride(val color: Long) : Rail
}

@Composable
private fun Step(
    time: String,
    dot: Dot,
    rail: Rail?,
    name: String,
    under: String?,
    bus: Pair<JourneyBus, String?>?,
    inks: Inks,
    page: ColorProvider,
    last: Boolean = false,
) {
    Row(GlanceModifier.fillMaxWidth().height(if (last && under == null) STEP - 12.dp else STEP), verticalAlignment = Alignment.Top) {
        Text(
            time,
            style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
            maxLines = 1,
            modifier = GlanceModifier.width(52.dp * widen()),
        )
        Column(GlanceModifier.width(16.dp).padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            when (dot) {
                Dot.YOU -> Box(GlanceModifier.size(12.dp).cornerRadius(6.dp).background(inks.accent)) {}
                // A ring: the stop in ink, where you're going in the accent.
                else ->
                    Box(
                        GlanceModifier.size(12.dp).cornerRadius(6.dp).background(if (dot == Dot.THERE) inks.accent else inks.ink),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(GlanceModifier.size(6.dp).cornerRadius(3.dp).background(page)) {}
                    }
            }
            when (rail) {
                Rail.WALK ->
                    Column(GlanceModifier.padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        repeat(4) {
                            Box(GlanceModifier.size(2.5.dp).cornerRadius(1.dp).background(inks.muted)) {}
                            Spacer(GlanceModifier.height(2.5.dp))
                        }
                    }
                is Rail.Ride ->
                    Box(
                        GlanceModifier.padding(top = 2.dp)
                            .width(3.dp)
                            .height(STEP - 17.dp)
                            .cornerRadius(1.5.dp)
                            .background(solid(rail.color))
                    ) {}
                null -> {}
            }
        }
        Spacer(GlanceModifier.width(6.dp))
        Column(GlanceModifier.defaultWeight()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold), maxLines = 1)
                bus?.let { (b, inAt) ->
                    Spacer(GlanceModifier.width(6.dp))
                    Badge(b.svc, b.color, b.paid)
                    inAt?.let {
                        Spacer(GlanceModifier.width(6.dp))
                        Small(it, inks.muted, 11.sp)
                    }
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
    // A change of bus takes the room of the walk to the stop, and of the walk on at the end.
    val change = journey.change != null && bus != null
    val four = journey.walkEnd != null && !change && LocalSize.current.width >= 300.dp
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        val w = if (four || change) 46.dp else 56.dp
        if (!change)
            journey.walk?.let { walk ->
                Point(L.s(R.string.journey_you), journey.leave ?: L.s(R.string.journey_now), inks.accent, w, inks)
                Stretch(walk, null, inks.muted, 2.dp, inks)
            }
        if (bus == null) {
            Point(journey.place, journey.arrive ?: "", inks.ink, w, inks)
            return@Row
        }
        Point(bus.stop, bus.board, inks.ink, w, inks)
        val change = journey.change
        Stretch(change?.firstRide ?: journey.ride.orEmpty(), bus, solid(bus.color), 4.dp, inks)
        // A change of bus: the stop the second bus goes from, then its ride, as on the app's line.
        if (change != null) {
            Point(change.stop, change.bus.board, inks.ink, w, inks)
            Stretch(change.ride, change.bus, solid(change.bus.color), 4.dp, inks)
        }
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
        Text(
            name,
            style = TextStyle(color = inks.ink, fontSize = 11.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
            maxLines = headLines(),
        )
        Text(time, style = TextStyle(color = inks.muted, fontSize = 11.sp, textAlign = TextAlign.Center), maxLines = 1)
    }
}

/** Between two points: the walk's minutes, or the bus and its ride, over a bar. */
@Composable
private fun RowScope.Stretch(caption: String, bus: JourneyBus?, color: ColorProvider, thick: Dp, inks: Inks) {
    Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(GlanceModifier.height(CAPTION), verticalAlignment = Alignment.CenterVertically) {
            bus?.let {
                Badge(it.svc, it.color, it.paid)
                Spacer(GlanceModifier.width(4.dp))
            }
            Text(caption, style = TextStyle(color = inks.muted, fontSize = 11.sp), maxLines = 1)
        }
        Box(GlanceModifier.fillMaxWidth().height(DOT), contentAlignment = Alignment.Center) {
            Box(GlanceModifier.fillMaxWidth().height(thick).cornerRadius(thick / 2).background(color)) {}
        }
    }
}
