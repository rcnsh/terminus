package sh.rcn.terminus.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
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
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyText
import sh.rcn.terminus.L
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R

/**
 * A trip by bus on the widget, in the card style chosen in Settings ›
 * Appearance. A widget can't tick every second, so it leads with "Leave by
 * 4:01 PM", true until then, and turns to "Leave now" when it's redrawn
 * then. [roomy]: room for more than the headline and one line; [large]: the
 * big widget, with room for the backup bus too.
 */
@Composable
internal fun WidgetJourney(answer: NextAnswer, journey: Journey, style: String, large: Boolean, roomy: Boolean, note: String?) {
    when (style) {
        CardStyle.TICKET -> Ticket(answer, journey, large, roomy, note)
        CardStyle.STEPS -> Steps(answer, journey, large, roomy, note)
        else -> Route(answer, journey, large, roomy, note)
    }
}

private val white = ColorProvider(Color.White, Color.White)
private fun fixed(argb: Long) = ColorProvider(Color(argb), Color(argb))

private fun headline(answer: NextAnswer): String = answer.leaveHeadline(System.currentTimeMillis()) ?: L.s(R.string.leave_now)

@Composable
private fun Headline(answer: NextAnswer, large: Boolean) {
    val colors = GlanceTheme.colors
    Text(
        headline(answer),
        style = TextStyle(color = if (answer.leaveLate) colors.error else colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 24.sp else 20.sp),
        maxLines = 1,
    )
}

/**
 * "To UTown · arrive 4:13 PM", or for a class "To GEA1000 @ UTown · starts
 * 10:00", with "~5 min late" in red when it will be. A problem instead, when
 * there is one (a compact widget has no footer).
 */
@Composable
private fun Head(answer: NextAnswer, journey: Journey, note: String?, withArrive: Boolean) {
    val ctx = LocalContext.current
    val late = answer.isClassPlan && answer.leaveLate && note == null
    val text = note ?: listOfNotNull(
        JourneyText.to(answer, journey) { clock(ctx, it) },
        journey.arrive?.takeIf { withArrive }?.let { L.s(R.string.journey_arrive_time, it) },
        journey.slack?.takeIf { late },
    ).joinToString(" · ")
    Text(text, style = TextStyle(color = if (late) GlanceTheme.colors.error else GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1)
}

/** A class's "Arrive ~9:51 AM · 9 min early", red when it's late. */
@Composable
private fun Arrival(answer: NextAnswer, journey: Journey, top: Dp = 4.dp) {
    if (!answer.isClassPlan) return
    val colors = GlanceTheme.colors
    JourneyText.arrive(journey)?.let {
        Text(it, style = TextStyle(color = if (answer.leaveLate) colors.error else colors.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.padding(top = top))
    }
}

/** Route: the headline, then you → the stop → where you're going on a line. */
@Composable
private fun Route(answer: NextAnswer, journey: Journey, large: Boolean, roomy: Boolean, note: String?) {
    // A compact class says its arrival on the line under the headline.
    Head(answer, journey, note, withArrive = !roomy && !answer.isClassPlan)
    Headline(answer, large)
    if (!roomy) {
        Text(oneLine(answer, journey), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1)
        return
    }
    Spacer(GlanceModifier.height(6.dp))
    val colors = GlanceTheme.colors
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        journey.walk?.let { walk ->
            Point(L.s(R.string.journey_you), journey.leave ?: L.s(R.string.journey_now), true)
            Stretch(walk, null, colors.outline, 2.dp)
        }
        Point(journey.bus.stop, journey.bus.board, false)
        Stretch(journey.ride, journey.bus.svc, fixed(journey.bus.color), 4.dp)
        Point(journey.toStop, journey.arrive ?: "", false)
    }
    Arrival(answer, journey)
    // One line under the line fits: for a class, whether it's on time beats the backup bus.
    if (large && !answer.isClassPlan) JourneyText.backup(answer, journey)?.let { Text(it, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1, modifier = GlanceModifier.padding(top = 4.dp)) }
}

private val CAPTION = 16.dp
private val DOT = 10.dp

@Composable
private fun Point(name: String, time: String, you: Boolean) {
    val colors = GlanceTheme.colors
    Column(GlanceModifier.width(56.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Spacer(GlanceModifier.height(CAPTION))
        Box(GlanceModifier.size(DOT).cornerRadius(DOT / 2).background(if (you) colors.primary else colors.onSurface)) {}
        Text(name, style = TextStyle(color = colors.onSurface, fontSize = 11.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center), maxLines = 1)
        Text(time, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 11.sp, textAlign = TextAlign.Center), maxLines = 1)
    }
}

/** Between two points: the walk's minutes, or the bus and its ride, over a bar. */
@Composable
private fun RowScope.Stretch(caption: String, svc: String?, color: androidx.glance.unit.ColorProvider, thick: Dp) {
    val colors = GlanceTheme.colors
    Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(GlanceModifier.height(CAPTION), verticalAlignment = Alignment.CenterVertically) {
            svc?.let {
                Box(GlanceModifier.cornerRadius(4.dp).background(color).padding(horizontal = 4.dp)) {
                    Text(it, style = TextStyle(color = white, fontWeight = FontWeight.Bold, fontSize = 11.sp), maxLines = 1)
                }
                Spacer(GlanceModifier.width(4.dp))
            }
            Text(caption, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 11.sp), maxLines = 1)
        }
        Box(GlanceModifier.fillMaxWidth().height(DOT), contentAlignment = Alignment.Center) {
            Box(GlanceModifier.fillMaxWidth().height(thick).cornerRadius(thick / 2).background(color)) {}
        }
    }
}

/** Ticket: the bus as a badge in its colour, its time and stop, then when to leave. */
@Composable
private fun Ticket(answer: NextAnswer, journey: Journey, large: Boolean, roomy: Boolean, note: String?) {
    val colors = GlanceTheme.colors
    if (roomy) Head(answer, journey, note, withArrive = false)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.padding(top = if (roomy) 6.dp else 0.dp)) {
        val side = if (large) 52.dp else 44.dp
        Box(GlanceModifier.size(side).cornerRadius(12.dp).background(fixed(journey.bus.color)), contentAlignment = Alignment.Center) {
            Text(journey.bus.svc, style = TextStyle(color = white, fontWeight = FontWeight.Bold, fontSize = if (large) 20.sp else 17.sp), maxLines = 1)
        }
        Spacer(GlanceModifier.width(12.dp))
        Column {
            Text(
                listOfNotNull(journey.bus.board, L.s(R.string.journey_from, journey.bus.stop)).joinToString(" "),
                style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 20.sp else 17.sp),
                maxLines = 1,
            )
            // A class's arrival and margin get a line of their own on the big
            // widget; otherwise the arrival time goes after the headline.
            val split = large && answer.isClassPlan
            Text(
                listOfNotNull(headline(answer), journey.arrive?.takeIf { !split }?.let { L.s(R.string.journey_arrive_time, it) }).joinToString(" · "),
                style = TextStyle(color = if (answer.leaveLate) colors.error else colors.primary, fontSize = 13.sp, fontWeight = FontWeight.Medium),
                maxLines = 1,
            )
            if (split) Arrival(answer, journey, top = 0.dp)
        }
    }
    if (large && !answer.isClassPlan) JourneyText.backup(answer, journey)?.let { Text(it, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1, modifier = GlanceModifier.padding(top = 6.dp)) }
}

/** Steps: the headline, then walk, bus and arrive with their times, as many as fit. */
@Composable
private fun Steps(answer: NextAnswer, journey: Journey, large: Boolean, roomy: Boolean, note: String?) {
    // The big widget's last step is the arrival; the others say it at the top.
    Head(answer, journey, note, withArrive = !large && (roomy || !answer.isClassPlan))
    Headline(answer, large)
    if (!roomy) {
        Text(oneLine(answer, journey), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1)
        return
    }
    Spacer(GlanceModifier.height(4.dp))
    journey.walk?.let { StepLine(journey.leave ?: L.s(R.string.journey_now), "${L.s(R.string.journey_walk_to, journey.bus.stop)} · $it", null) }
    StepLine(journey.bus.board, "${L.s(R.string.journey_from, journey.bus.stop)} · ${L.s(R.string.journey_ride, journey.ride)}", journey)
    if (large) StepLine(journey.arrive ?: "", listOfNotNull(L.s(R.string.journey_arrive_place, journey.to), journey.slack).joinToString(" · "), null, late = answer.leaveLate)
}

@Composable
private fun StepLine(time: String, what: String, bus: Journey?, late: Boolean = false) {
    val colors = GlanceTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, modifier = GlanceModifier.padding(top = 3.dp)) {
        Text(time, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1, modifier = GlanceModifier.width(64.dp))
        bus?.let {
            Box(GlanceModifier.cornerRadius(5.dp).background(fixed(it.bus.color)).padding(horizontal = 5.dp, vertical = 1.dp)) {
                Text(it.bus.svc, style = TextStyle(color = white, fontWeight = FontWeight.Bold, fontSize = 12.sp), maxLines = 1)
            }
            Spacer(GlanceModifier.width(6.dp))
        }
        Text(what, style = TextStyle(color = if (late) colors.error else colors.onSurface, fontSize = 13.sp), maxLines = 1)
    }
}

/**
 * The trip in one line, for a compact widget: "Walk to PGP · D2 4:05 PM", or
 * "D2 4:05 PM · at PGP" there. For a class, when it gets you there instead of
 * the walk, keeping the stop: "D2 4:05 PM from PGP · arrive 4:15 PM".
 */
private fun oneLine(answer: NextAnswer, journey: Journey): String {
    val bus = "${journey.bus.svc} ${journey.bus.board}"
    return when {
        answer.isClassPlan && journey.arrive != null -> "$bus ${L.s(R.string.journey_from, journey.bus.stop)} · ${L.s(R.string.arrive_at, journey.arrive)}"
        journey.walk != null -> "${L.s(R.string.journey_walk_to, journey.bus.stop)} · $bus"
        else -> "$bus · ${L.s(R.string.journey_at, journey.bus.stop)}"
    }
}
