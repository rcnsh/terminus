package sh.rcn.terminus.widget

import sh.rcn.terminus.ServerClock
import android.content.Context
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.action.actionStartService
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.color.ColorProviders
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
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
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import org.json.JSONObject
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.L
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.ui.BrandDark
import sh.rcn.terminus.ui.BrandLight
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.ui.eta
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/**
 * Two widgets in the picker. "Next bus" is one glanceable line; "Next bus +
 * places" adds the alternative and one-tap buttons for saved places.
 */
abstract class BaseWidget(private val large: Boolean) : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        provideContent {
            // redrawWidgets() bumps VERSION. Reading the cache keyed on it is
            // what makes a running Glance session pick up a new answer; values
            // read once outside the composition would stay stale.
            val version = currentState(VERSION) ?: 0L
            val snap = remember(version) { Snap(store.paired, store.lastAnswer(), store.lastError, store.liveUpdates, store.addedPlaces) }
            // This widget's own choice (phase 8.3): the timetable, Nearby or a place.
            val chosen = ModeState(
                Mode.of(currentState(WidgetModes.MODE), currentState(WidgetModes.MODE_LABEL)),
                currentState(WidgetModes.MODE_AT),
                currentState(WidgetModes.MODE_JSON),
                currentState(WidgetModes.MODE_FETCHED),
                currentState(WidgetModes.MODE_ERROR),
                currentState(NearbySwap.FROM)?.let { from ->
                    NearbySwap.Swap(from, currentState(NearbySwap.TO) ?: "", currentState(NearbySwap.AT) ?: 0L)
                },
            )
            GlanceTheme(colors = BrandColors) {
                Content(snap.paired, snap.last?.first, snap.last?.second, snap.error, snap.live, snap.added, chosen, store, appWidgetId)
            }
        }
    }

    /** What the widget shows from the app, read again on each redraw (and only then, so it's all in here). */
    private data class Snap(val paired: Boolean, val last: Pair<NextAnswer, Long>?, val error: String?, val live: Boolean, val added: List<Destinations.Dest>)

    private data class ModeState(val mode: Mode, val at: Long?, val json: String?, val fetchedAt: Long?, val error: String?, val swap: NearbySwap.Swap? = null) {
        /** Nearby's stops in the API's order (nearest first); null before any, or when they can't be read. */
        fun nearbyStops(): List<NearbyStop>? = json?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() }

        /** Nearby's stops as shown: the API's order, or the twin first after a swap. */
        fun nearby(now: Long): List<NearbyStop>? = nearbyStops()?.let { NearbySwap.order(it, swap, now) }
    }

    /** The row of buttons, worked out once for the layout. */
    private data class Bottom(val chips: List<Mode>, val mode: Mode, val appWidgetId: Int)

    @Composable
    private fun Content(paired: Boolean, plan: NextAnswer?, planAt: Long?, planError: String?, live: Boolean, added: List<Destinations.Dest>, chosen: ModeState, store: Store, appWidgetId: Int) {
        val ctx = LocalContext.current
        val colors = GlanceTheme.colors
        val muted = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp)
        val tiny = TextStyle(color = colors.onSurfaceVariant, fontSize = 11.sp)
        // Layout follows the real size: a compact widget stretched to two
        // rows gets the full layout rather than one line in a big box.
        val height = LocalSize.current.height
        val large = large || height >= 110.dp
        val roomy = large || height >= 90.dp

        // Buttons for Timetable, Nearby and the usual places, as many as fit;
        // none on a compact widget, which then always shows the timetable.
        val now0 = System.currentTimeMillis()
        val chips = if (large && paired) WidgetModes.chips(store, plan?.places.orEmpty(), added, LocalSize.current.width.value - 28f, now0) else emptyList()
        val mode = WidgetModes.effective(chosen.mode, chosen.at, plan, chips.isNotEmpty(), now0)
        val bottom = Bottom(chips, mode, appWidgetId)
        val onTimetable = mode == Mode.Timetable
        // What's shown: the plan, or this widget's own answer for a place.
        val answer = when (mode) {
            Mode.Timetable -> plan
            is Mode.To -> chosen.json?.let { runCatching { NextAnswer.parse(JSONObject(it)) }.getOrNull() }
            Mode.Nearby -> null
        }
        val fetchedAt = if (onTimetable) planAt else chosen.fetchedAt
        val error = if (onTimetable) planError else chosen.error
        val frame = frame(paired, mode, answer, error, live, ServerClock.now()) { store.lastDay()?.first }
        val offline = frame.offline
        val refreshButton = frame.refreshButton
        // ↻ refreshes what it shows (a place with a new location fix); a tap
        // anywhere else on the widget opens the app on the same view.
        val refresh = if (onTimetable) actionRunCallback<RefreshAction>() else chipAction(ctx, mode, appWidgetId)
        val tap = actionStartActivity(
            when (val t = frame.tap) {
                Tap.Plan -> MainActivity.intentFor(ctx)
                Tap.Nearby -> MainActivity.intentFor(ctx, nearby = true)
                is Tap.Place -> MainActivity.intentFor(ctx, place = t.key)
                is Tap.Stop -> MainActivity.intentFor(ctx, to = t.code, label = t.label)
            },
        )

        // TalkBack reads the widget as one sentence instead of fragments.
        val spoken = when {
            mode == Mode.Nearby -> nearbySpoken(chosen)
            offline != null -> OfflineDay.lines(offline) { clock(ctx, it) }.let { Spoken.sentences(L.s(R.string.offline), it.head, it.big, it.how) }
            else -> spokenSummary(ctx, paired, answer, error)
        }
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
                    .padding(start = 14.dp, end = if (refreshButton && !large) 44.dp else 14.dp, top = if (large) 12.dp else 8.dp, bottom = if (large) 12.dp else 8.dp)
                    .clickable(tap),
                verticalAlignment = if (large) Alignment.Top else Alignment.CenterVertically,
            ) {
                when {
                    !paired -> {
                        Text("terminus", style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                        Text(error ?: L.s(R.string.tap_to_pair), style = muted, maxLines = 2)
                    }
                    mode == Mode.Nearby -> {
                        NearbyBody(chosen, large)
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, chosen.fetchedAt, chosen.error, roomy)
                    }
                    offline != null -> {
                        val lines = OfflineDay.lines(offline) { clock(ctx, it) }
                        // A roomy widget's footer already says Offline; a compact one has no footer.
                        Text(if (roomy) lines.head else "${L.s(R.string.offline)} · ${lines.head}", style = muted, maxLines = 1)
                        Text(lines.big, style = headStyle(colors.onSurface, large), maxLines = headLines())
                        lines.how?.let { Text(it, style = muted, maxLines = 1) }
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer == null -> {
                        Text(if (onTimetable) error ?: L.s(R.string.loading) else "${mode.label} · ${error ?: L.s(R.string.loading)}", style = TextStyle(color = colors.onSurface, fontSize = 16.sp))
                        Text(L.s(R.string.tap_to_refresh), style = muted)
                        ButtonRow(ctx, bottom, large, gap = false)
                    }
                    answer.arrived || answer.mode == "rest" || answer.isFree -> {
                        // There: a tick. Outside the user's day: a moon and the next
                        // class, no bus. A day with no classes: the same, without the moon.
                        val icon = when {
                            answer.arrived -> R.drawable.ic_check
                            answer.mode == "rest" -> R.drawable.ic_moon
                            else -> null
                        }
                        // Short: centred in the space above the chips, not stuck to the top.
                        if (large) Spacer(GlanceModifier.defaultWeight())
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            if (icon != null) {
                                Image(
                                    provider = ImageProvider(icon),
                                    contentDescription = null,
                                    colorFilter = ColorFilter.tint(colors.primary),
                                    modifier = GlanceModifier.size(if (large) 22.dp else 18.dp),
                                )
                                Spacer(GlanceModifier.width(8.dp))
                            }
                            Text(answer.label, style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp), maxLines = headLines())
                        }
                        Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer.card?.phase == "riding" && answer.card.ride != null -> {
                        // On the bus (phase 6): where you get off and when, the
                        // next stop, and how far along the ride the bus is.
                        val ride = answer.card.ride
                        val now = ServerClock.now()
                        Text(listOfNotNull(answer.phaseText, answer.destLabel).joinToString(" · "), style = muted, maxLines = 1)
                        Text(
                            L.s(R.string.off_at_time, ride.stops.last(), clock(ctx, ride.arriveMs)),
                            style = headStyle(colors.onSurface, large),
                            maxLines = headLines(),
                        )
                        Text(if (error == UPDATING) L.s(R.string.updating) else ride.nextText(now), style = muted, maxLines = 1)
                        if (roomy) {
                            Spacer(GlanceModifier.height(6.dp))
                            LinearProgressIndicator(
                                progress = ride.progress(now),
                                modifier = GlanceModifier.fillMaxWidth().height(6.dp).cornerRadius(3.dp),
                                color = colors.primary,
                                backgroundColor = colors.secondaryContainer,
                            )
                        }
                        if (large) answer.timingText?.let { Text(it, style = TextStyle(color = timingColor(answer.timingStatus, colors), fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1) }
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, fetchedAt, error, roomy)
                    }
                    answer.card?.journey != null && !isOld(answer, ServerClock.now()) -> {
                        // A trip by bus or on foot, in the card style chosen in Settings › Appearance.
                        // Old times fall through to the layouts below, which dim them.
                        // A refresh keeps this layout, with "Updating…" on the head
                        // line (compact) or in the footer: switching layouts for a
                        // second after a tap on ↻ looked like the widget breaking.
                        val note = error?.takeIf { !roomy }?.let { if (it == UPDATING) L.s(R.string.updating) else it }
                        WidgetJourney(answer, answer.card.journey, CardStyle.pref(ctx), large, roomy, note)
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, fetchedAt, error, roomy, updating = true)
                    }
                    answer.isClassPlan -> {
                        // A class: when to leave leads, the next bus is the fallback.
                        // After a missed bus the same, headed by what was missed.
                        val now = ServerClock.now()
                        val old = isOld(answer, now)
                        val fmt = { ms: Long -> clock(ctx, ms) }
                        // The trip's phase as the server words it ("On your way", "Missed it. Here's the next way there."), whole.
                        Text(
                            listOfNotNull(answer.phaseText, answer.destLabel, answer.classAtMs?.let { L.s(R.string.starts_at, fmt(it)) }).joinToString(" · "),
                            style = muted, maxLines = 1,
                        )
                        Text(
                            answer.leaveHeadline(now).orEmpty(),
                            style = headStyle(
                                when {
                                    old -> colors.onSurfaceVariant
                                    answer.leaveLate -> colors.error
                                    else -> colors.onSurface
                                },
                                large,
                            ),
                            maxLines = headLines(),
                        )
                        val line = when {
                            error == UPDATING -> L.s(R.string.updating)
                            old -> L.s(R.string.old_times)
                            error != null && !roomy -> "$error · ${answer.catchLine}"
                            else -> answer.catchLine.orEmpty()
                        }
                        Text(line, style = muted, maxLines = if (large) 2 else 1)
                        if (roomy && !old) answer.goNowLine?.let { Text(it, style = muted, maxLines = 1) }
                        if (large && !old) {
                            if (answer.leaveNote != null) Text(answer.leaveNote, style = tiny, maxLines = 2)
                            // Deliberately shorter than the card's estimate note: one line of widget.
                            else if (answer.leaveEstimated) Text(L.s(R.string.estimated_gap), style = tiny, maxLines = 1)
                            else answer.qualityText?.let { Text(it, style = muted, maxLines = 1) }
                        }
                        ButtonRow(ctx, bottom, large)
                        // Smaller, no line of its own: the data quality goes in the footer.
                        Footer(ctx, fetchedAt, error, roomy, note = answer.qualityText.takeIf { !large && !old })
                    }
                    else -> {
                        val heading = listOfNotNull(
                            answer.phaseText,
                            answer.card?.heading ?: localHeading(answer),
                        ).joinToString(" · ")
                        if (heading.isNotEmpty()) Text(heading, style = muted, maxLines = 1)
                        // A clock time stays true until the bus leaves; "4 min"
                        // is wrong a minute later. Once the bus has gone, or the
                        // data is old, dim it and ask for a tap rather than lie.
                        val now = ServerClock.now()
                        val old = isOld(answer, now)
                        Text(
                            answer.clockLabel { clock(ctx, it) },
                            style = headStyle(if (old) colors.onSurfaceVariant else colors.onSurface, large),
                            maxLines = headLines(),
                        )
                        // A compact widget has no footer, so a problem goes on this line.
                        val line = when {
                            error == UPDATING -> L.s(R.string.updating)
                            old -> L.s(R.string.old_times)
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
                        ButtonRow(ctx, bottom, large)
                        Footer(ctx, fetchedAt, error, roomy, note = answer.qualityText.takeIf { !large && !old })
                    }
                }
            }
            if (refreshButton) RefreshButton(refresh)
        }
    }

    /** Bottom right: refreshes what the widget shows (a tap elsewhere opens the app). */
    @Composable
    private fun RefreshButton(action: Action) {
        Box(
            modifier = GlanceModifier
                // 48 dp: a fingertip, though the icon is small.
                .size(48.dp)
                .cornerRadius(24.dp)
                .semantics { contentDescription = L.s(R.string.refresh) }
                .clickable(action),
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

    /**
     * "Updated 17:14", with any problem in front, where there's room.
     * [updating]: say "Updating…" here; the other layouts say it on a line of their own.
     * [note]: the data quality ("Timetable estimate"), on a widget with no line for it.
     */
    @Composable
    private fun Footer(ctx: Context, fetchedAt: Long?, error: String?, roomy: Boolean, updating: Boolean = false, note: String? = null) {
        val stamp = fetchedAt?.let { L.s(R.string.updated_at, clock(ctx, it)) }
        val problem = error?.let { if (it == UPDATING) L.s(R.string.updating).takeIf { updating } else it }
        val foot = listOfNotNull(problem, note, stamp).joinToString(" · ")
        if (roomy && foot.isNotEmpty()) Text(foot, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp), maxLines = 1)
    }

    private fun timingColor(status: String?, colors: ColorProviders) = when (status) {
        "late" -> colors.error
        "tight" -> colors.tertiary
        else -> colors.primary
    }

    /**
     * The bottom of a large widget: the row that switches what it shows
     * (phase 8.3), pushed to the foot, then (with [gap]) a little room above
     * the footer. Nothing here asks what happened on the trip. None on a
     * compact widget.
     */
    @Composable
    private fun ColumnScope.ButtonRow(ctx: Context, b: Bottom, large: Boolean, gap: Boolean = true) {
        if (!large) return
        Spacer(GlanceModifier.defaultWeight())
        if (b.chips.isNotEmpty()) ModeChips(ctx, b)
        if (gap) Spacer(GlanceModifier.height(6.dp))
    }

    /** The widget's big line (when to leave, the bus's time, where you get off), in [color]. */
    private fun headStyle(color: ColorProvider, large: Boolean) = TextStyle(color = color, fontWeight = FontWeight.Bold, fontSize = if (large) 24.sp else 20.sp)

    /**
     * Timetable, Nearby, then the places you usually go: each switches this
     * widget in place, without opening the app. The one showing is filled.
     */
    @Composable
    private fun ModeChips(ctx: Context, b: Bottom) {
        val colors = GlanceTheme.colors
        // Gaps as padding, not Spacers: a Glance Row holds at most 10 children,
        // and a wide widget fits six buttons.
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            b.chips.forEachIndexed { i, m ->
                val on = m.id == b.mode.id
                Box(modifier = GlanceModifier.padding(start = if (i > 0) 6.dp else 0.dp)) {
                    Box(
                        modifier = GlanceModifier
                            .background(if (on) colors.primaryContainer else colors.secondaryContainer)
                            .cornerRadius(14.dp)
                            // Tall enough for a fingertip (48 dp with the text).
                            .padding(horizontal = 14.dp, vertical = 14.dp)
                            .semantics { contentDescription = if (on) L.s(R.string.mode_showing, m.label) else L.s(R.string.mode_show, m.label) }
                            .clickable(chipAction(ctx, m, b.appWidgetId)),
                    ) {
                        Text(m.label, style = TextStyle(color = if (on) colors.onPrimaryContainer else colors.onSecondaryContainer, fontSize = 13.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal), maxLines = 1)
                    }
                }
            }
        }
    }

    /** Nearby: the nearest stop's next buses, then the next stop's, counted down from when they were fetched. */
    @Composable
    private fun NearbyBody(chosen: ModeState, large: Boolean) {
        val colors = GlanceTheme.colors
        val muted = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp)
        val now = System.currentTimeMillis()
        val api = chosen.nearbyStops()
        val stops = api?.let { NearbySwap.order(it, chosen.swap, now) }
        val age = chosen.fetchedAt?.let { (now - it) / 1000 } ?: 0L
        val old = age > NEARBY_OLD_S
        val first = stops?.firstOrNull()
        if (first == null) {
            Text(L.s(R.string.chip_nearby), style = muted, maxLines = 1)
            Text(if (chosen.error == UPDATING || chosen.json == null) L.s(R.string.checking) else chosen.error ?: L.s(R.string.no_stops_near), style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp), maxLines = headLines())
            return
        }
        val walk = if (first.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (first.walkS + 30) / 60)
        // The next stops, a line each where there's room, when their times are fresh.
        val next = if (chosen.error == UPDATING || old) emptyList() else stops.drop(1).take(if (large) 2 else 1).filter { departures(it, age, 3).isNotEmpty() }
        val others = next.map { L.s(R.string.stop_departures, it.name, departures(it, age, 3)) }
        // The other side of the road, a tap away, unless it's one of the stops shown.
        val other = NearbySwap.offer(api.orEmpty(), chosen.swap, now, (listOf(first) + next).map { it.code })
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(L.s(R.string.nearby_line, first.name, walk), style = muted, maxLines = headLines(), modifier = GlanceModifier.defaultWeight())
            if (other != null) SwapButton(other, api.first().code)
        }
        Text(
            departures(first, age, 2).ifEmpty { if (first.available) L.s(R.string.no_buses_due) else L.s(R.string.no_live_data) },
            style = headStyle(if (old) colors.onSurfaceVariant else colors.onSurface, large),
            maxLines = headLines(),
        )
        val lines = when {
            chosen.error == UPDATING -> listOf(L.s(R.string.updating))
            old -> listOf(L.s(R.string.old_times))
            // The rest of this stop's buses, then the next stops, a line each where there's room.
            large -> listOfNotNull(departures(first, age, 4, skip = 2).takeIf { it.isNotEmpty() }) + others
            else -> listOf((listOfNotNull(departures(first, age, 4, skip = 2).takeIf { it.isNotEmpty() }) + others).joinToString(" · "))
        }.filter { it.isNotEmpty() }
        lines.forEach { Text(it, style = muted, maxLines = 1) }
    }

    /** Shows the stop across the road first, or the nearest one again. */
    @Composable
    private fun SwapButton(other: NearbyStop, nearest: String) {
        Box(
            modifier = GlanceModifier
                .size(48.dp)
                .cornerRadius(24.dp)
                .semantics { contentDescription = L.s(R.string.nearby_swap, other.name) }
                .clickable(
                    actionRunCallback<SwapAction>(
                        actionParametersOf(SwapAction.FROM to nearest, SwapAction.TO to other.code),
                    ),
                ),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                provider = ImageProvider(R.drawable.ic_swap),
                contentDescription = null,
                colorFilter = ColorFilter.tint(GlanceTheme.colors.onSurfaceVariant),
                modifier = GlanceModifier.size(18.dp),
            )
        }
    }

    /** Where a tap on the widget opens the app: the view it shows. */
    sealed interface Tap {
        data object Plan : Tap
        data object Nearby : Tap
        data class Place(val key: String) : Tap
        data class Stop(val code: String, val label: String) : Tap
    }

    /**
     * The widget's frame, whatever its body: [offline] (the day plan's next
     * thing, shown instead of the answer), whether there's a refresh
     * button, and where a tap goes.
     */
    data class Frame(val offline: OfflineDay.Pick?, val refreshButton: Boolean, val tap: Tap)

    companion object {
        /**
         * [Frame] for the [mode] shown, with its [answer] and last [error];
         * [day] is read only when it's needed. [now] is on the server's clock.
         */
        fun frame(paired: Boolean, mode: Mode, answer: NextAnswer?, error: String?, live: Boolean, now: Long, day: () -> DayPlan?): Frame {
            val onTimetable = mode == Mode.Timetable
            // Offline (the last refresh failed) with the plan gone stale, or none
            // kept: the next thing on the day plan kept for it.
            val offline = if (onTimetable && paired && error != null && error != UPDATING && (answer == null || isOld(answer, now))) OfflineDay.next(day(), now) else null
            // The live notification keeps the plan current, so no refresh button then.
            val refreshButton = paired && (!live || !onTimetable)
            val tap = when (mode) {
                Mode.Timetable -> Tap.Plan
                Mode.Nearby -> Tap.Nearby
                is Mode.To -> (mode.target as? Target.SavedPlace)?.let { Tap.Place(it.key) } ?: Tap.Stop(mode.dest.id.removePrefix("stop:"), mode.label)
            }
            return Frame(offline, refreshButton, tap)
        }

        /** Nearby's countdowns are guesses past this. */
        private const val NEARBY_OLD_S = 180L

        /** The server's own words for a time are kept while they're this fresh; then the widget counts down itself. */
        private const val SERVER_ETA_S = 30L

        /** "D2 3 min · A1 7 min": the server's words while fresh, then counted down by `ageS`. */
        fun departures(s: NearbyStop, ageS: Long, n: Int, skip: Int = 0): String =
            s.board.filter { it.etaS != null }.drop(skip).take(n).joinToString(" · ") { r ->
                val left = (r.etaS!! - ageS).toInt()
                "${r.svc} ${r.eta?.takeIf { ageS < SERVER_ETA_S } ?: eta(left.coerceAtLeast(0), r.quality)}"
            }
    }

    /** Nearby, as a sentence for screen readers. */
    private fun nearbySpoken(chosen: ModeState): String {
        val stops = chosen.nearby(System.currentTimeMillis())
        val first = stops?.firstOrNull() ?: return L.s(R.string.a11y_nearby_none, chosen.error ?: L.s(R.string.a11y_checking))
        val age = chosen.fetchedAt?.let { (System.currentTimeMillis() - it) / 1000 } ?: 0L
        val due = departures(first, age, 3).replace(" · ", L.s(R.string.clause_sep)).ifEmpty { L.s(R.string.a11y_no_buses) }
        return L.s(R.string.a11y_nearby, first.name, Spoken.spell(due))
    }
}

/** A widget button: Timetable at once; Nearby and places through a location fix when location is allowed. */
internal fun chipAction(ctx: Context, mode: Mode, appWidgetId: Int): Action =
    if (mode != Mode.Timetable && Locator.hasForeground(ctx)) {
        actionStartService(WidgetModeService.intent(ctx, appWidgetId, mode), isForegroundService = true)
    } else {
        actionRunCallback<ModeAction>(
            actionParametersOf(ModeAction.MODE_ID to mode.id, ModeAction.MODE_LABEL_PARAM to mode.label),
        )
    }

/** What the widget says, as sentences for screen readers ([Spoken.summary]). */
fun spokenSummary(ctx: Context, paired: Boolean, answer: NextAnswer?, error: String?): String =
    Spoken.summary(paired, answer, error, ServerClock.now()) { clock(ctx, it) }

/** The app's brand colours, so the widget doesn't take the wallpaper's. */
private val BrandColors = androidx.glance.material3.ColorProviders(light = BrandLight, dark = BrandDark)

class NextBusWidget : BaseWidget(large = false)
class PlacesWidget : BaseWidget(large = true)

private val VERSION = longPreferencesKey("version")

/**
 * Signing out: each widget forgets the place or Nearby list it was showing
 * (WidgetModes) and the stops it was swapping between (NearbySwap), which
 * were the old account's, and is drawn again.
 */
suspend fun forgetWidgets(ctx: Context) {
    val mgr = GlanceAppWidgetManager(ctx)
    for (widget in listOf(NextBusWidget(), PlacesWidget())) {
        for (id in mgr.getGlanceIds(widget.javaClass)) updateAppWidgetState(ctx, id) { WidgetModes.forget(it) }
    }
    redrawWidgets(ctx)
}

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
        val store = Store(context)
        store.lastError = UPDATING
        redrawWidgets(context)
        try {
            Refresher.refresh(context, fast = true)
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Stopped before an answer: "Updating…" mustn't stay, nor keep
            // the widget from its offline day plan.
            withContext(NonCancellable) {
                if (store.lastError == UPDATING) store.lastError = null
                redrawWidgets(context)
            }
            throw e
        }
    }
}

/** Stored as the error while an update is under way; shown as R.string.updating. */
const val UPDATING = "Updating…"

/** The line above the headline from an older server, without `card.heading`: where to, and a long gap. */
private fun localHeading(answer: NextAnswer): String? = listOfNotNull(
    answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null,
    if (answer.why == "gap-home") L.s(R.string.long_gap_short) else null,
).joinToString(" · ").ifEmpty { null }

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
fun clock(ctx: Context, ms: Long): String {
    // In the account's 12- or 24-hour style, as the server writes the card.
    val locale = ctx.resources.configuration.locales[0]
    val pattern = DateFormat.getBestDateTimePattern(locale, if (hour12(ctx)) "hmm" else "HHmm")
    return SimpleDateFormat(pattern, locale)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Singapore") }
        .format(Date(ms))
        // "下午 6:36", with the space the server's Chinese has.
        .replace(Regex("([上下]午)(\\d)"), "$1 $2")
}
