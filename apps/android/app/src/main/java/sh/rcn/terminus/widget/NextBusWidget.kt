package sh.rcn.terminus.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.ColorFilter
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.compose.runtime.remember
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.currentState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.ui.BrandDark
import sh.rcn.terminus.ui.BrandLight
import sh.rcn.terminus.ui.MainActivity
import java.util.Date

/**
 * Two widgets in the picker. "Next bus" is one glanceable line; "Next bus +
 * places" adds the alternative and one-tap buttons for saved places.
 */
abstract class BaseWidget(private val large: Boolean) : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        provideContent {
            // redrawWidgets() bumps VERSION. Reading the cache keyed on it is
            // what makes a running Glance session pick up a new answer; values
            // read once outside the composition would stay stale.
            val version = currentState(VERSION) ?: 0L
            val snap = remember(version) { Snap(store.paired, store.lastAnswer(), store.lastError, store.liveUpdates) }
            GlanceTheme(colors = BrandColors) {
                Content(snap.paired, snap.last?.first, snap.last?.second, snap.error, snap.live)
            }
        }
    }

    private data class Snap(val paired: Boolean, val last: Pair<NextAnswer, Long>?, val error: String?, val live: Boolean)

    @Composable
    private fun Content(paired: Boolean, answer: NextAnswer?, fetchedAt: Long?, error: String?, live: Boolean) {
        // The live notification keeps the widget current, so no refresh button then.
        val refreshButton = paired && !live
        val ctx = LocalContext.current
        val colors = GlanceTheme.colors
        val muted = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp)
        val tiny = TextStyle(color = colors.onSurfaceVariant, fontSize = 11.sp)
        // Layout follows the real size: a compact widget stretched to two
        // rows gets the full layout rather than one line in a big box.
        val height = LocalSize.current.height
        val large = large || height >= 110.dp
        val roomy = large || height >= 90.dp

        // TalkBack reads the widget as one sentence instead of fragments.
        val spoken = spokenSummary(ctx, paired, answer, fetchedAt, error)
        Box(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(colors.widgetBackground)
                .cornerRadius(20.dp),
            contentAlignment = Alignment.BottomEnd,
        ) {
            Column(
                modifier = GlanceModifier
                    .fillMaxSize()
                    .semantics { contentDescription = spoken }
                    // A compact widget's text runs the full width: keep it clear of the button.
                    .padding(start = 14.dp, end = if (refreshButton && !large) 36.dp else 14.dp, top = if (large) 12.dp else 8.dp, bottom = if (large) 12.dp else 8.dp)
                    .clickable(if (paired) actionRunCallback<RefreshAction>() else actionStartActivity<MainActivity>()),
                verticalAlignment = if (large) Alignment.Top else Alignment.CenterVertically,
            ) {
                when {
                    !paired -> {
                        Text("terminus", style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                        Text(error ?: "Tap to pair this phone", style = muted, maxLines = 2)
                    }
                    answer == null -> {
                        Text(error ?: "Loading…", style = TextStyle(color = colors.onSurface, fontSize = 16.sp))
                        Text("Tap to refresh", style = muted)
                    }
                    answer.arrived -> {
                        // Short: centred in the space above the chips, not stuck to the top.
                        if (large) Spacer(GlanceModifier.defaultWeight())
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Image(
                                provider = ImageProvider(R.drawable.ic_check),
                                contentDescription = null,
                                colorFilter = ColorFilter.tint(colors.primary),
                                modifier = GlanceModifier.size(if (large) 22.dp else 18.dp),
                            )
                            Spacer(GlanceModifier.width(8.dp))
                            Text(answer.label, style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp), maxLines = 1)
                        }
                        Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                        if (large) {
                            Spacer(GlanceModifier.defaultWeight())
                            AskOrChips(ctx, answer)
                            Spacer(GlanceModifier.height(6.dp))
                        }
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer.mode == "rest" || answer.isFree -> {
                        // Outside the user's day: a moon and the next class, no bus.
                        // A day with no classes: the same, without the moon.
                        if (large) Spacer(GlanceModifier.defaultWeight())
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (answer.mode == "rest") {
                                Image(
                                    provider = ImageProvider(R.drawable.ic_moon),
                                    contentDescription = null,
                                    colorFilter = ColorFilter.tint(colors.primary),
                                    modifier = GlanceModifier.size(if (large) 22.dp else 18.dp),
                                )
                                Spacer(GlanceModifier.width(8.dp))
                            }
                            Text(
                                answer.label,
                                style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp),
                                maxLines = 1,
                            )
                        }
                        Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                        if (large) {
                            Spacer(GlanceModifier.defaultWeight())
                            AskOrChips(ctx, answer)
                            Spacer(GlanceModifier.height(6.dp))
                        }
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer.card?.phase == "riding" && answer.card.ride != null -> {
                        // On the bus (phase 6): where you get off and when, the
                        // next stop, and how far along the ride the bus is.
                        val ride = answer.card.ride
                        val now = System.currentTimeMillis()
                        Text(listOfNotNull(answer.phaseText, answer.destLabel).joinToString(" · "), style = muted, maxLines = 1)
                        Text(
                            "Off at ${ride.stops.last()} ${clock(ctx, ride.arriveMs)}",
                            style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 24.sp else 20.sp),
                            maxLines = 1,
                        )
                        Text(if (error == UPDATING) UPDATING else ride.nextText(now), style = muted, maxLines = 1)
                        if (roomy) {
                            Spacer(GlanceModifier.height(6.dp))
                            LinearProgressIndicator(
                                progress = ride.progress(now),
                                modifier = GlanceModifier.fillMaxWidth().height(6.dp).cornerRadius(3.dp),
                                color = colors.primary,
                                backgroundColor = colors.secondaryContainer,
                            )
                        }
                        if (large) {
                            answer.timingText?.let { Text(it, style = TextStyle(color = timingColor(answer.timingStatus, colors), fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1) }
                            Spacer(GlanceModifier.defaultWeight())
                            AskOrChips(ctx, answer)
                            Spacer(GlanceModifier.height(6.dp))
                        }
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer.isClassPlan -> {
                        // A class: when to leave leads, the next bus is the fallback.
                        // After a missed bus the same, headed by what was missed.
                        val now = System.currentTimeMillis()
                        val old = isOld(answer, fetchedAt, now)
                        val fmt = { ms: Long -> clock(ctx, ms) }
                        val missed = answer.card?.takeIf { it.phase == "missed" }?.line?.substringBefore(" · ")
                        Text(
                            listOfNotNull(missed ?: answer.phaseText?.substringBefore(':'), answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · "),
                            style = muted, maxLines = 1,
                        )
                        Text(
                            answer.leaveHeadline(now).orEmpty(),
                            style = TextStyle(
                                color = when {
                                    old -> colors.onSurfaceVariant
                                    answer.leaveLate -> colors.error
                                    else -> colors.onSurface
                                },
                                fontWeight = FontWeight.Bold,
                                fontSize = if (large) 24.sp else 20.sp,
                            ),
                            maxLines = 1,
                        )
                        val line = when {
                            error == UPDATING -> UPDATING
                            old -> "Old times · tap to refresh"
                            error != null && !roomy -> "$error · ${answer.catchLine}"
                            else -> answer.catchLine.orEmpty()
                        }
                        Text(line, style = muted, maxLines = if (large) 2 else 1)
                        if (roomy && !old) answer.goNowLine?.let { Text(it, style = muted, maxLines = 1) }
                        if (large && !old) {
                            if (answer.leaveNote != null) Text(answer.leaveNote, style = tiny, maxLines = 2)
                            // Deliberately shorter than the card's estimate note: one line of widget.
                            else if (answer.leaveEstimated) Text("~ estimated from the usual bus gap", style = tiny, maxLines = 1)
                            else answer.qualityText?.let { Text(it, style = muted, maxLines = 1) }
                        }
                        if (large) {
                            Spacer(GlanceModifier.defaultWeight())
                            AskOrChips(ctx, answer)
                            Spacer(GlanceModifier.height(6.dp))
                        }
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    else -> {
                        val heading = listOfNotNull(
                            answer.phaseText?.substringBefore(':'),
                            answer.destLabel ?: if (answer.mode == "nearby") "Nearby" else null,
                            if (answer.why == "gap-home") "long gap" else null,
                        ).joinToString(" · ")
                        if (heading.isNotEmpty()) Text(heading, style = muted, maxLines = 1)
                        // A clock time stays true until the bus leaves; "4 min"
                        // is wrong a minute later. Once the bus has gone, or the
                        // data is old, dim it and ask for a tap rather than lie.
                        val now = System.currentTimeMillis()
                        val old = isOld(answer, fetchedAt, now)
                        Text(
                            answer.clockLabel { clock(ctx, it) },
                            style = TextStyle(
                                color = if (old) colors.onSurfaceVariant else colors.onSurface,
                                fontWeight = FontWeight.Bold,
                                fontSize = if (large) 24.sp else 20.sp,
                            ),
                            maxLines = 1,
                        )
                        // A compact widget has no footer, so a problem goes on this line.
                        val line = when {
                            error == UPDATING -> UPDATING
                            old -> "Old times · tap to refresh"
                            error != null && !roomy -> "$error · ${answer.detail}"
                            else -> answer.detail
                        }
                        Text(line, style = muted, maxLines = if (large) 2 else 1)
                        // When to set off, where there's room for a line of its own.
                        if (roomy && !old) {
                            answer.leaveText(now)?.let {
                                Text(it, style = TextStyle(color = colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium), maxLines = 1)
                            }
                        }
                        if (large && !old) {
                            // Crowd is already in the detail line; only the data quality is new here.
                            answer.qualityText?.let { Text(it, style = muted, maxLines = 1) }
                            answer.timingText?.let { Text(it, style = TextStyle(color = timingColor(answer.timingStatus, colors), fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1) }
                        }
                        if (large) {
                            Spacer(GlanceModifier.defaultWeight())
                            AskOrChips(ctx, answer)
                            Spacer(GlanceModifier.height(6.dp))
                        }
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                }
            }
            if (refreshButton) RefreshButton()
        }
    }

    /** Bottom right: the whole widget refreshes on a tap too, but this says so. */
    @Composable
    private fun RefreshButton() {
        Box(
            modifier = GlanceModifier
                .size(40.dp)
                .cornerRadius(20.dp)
                .semantics { contentDescription = "Refresh" }
                .clickable(actionRunCallback<RefreshAction>()),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_refresh),
                contentDescription = null,
                colorFilter = ColorFilter.tint(GlanceTheme.colors.onSurfaceVariant),
                modifier = GlanceModifier.size(18.dp),
            )
        }
    }

    /** "Updated 17:14", with any problem in front, where there's room. */
    @Composable
    private fun Footer(ctx: Context, fetchedAt: Long?, error: String?, roomy: Boolean) {
        val stamp = fetchedAt?.let { "Updated ${clock(ctx, it)}" }
        val foot = listOfNotNull(error?.takeIf { it != UPDATING }, stamp).joinToString(" · ")
        if (roomy && foot.isNotEmpty()) Text(foot, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp), maxLines = 1)
    }

    private fun timingColor(status: String?, colors: androidx.glance.color.ColorProviders) = when (status) {
        "late" -> colors.error
        "tight" -> colors.tertiary
        else -> colors.primary
    }

    /**
     * From the bus's departure, the question's buttons ("On it", "Missed it",
     * "Not going") where the chips go; they answer from the widget, like the
     * notification's. Otherwise the saved places.
     */
    @Composable
    private fun AskOrChips(ctx: Context, answer: NextAnswer) {
        val card = answer.card
        val ask = card?.ask
        when {
            ask != null -> Buttons(ctx, ask.question, ask.actions)
            // During a trip (phase 6): the card's own buttons, so the trip can be
            // followed and answered from the home screen ("On the D2", "I'm there").
            card != null && card.phase in sh.rcn.terminus.LiveService.TRIP_PHASES && card.actions.any { it.id != "reset" } ->
                Buttons(ctx, null, card.actions.filter { it.id != "reset" })
            else -> Chips(ctx, answer)
        }
    }

    /** Up to three buttons that send a signal from the widget, like the notification's. */
    @Composable
    private fun Buttons(ctx: Context, question: String?, actions: List<sh.rcn.terminus.CardAction>) {
        val colors = GlanceTheme.colors
        Column {
            if (question != null) {
                Text(question, style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Medium, fontSize = 13.sp), maxLines = 1)
                Spacer(GlanceModifier.height(6.dp))
            }
            Row(modifier = GlanceModifier.fillMaxWidth()) {
                actions.take(3).forEachIndexed { i, a ->
                    if (i > 0) Spacer(GlanceModifier.width(6.dp))
                    val intent = android.content.Intent(ctx, sh.rcn.terminus.SignalReceiver::class.java)
                        .setAction(sh.rcn.terminus.SignalReceiver.ACTION)
                        .putExtra(sh.rcn.terminus.SignalReceiver.EXTRA_KIND, a.id)
                        .putExtra(sh.rcn.terminus.SignalReceiver.EXTRA_TRIP, a.trip)
                    Box(
                        modifier = GlanceModifier
                            .background(if (i == 0) colors.primaryContainer else colors.secondaryContainer)
                            .cornerRadius(14.dp)
                            .padding(horizontal = 14.dp, vertical = 10.dp)
                            .semantics { contentDescription = listOfNotNull(question, a.label).joinToString(" ") }
                            .clickable(androidx.glance.appwidget.action.actionSendBroadcast(intent)),
                    ) {
                        Text(
                            a.label,
                            style = TextStyle(color = if (i == 0) colors.onPrimaryContainer else colors.onSecondaryContainer, fontSize = 13.sp),
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }

    @Composable
    private fun Chips(ctx: Context, answer: NextAnswer) {
        val colors = GlanceTheme.colors
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            val chips = answer.places.take(3).map { it.label to MainActivity.intentFor(ctx, place = it.key) } +
                ("Nearby" to MainActivity.intentFor(ctx, nearby = true))
            chips.forEachIndexed { i, (label, intent) ->
                if (i > 0) Spacer(GlanceModifier.width(6.dp))
                Box(
                    modifier = GlanceModifier
                        .background(colors.secondaryContainer)
                        .cornerRadius(14.dp)
                        .padding(horizontal = 14.dp, vertical = 10.dp)
                        .semantics { contentDescription = "$label: open the app" }
                        .clickable(actionStartActivity(intent)),
                ) {
                    Text(label, style = TextStyle(color = colors.onSecondaryContainer, fontSize = 13.sp), maxLines = 1)
                }
            }
        }
    }
}

/** What the widget says, as a sentence for screen readers. */
fun spokenSummary(ctx: Context, paired: Boolean, answer: NextAnswer?, fetchedAt: Long?, error: String?): String {
    if (!paired) return "terminus. Not paired. Double tap to pair this phone."
    if (answer == null) return "terminus. ${error ?: "Loading"}. Double tap to refresh."
    val old = isOld(answer, fetchedAt, System.currentTimeMillis())
    val ride = answer.card?.ride?.takeIf { answer.card.phase == "riding" }
    if (ride != null) {
        val now = System.currentTimeMillis()
        return listOfNotNull(
            "On the ${ride.svc}" + (answer.destLabel?.let { ", to $it" } ?: ""),
            "Off at ${ride.stops.last()} at ${clock(ctx, ride.arriveMs)}",
            ride.nextText(now).replace(" · ", ", "),
        ).joinToString(". ") + ". Double tap to refresh."
    }
    if (answer.isClassPlan && !old) {
        val fmt = { ms: Long -> clock(ctx, ms) }
        val now = System.currentTimeMillis()
        return listOfNotNull(
            answer.destLabel?.let { "$it, starts ${answer.classAtMs?.let(fmt)}" },
            answer.leaveHeadline(now),
            answer.catchLine?.replace(" · ", ", "),
            answer.goNowLine?.replace(" · ", ", "),
        ).joinToString(". ") + ". Double tap to refresh."
    }
    val parts = listOfNotNull(
        answer.destLabel?.let { "To $it" },
        if (answer.mode == "rest") answer.label else answer.clockLabel { clock(ctx, it) }.replace(" · ", ", leaves "),
        if (old) "These times are old" else answer.detail.replace(" · ", ", "),
        answer.leaveText(System.currentTimeMillis())?.takeIf { !old }?.replace(" · ", ", "),
        answer.timingText?.takeIf { !old },
        error?.takeIf { it != UPDATING },
    )
    return parts.joinToString(". ") + ". Double tap to refresh."
}

/** The app's brand colours, so the widget doesn't take the wallpaper's. */
private val BrandColors = androidx.glance.material3.ColorProviders(light = BrandLight, dark = BrandDark)

class NextBusWidget : BaseWidget(large = false)
class PlacesWidget : BaseWidget(large = true)

private val VERSION = longPreferencesKey("version")

/** Redraws every placed widget of both kinds with the latest cached answer. */
suspend fun redrawWidgets(ctx: Context) {
    val mgr = GlanceAppWidgetManager(ctx)
    for (widget in listOf(NextBusWidget(), PlacesWidget())) {
        for (id in mgr.getGlanceIds(widget.javaClass)) {
            updateAppWidgetState(ctx, id) { it[VERSION] = System.currentTimeMillis() }
            widget.update(ctx, id)
        }
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        // Show that the tap landed before the network answers.
        Store(context).lastError = UPDATING
        redrawWidgets(context)
        Refresher.refresh(context, fast = true)
    }
}

const val UPDATING = "Updating…"

open class BusWidgetReceiver(widget: GlanceAppWidget) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = widget

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresher.schedule(context)
        Refresher.refreshSoon(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Called when the last widget of THIS kind goes. Keep refreshing
        // while a widget of the other kind is still on the home screen.
        if (Refresher.widgetCount(context) == 0) Refresher.widgetsGone(context)
    }
}

class NextBusWidgetReceiver : BusWidgetReceiver(NextBusWidget())
class PlacesWidgetReceiver : BusWidgetReceiver(PlacesWidget())


/**
 * Campus time, in the phone's 12/24-hour style. Class times and "Arrive
 * 09:52" come from the server in Singapore time; a phone set to another
 * zone must not print the bus in a different one beside them.
 */
fun clock(ctx: Context, ms: Long): String =
    android.text.format.DateFormat.getTimeFormat(ctx)
        .apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Singapore") }
        .format(Date(ms))
