package sh.rcn.terminus.widget

import sh.rcn.terminus.ServerClock
import android.content.Context
import android.text.format.DateFormat
import androidx.compose.runtime.Composable
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.action.actionStartService
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Box
import androidx.glance.layout.fillMaxSize
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.PreferencesGlanceStateDefinition
import org.json.JSONObject
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.DayPlan
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
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.ui.eta
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/**
 * Two widgets in the picker, drawn as Now is: the hour's sky over the top
 * with the campus's hills, your stop and your bus on the horizon. "Next bus"
 * is the trip; "Next bus + favourites" adds chips for Nearby and the places
 * you go. Each lays itself out by its size ([WidgetShape]).
 */
abstract class BaseWidget(private val large: Boolean) : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        // SizeMode.Exact composes once per size: what's read and parsed is
        // shared between them, made again only when it changes.
        val snaps = Latest<Long, Snap>()
        val modes = Latest<ModeState, ModeState>()
        provideContent {
            // redrawWidgets() bumps VERSION. Reading the cache keyed on it is
            // what makes a running Glance session pick up a new answer; values
            // read once outside the composition would stay stale.
            val version = currentState(VERSION) ?: 0L
            val snap = snaps.get(version) { Snap(store) }
            // This widget's own choice: the timetable, Nearby or a place.
            val state = ModeState(
                Mode.of(currentState(WidgetModes.MODE), currentState(WidgetModes.MODE_LABEL)),
                currentState(WidgetModes.MODE_AT),
                currentState(WidgetModes.MODE_JSON),
                currentState(WidgetModes.MODE_FETCHED),
                currentState(WidgetModes.MODE_ERROR),
                currentState(NearbySwap.FROM)?.let { from ->
                    NearbySwap.Swap(from, currentState(NearbySwap.TO) ?: "", currentState(NearbySwap.AT) ?: 0L)
                },
            )
            val chosen = modes.get(state) { state }
            Content(snap, chosen, appWidgetId)
        }
    }

    /** The value made for the last key, made again for a new one. */
    private class Latest<K, V : Any> {
        private var key: K? = null
        private var value: V? = null

        fun get(k: K, make: () -> V): V = value?.takeIf { key == k } ?: make().also { key = k; value = it }
    }

    /** What the widget shows from the app, read again on each redraw (and only then, so it's all in here). */
    private class Snap(store: Store) {
        val paired = store.paired
        val last = store.lastAnswer()
        val error = store.lastError
        val live = store.liveUpdates
        val added = store.addedPlaces
        /** Read only when they're shown. */
        val day by lazy { store.lastDay()?.first }
        val uses by lazy { store.destinationUses() }
    }

    private data class ModeState(val mode: Mode, val at: Long?, val json: String?, val fetchedAt: Long?, val error: String?, val swap: NearbySwap.Swap? = null) {
        /** Nearby's stops in the API's order (nearest first); null before any, or when they can't be read. */
        val nearbyStops: List<NearbyStop>? by lazy { json?.takeIf { mode == Mode.Nearby }?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() } }

        /** A place's answer; null before any, or when it can't be read. */
        val answer: NextAnswer? by lazy { json?.takeIf { mode is Mode.To }?.let { runCatching { NextAnswer.parse(JSONObject(it)) }.getOrNull() } }

        /** Nearby's stops as shown: the API's order, or the twin first after a swap. */
        fun nearby(now: Long): List<NearbyStop>? = nearbyStops?.let { NearbySwap.order(it, swap, now) }
    }

    @Composable
    private fun Content(snap: Snap, chosen: ModeState, appWidgetId: Int) {
        val ctx = LocalContext.current
        val paired = snap.paired
        val plan = snap.last?.first
        val size = LocalSize.current
        val w = size.width.value
        val h = size.height.value
        // Layout follows the real size: a widget stretched to more rows gets
        // the layout for them, whichever of the two it was added as.
        val shape = WidgetShape.of(w, h)
        val look = WidgetLook.now(ctx)

        // Chips for Timetable, Nearby and the usual places, as many as fit: on
        // the favourites widget, and on any big enough for your day. None on a
        // small one, which then always shows the timetable.
        val now0 = System.currentTimeMillis()
        val chipsWanted = paired && shape.roomy && (large || shape == WidgetShape.DAY)
        // The big widget's chips share their row with ↻.
        val chipsWidth = w - 28f - if (shape == WidgetShape.DAY) 44f else 0f
        val chips = if (chipsWanted) WidgetModes.chips(snap.uses, plan?.places.orEmpty(), snap.added, chipsWidth, now0) else emptyList()
        val mode = WidgetModes.effective(chosen.mode, chosen.at, plan, chips.isNotEmpty(), now0)
        val onTimetable = mode == Mode.Timetable
        // What's shown: the plan, or this widget's own answer for a place.
        val answer = when (mode) {
            Mode.Timetable -> plan
            is Mode.To -> chosen.answer
            Mode.Nearby -> null
        }
        val error = if (onTimetable) snap.error else chosen.error
        // The day plan read once with the rest of this redraw (snap), only used offline.
        val frame = frame(paired, mode, answer, error, snap.live, ServerClock.now()) { snap.day }
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
        val face = Face.of(paired, mode, answer, error, frame.offline, ServerClock.now()) { clock(ctx, it) }
        val scene = Scene(
            look = look,
            face = face,
            answer = answer,
            refresh = refresh.takeIf { frame.refreshButton },
            chips = chips,
            showing = mode,
            chipAction = { chipAction(ctx, it, appWidgetId) },
            day = { snap.day },
            style = CardStyle.pref(ctx),
        )

        // TalkBack reads the widget as one sentence instead of fragments.
        val spoken = when {
            mode == Mode.Nearby -> nearbySpoken(chosen)
            frame.offline != null -> OfflineDay.lines(frame.offline) { clock(ctx, it) }.let { Spoken.sentences(L.s(R.string.offline), it.head, it.big, it.how) }
            else -> spokenSummary(ctx, paired, answer, error)
        }
        Box(
            modifier = GlanceModifier
                .fillMaxSize()
                .appWidgetBackground()
                .background(look.pageColor)
                .cornerRadius(android.R.dimen.system_app_widget_background_radius)
                .semantics { contentDescription = spoken }
                .clickable(tap),
        ) {
            when {
                mode == Mode.Nearby -> {
                    val now = System.currentTimeMillis()
                    BoardLayout(scene, w, h, chosen.nearby(now), chosen.nearbyStops, chosen.swap, chosen.fetchedAt, chosen.error, chosen.json)
                }
                shape == WidgetShape.BAR -> BarLayout(scene, w, h)
                shape == WidgetShape.SQUARE -> SquareLayout(scene, w, h)
                shape == WidgetShape.DAY -> DayLayout(scene, w, h)
                else -> TripLayout(scene, w, h)
            }
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
            // A tap's broadcast has seconds: the rest of a refresh follows in a job.
            Refresher.refresh(context, fast = true, extras = false)
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
