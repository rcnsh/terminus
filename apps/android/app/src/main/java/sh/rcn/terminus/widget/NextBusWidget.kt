package sh.rcn.terminus.widget

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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.TimeZone
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.json.JSONObject
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.L
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.ui.eta

abstract class BaseWidget(private val large: Boolean) : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val snaps = Latest<Long, Snap>()
        val modes = Latest<ModeState, ModeState>()
        provideContent {
            val version = currentState(VERSION) ?: 0L
            val snap = snaps.get(version) { Snap(store) }
            val state =
                ModeState(
                    Mode.of(currentState(WidgetModes.MODE), currentState(WidgetModes.MODE_LABEL)),
                    currentState(WidgetModes.MODE_AT),
                    currentState(WidgetModes.MODE_JSON),
                    currentState(WidgetModes.MODE_FETCHED),
                    currentState(WidgetModes.MODE_ERROR),
                    currentState(NearbySwap.FROM)?.let { from ->
                        NearbySwap.Swap(from, currentState(NearbySwap.TO) ?: "", currentState(NearbySwap.AT) ?: 0L)
                    },
                    currentState(NEARBY_PAGE) ?: 0,
                )
            val chosen = modes.get(state) { state }
            Content(snap, chosen, appWidgetId)
        }
    }

    private class Snap(store: Store) {
        val paired = store.paired
        val last = store.lastAnswer()
        val error = store.lastError
        val live = store.liveUpdates
        val added = store.addedPlaces
        val day by lazy { store.lastDay()?.first }
        val nearbyAt = store.nearbyFetchedAt.takeIf { it > 0L }
        val nearbyStops by lazy { store.nearbyJson?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() } }
        val uses by lazy { store.destinationUses() }
    }

    private data class ModeState(
        val mode: Mode,
        val at: Long?,
        val json: String?,
        val fetchedAt: Long?,
        val error: String?,
        val swap: NearbySwap.Swap? = null,
        val page: Int = 0,
    ) {
        val nearbyStops: List<NearbyStop>? by lazy {
            json?.takeIf { mode == Mode.Nearby }?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() }
        }

        val answer: NextAnswer? by lazy {
            json?.takeIf { mode is Mode.To }?.let { runCatching { NextAnswer.parse(JSONObject(it)) }.getOrNull() }
        }
    }

    @Composable
    private fun Content(snap: Snap, chosen: ModeState, appWidgetId: Int) {
        val ctx = LocalContext.current
        val paired = snap.paired
        val plan = snap.last?.first
        val size = LocalSize.current
        val w = size.width.value
        val h = size.height.value
        val shape = WidgetShape.of(w, h)
        val look = WidgetLook.now(ctx)

        val now0 = System.currentTimeMillis()
        val chipsWanted = paired && WidgetModes.rowWanted(shape, large)
        val chipsWidth = WidgetModes.rowWidth(w, shape)
        val chips = if (chipsWanted) WidgetModes.chips(snap.uses, plan?.places.orEmpty(), snap.added, chipsWidth, now0) else emptyList()
        val mode = WidgetModes.effective(chosen.mode, chosen.at, plan, chips.isNotEmpty(), now0, ServerClock::toDevice)
        val onTimetable = mode == Mode.Timetable
        val answer =
            when (mode) {
                Mode.Timetable -> plan
                is Mode.To -> chosen.answer
                Mode.Nearby -> null
            }
        val error = if (onTimetable) snap.error else chosen.error
        val frame = frame(paired, mode, answer, error, snap.live, ServerClock.now()) { snap.day }
        val refresh = if (onTimetable) actionRunCallback<RefreshAction>() else chipAction(ctx, mode, appWidgetId)
        val tap =
            actionStartActivity(
                when (val t = frame.tap) {
                    Tap.Plan -> MainActivity.intentFor(ctx)
                    Tap.Nearby -> MainActivity.intentFor(ctx, nearby = true)
                    is Tap.Place -> MainActivity.intentFor(ctx, place = t.key)
                    is Tap.Stop -> MainActivity.intentFor(ctx, to = t.code, label = t.label)
                }
            )
        val face = Face.of(paired, mode, answer, error, frame.offline, ServerClock.now()) { clock(ctx, it) }
        val scene =
            Scene(
                look = look,
                face = face,
                answer = answer,
                refresh = refresh.takeIf { frame.refreshButton },
                chips = chips,
                showing = mode,
                chipAction = { chipAction(ctx, it, appWidgetId) },
                day = { snap.day },
                style = CardStyle.pref(ctx),
                nearby = {
                    snap.nearbyAt
                        ?.takeIf { now0 - it in 0..WidgetModes.KEEP_MS }
                        ?.let { at ->
                            NearbyView.of(paired, snap.nearbyStops, chosen.swap, at, null, 0, now0)
                        }
                },
            )

        val spoken =
            when {
                mode == Mode.Nearby ->
                    nearbySpoken(ctx, chosen.nearbyStops?.let { NearbySwap.order(it, chosen.swap, now0) }, chosen.fetchedAt, chosen.error)
                frame.offline != null ->
                    OfflineDay.lines(frame.offline) { clock(ctx, it) }
                        .let { Spoken.sentences(L.s(R.string.offline), it.head, it.big, it.how) }
                else -> spokenSummary(ctx, paired, answer, error)
            }
        Box(
            modifier =
                GlanceModifier.fillMaxSize()
                    .appWidgetBackground()
                    .background(look.pageColor)
                    .cornerRadius(android.R.dimen.system_app_widget_background_radius)
                    .semantics { contentDescription = spoken }
                    .clickable(tap)
        ) {
            when {
                mode == Mode.Nearby -> {
                    val view =
                        NearbyView.of(
                            paired,
                            chosen.nearbyStops,
                            chosen.swap,
                            chosen.fetchedAt,
                            chosen.error,
                            chosen.page,
                            System.currentTimeMillis(),
                        )
                    NearbyLayout(look, w, h, view, NearbyControls(scene.refresh, { PageAction.of(it) }, chips, mode, scene.chipAction))
                }
                shape == WidgetShape.BAR -> BarLayout(scene, w, h)
                shape == WidgetShape.SQUARE -> SquareLayout(scene, w, h)
                shape == WidgetShape.DAY -> DayLayout(scene, w, h)
                else -> TripLayout(scene, w, h)
            }
        }
    }

    sealed interface Tap {
        data object Plan : Tap

        data object Nearby : Tap

        data class Place(val key: String) : Tap

        data class Stop(val code: String, val label: String) : Tap
    }

    data class Frame(val offline: OfflineDay.Pick?, val refreshButton: Boolean, val tap: Tap)

    companion object {
        fun frame(paired: Boolean, mode: Mode, answer: NextAnswer?, error: String?, live: Boolean, now: Long, day: () -> DayPlan?): Frame {
            val onTimetable = mode == Mode.Timetable
            val offline =
                if (onTimetable && paired && error != null && error != UPDATING && (answer == null || isOld(answer, now)))
                    OfflineDay.next(day(), now)
                else null
            val refreshButton = paired && (!live || !onTimetable)
            val tap =
                when (mode) {
                    Mode.Timetable -> Tap.Plan
                    Mode.Nearby -> Tap.Nearby
                    is Mode.To ->
                        (mode.target as? Target.SavedPlace)?.let { Tap.Place(it.key) }
                            ?: Tap.Stop(mode.dest.id.removePrefix("stop:"), mode.label)
                }
            return Frame(offline, refreshButton, tap)
        }

        fun departures(s: NearbyStop, ageS: Long, n: Int, skip: Int = 0): String =
            s.board
                .filter { it.etaS != null }
                .drop(skip)
                .take(n)
                .joinToString(" · ") { r ->
                    val left = (r.etaS!! - ageS).toInt()
                    "${r.svc} ${r.eta?.takeIf { ageS < SERVER_ETA_S } ?: eta(left.coerceAtLeast(0), r.quality)}"
                }
    }
}

internal fun chipAction(ctx: Context, mode: Mode, appWidgetId: Int): Action =
    if (mode != Mode.Timetable && Locator.hasForeground(ctx)) {
        actionStartService(WidgetModeService.intent(ctx, appWidgetId, mode), isForegroundService = true)
    } else {
        actionRunCallback<ModeAction>(actionParametersOf(ModeAction.MODE_ID to mode.id, ModeAction.MODE_LABEL_PARAM to mode.label))
    }

fun spokenSummary(ctx: Context, paired: Boolean, answer: NextAnswer?, error: String?): String =
    Spoken.summary(paired, answer, error, ServerClock.now()) { clock(ctx, it) }

internal class Latest<K, V : Any> {
    private var key: K? = null
    private var value: V? = null

    fun get(k: K, make: () -> V): V =
        value?.takeIf { key == k }
            ?: make().also {
                key = k
                value = it
            }
}

class NextBusWidget : BaseWidget(large = false)

class PlacesWidget : BaseWidget(large = true)

internal val VERSION = longPreferencesKey("version")

suspend fun forgetWidgets(ctx: Context) {
    val mgr = GlanceAppWidgetManager(ctx)
    for (widget in allWidgets()) {
        for (id in mgr.getGlanceIds(widget.javaClass)) updateAppWidgetState(ctx, id) { WidgetModes.forget(it) }
    }
    redrawWidgets(ctx)
}

private fun allWidgets(): List<GlanceAppWidget> = listOf(NextBusWidget(), PlacesWidget(), NearbyWidget())

suspend fun redrawWidgets(ctx: Context) {
    val mgr = GlanceAppWidgetManager(ctx)
    for (widget in allWidgets()) {
        for (id in mgr.getGlanceIds(widget.javaClass)) {
            updateAppWidgetState(ctx, id) { it[VERSION] = System.currentTimeMillis() }
            widget.update(ctx, id)
        }
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val store = Store(context)
        store.lastError = UPDATING
        redrawWidgets(context)
        try {
            Refresher.refresh(context, fast = true, extras = false)
        } catch (e: kotlinx.coroutines.CancellationException) {
            withContext(NonCancellable) {
                if (store.lastError == UPDATING) store.lastError = null
                redrawWidgets(context)
            }
            throw e
        }
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
        if (Refresher.widgetCount(context) == 0) Refresher.widgetsGone(context)
    }
}

class NextBusWidgetReceiver : BusWidgetReceiver(NextBusWidget())

class PlacesWidgetReceiver : BusWidgetReceiver(PlacesWidget())

fun clock(ctx: Context, ms: Long): String {
    val locale = ctx.resources.configuration.locales[0]
    val pattern = DateFormat.getBestDateTimePattern(locale, if (hour12(ctx)) "hmm" else "HHmm")
    return SimpleDateFormat(pattern, locale)
        .apply { timeZone = TimeZone.getTimeZone("Asia/Singapore") }
        .format(Date(ms))
        .replace(Regex("([上下]午)(\\d)"), "$1 $2")
}
