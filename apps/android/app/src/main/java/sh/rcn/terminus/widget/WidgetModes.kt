package sh.rcn.terminus.widget

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.net.toUri
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.state.PreferencesGlanceStateDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Place
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.hour12

/**
 * What a widget shows (phase 8.3). The timetable's plan by default; a row of
 * buttons switches it, in place, to the buses near you or the quickest way
 * from where you are to one of the places you usually go. Each widget keeps
 * its own choice.
 *
 * The choice gives way to the timetable by itself: after [KEEP_MS], when a
 * trip becomes due after it was made, and whenever the widget is too small
 * for the buttons (so a widget can't be stuck on a place with no way back).
 */
sealed interface Mode {
    val id: String
    val label: String

    data object Timetable : Mode {
        override val id = "plan"
        override val label get() = L.s(R.string.timetable)
    }

    data object Nearby : Mode {
        override val id = "nearby"
        override val label get() = L.s(R.string.chip_nearby)
    }

    /** A saved place (`place:<key>`) or a stop looked up (`stop:<code>`). */
    data class To(val dest: Destinations.Dest) : Mode {
        override val id get() = dest.id
        override val label get() = dest.label
        val target: Target
            get() = if (dest.id.startsWith("place:")) Target.SavedPlace(dest.id.removePrefix("place:")) else Target.Code(dest.id.removePrefix("stop:"), dest.label)
    }

    companion object {
        fun of(id: String?, label: String?): Mode = when {
            id == null || id == Timetable.id -> Timetable
            id == Nearby.id -> Nearby
            (id.startsWith("place:") || id.startsWith("stop:")) && label != null -> To(Destinations.Dest(id, label))
            else -> Timetable
        }
    }
}

object WidgetModes {
    /** A Glance Row holds at most 10 children; this many buttons is plenty. */
    const val MAX_BUTTONS = 8
    /** A place chosen on the widget goes back to the timetable after this long. */
    const val KEEP_MS = 30 * 60_000L
    /** A chosen place's answer is fetched again in the background at most this often. */
    private const val REFETCH_MS = 60_000L

    val MODE = stringPreferencesKey("mode")
    val MODE_LABEL = stringPreferencesKey("mode-label")
    val MODE_AT = longPreferencesKey("mode-at")
    val MODE_JSON = stringPreferencesKey("mode-json")
    val MODE_FETCHED = longPreferencesKey("mode-fetched")
    val MODE_ERROR = stringPreferencesKey("mode-error")

    /**
     * The mode to show now: the chosen one, unless it has run out or a trip
     * has become due since it was chosen (the timetable matters then).
     */
    fun effective(chosen: Mode, chosenAt: Long?, plan: NextAnswer?, rowShown: Boolean, now: Long): Mode {
        if (chosen == Mode.Timetable || !rowShown || chosenAt == null) return Mode.Timetable
        if (now - chosenAt > KEEP_MS) return Mode.Timetable
        // When the trip turned due: the server's reminder time, else its leave time.
        val dueAt = plan?.card?.remindAtMs ?: plan?.leaveAtMs
        if (dueAt != null && dueAt in (chosenAt + 1)..now && plan?.card?.phase in LiveService.TRIP_PHASES) return Mode.Timetable
        return chosen
    }

    /**
     * How many buttons fit a row this wide: the text at about 7.2 dp a
     * character, 28 dp of padding each and 6 dp between. Glance can't measure
     * text, and a button cut in half is worse than one fewer.
     */
    fun fitting(labels: List<String>, widthDp: Float): Int {
        var used = 0f
        labels.forEachIndexed { i, l ->
            used += (if (i > 0) 6f else 0f) + 28f + l.length * 7.2f
            if (used > widthDp) return i
        }
        return labels.size
    }

    /** The buttons for a row this wide: Timetable and Nearby, then favourites and added places. None if those two don't fit. */
    fun chips(store: Store, places: List<Place>, added: List<Destinations.Dest>, widthDp: Float, now: Long = System.currentTimeMillis()): List<Mode> {
        val ranked = Destinations.rank(places, added, store.destinationUses(), now).map { Mode.To(it) }
        return pick(listOf(Mode.Timetable, Mode.Nearby) + ranked, ranked.firstOrNull { it.dest.id == added.firstOrNull()?.id }, widthDp)
    }

    /**
     * As many of `all` as fit, in order; but the place added last from "Go
     * somewhere else" always gets the last button, in place of favourites
     * that would have pushed it off. None if Timetable and Nearby don't fit.
     */
    fun pick(all: List<Mode>, newest: Mode?, widthDp: Float): List<Mode> {
        val fits = { modes: List<Mode> -> fitting(modes.map { it.label }, widthDp) == modes.size }
        val shown = all.take(minOf(fitting(all.map { it.label }, widthDp), MAX_BUTTONS))
        if (shown.size < 2) return emptyList()
        if (newest == null || newest in shown) return shown
        var head = shown.dropLast(1).let { if (it.size < 2) shown else it }
        while (head.size > 2 && !fits(head + newest)) head = head.dropLast(1)
        return if (fits(head + newest)) head + newest else shown
    }

    /**
     * Switches one widget to `mode` and fetches what it shows. `fresh`: take a
     * new location fix (only inside [WidgetModeService], which a tap started).
     */
    suspend fun show(ctx: Context, id: GlanceId, mode: Mode, fresh: Boolean) {
        val now = System.currentTimeMillis()
        val same = currentMode(ctx, id).id == mode.id
        updateAppWidgetState(ctx, id) {
            it[MODE] = mode.id
            it[MODE_LABEL] = mode.label
            it[MODE_AT] = now
            it[MODE_ERROR] = UPDATING
            // A different place: its old answer is someone else's.
            if (!same) {
                it.remove(MODE_JSON)
                it.remove(MODE_FETCHED)
            }
        }
        redrawWidgets(ctx)
        if (mode is Mode.To) Store(ctx).noteDestination(mode.dest, now)
        if (mode == Mode.Timetable) {
            // The plan's own "Updating…", as a tap on the widget shows: tapping
            // Timetable while it's already showing must visibly do something.
            updateAppWidgetState(ctx, id) { it.remove(MODE_ERROR) }
            Store(ctx).lastError = UPDATING
            redrawWidgets(ctx)
            Refresher.refresh(ctx, fast = true)
            return
        }
        fetch(ctx, id, mode, fresh)
        redrawWidgets(ctx)
    }

    private suspend fun fetch(ctx: Context, id: GlanceId, mode: Mode, fresh: Boolean) {
        val store = Store(ctx)
        val token = store.token ?: return
        val loc = if (fresh) Locator.current(ctx) else Locator.lastKnown(ctx)
        val api = Api(token, fast = true, hour12 = hour12(ctx))
        val result = runCatching {
            when (mode) {
                Mode.Nearby -> api.nearbyJson(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                is Mode.To -> api.nextJson(mode.target, loc?.latitude, loc?.longitude, Locator.accOf(loc))
                Mode.Timetable -> JSONObject()
            }
        }
        updateAppWidgetState(ctx, id) {
            result.onSuccess { json ->
                it[MODE_JSON] = json.toString()
                it[MODE_FETCHED] = System.currentTimeMillis()
                it.remove(MODE_ERROR)
            }.onFailure { e ->
                it[MODE_ERROR] = when {
                    e is ApiError && e.status == 400 && mode == Mode.Nearby -> L.s(R.string.turn_on_location)
                    e is ApiError -> e.message ?: L.s(R.string.couldnt_load)
                    else -> L.s(R.string.offline)
                }
            }
        }
    }

    private suspend fun currentMode(ctx: Context, id: GlanceId): Mode {
        val prefs = getAppWidgetState(ctx, PreferencesGlanceStateDefinition, id)
        return Mode.of(prefs[MODE], prefs[MODE_LABEL])
    }

    /**
     * Keeps each widget showing a place or Nearby current, from the background
     * refresh: at most once a minute, with the last known location, and only
     * while the choice still stands.
     */
    suspend fun refreshChosen(ctx: Context) {
        val mgr = GlanceAppWidgetManager(ctx)
        val now = System.currentTimeMillis()
        for (cls in listOf(NextBusWidget::class.java, PlacesWidget::class.java)) {
            for (id in mgr.getGlanceIds(cls)) {
                val prefs = getAppWidgetState(ctx, PreferencesGlanceStateDefinition, id)
                val mode = Mode.of(prefs[MODE], prefs[MODE_LABEL])
                val at = prefs[MODE_AT] ?: continue
                if (mode == Mode.Timetable || now - at > KEEP_MS) continue
                if (now - (prefs[MODE_FETCHED] ?: 0L) < REFETCH_MS) continue
                fetch(ctx, id, mode, fresh = false)
            }
        }
    }
}

/** A widget button that needs no location: Timetable (and every button without location permission). */
class ModeAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val mode = Mode.of(parameters[MODE_ID], parameters[MODE_LABEL_PARAM])
        WidgetModes.show(context, glanceId, mode, fresh = false)
    }

    companion object {
        val MODE_ID = ActionParameters.Key<String>("mode")
        val MODE_LABEL_PARAM = ActionParameters.Key<String>("label")
    }
}

/**
 * A widget button that needs where you are (Nearby, a place): a moment in the
 * foreground with the location type, which Android allows when a widget tap
 * starts it, to take a fresh fix and fetch. Usually done before Android would
 * even show its notification.
 */
class WidgetModeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val widgetId = intent?.getIntExtra(EXTRA_WIDGET, -1) ?: -1
        val mode = Mode.of(intent?.getStringExtra(EXTRA_MODE), intent?.getStringExtra(EXTRA_LABEL))
        val location = Locator.hasForeground(this)
        val started = runCatching {
            val type = if (location) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE else 0
            if (type == 0) startForeground(NOTIFICATION_ID, notification()) else startForeground(NOTIFICATION_ID, notification(), type)
        }.isSuccess
        scope.launch {
            try {
                val id = runCatching { GlanceAppWidgetManager(this@WidgetModeService).getGlanceIdBy(widgetId) }.getOrNull()
                if (id != null) WidgetModes.show(this@WidgetModeService, id, mode, fresh = started && location)
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        stopSelf(startId)
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    private fun notification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm?.createNotificationChannel(
            NotificationChannel(CHANNEL, L.s(R.string.channel_widget), NotificationManager.IMPORTANCE_MIN).apply {
                description = L.s(R.string.channel_widget_desc)
                setShowBadge(false)
            },
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(Icon.createWithResource(this, R.drawable.ic_bus))
            .setContentTitle(L.s(R.string.checking_buses))
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL = "widget"
        private const val NOTIFICATION_ID = 5
        const val EXTRA_WIDGET = "widget"
        const val EXTRA_MODE = "mode"
        const val EXTRA_LABEL = "label"

        fun intent(ctx: Context, appWidgetId: Int, mode: Mode): Intent =
            Intent(ctx, WidgetModeService::class.java)
                // Distinct per widget and mode, so each button keeps its own PendingIntent.
                .setData("terminus-widget://$appWidgetId/${Uri.encode(mode.id)}".toUri())
                .putExtra(EXTRA_WIDGET, appWidgetId)
                .putExtra(EXTRA_MODE, mode.id)
                .putExtra(EXTRA_LABEL, mode.label)
    }
}
