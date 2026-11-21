package sh.rcn.terminus.widget

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.SizeF
import androidx.core.net.toUri
import androidx.core.os.BundleCompat
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
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
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Place
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.setWhileIdle

sealed interface Mode {
    val id: String
    val label: String

    data object Timetable : Mode {
        override val id = "plan"
        override val label
            get() = L.s(R.string.timetable)
    }

    data object Nearby : Mode {
        override val id = "nearby"
        override val label
            get() = L.s(R.string.chip_nearby)
    }

    data class To(val dest: Destinations.Dest) : Mode {
        override val id
            get() = dest.id

        override val label
            get() = dest.label

        val target: Target
            get() =
                if (dest.id.startsWith("place:")) Target.SavedPlace(dest.id.removePrefix("place:"))
                else Target.Code(dest.id.removePrefix("stop:"), dest.label)
    }

    companion object {
        fun of(id: String?, label: String?): Mode =
            when {
                id == null || id == Timetable.id -> Timetable
                id == Nearby.id -> Nearby
                (id.startsWith("place:") || id.startsWith("stop:")) && label != null -> To(Destinations.Dest(id, label))
                else -> Timetable
            }
    }
}

object WidgetModes {
    const val MAX_BUTTONS = 8
    const val KEEP_MS = 30 * 60_000L
    private const val REFETCH_MS = 60_000L
    const val NEARBY_OLD_MS = 180_000L

    val MODE = stringPreferencesKey("mode")
    val MODE_LABEL = stringPreferencesKey("mode-label")
    val MODE_AT = longPreferencesKey("mode-at")
    val MODE_JSON = stringPreferencesKey("mode-json")
    val MODE_FETCHED = longPreferencesKey("mode-fetched")
    val MODE_ERROR = stringPreferencesKey("mode-error")

    fun forget(prefs: MutablePreferences) {
        for (k in
            listOf(
                MODE,
                MODE_LABEL,
                MODE_AT,
                MODE_JSON,
                MODE_FETCHED,
                MODE_ERROR,
                NearbySwap.FROM,
                NearbySwap.TO,
                NearbySwap.AT,
                NEARBY_PAGE,
            )) prefs.remove(k)
    }

    fun effective(chosen: Mode, chosenAt: Long?, plan: NextAnswer?, rowShown: Boolean, now: Long, toDevice: (Long) -> Long = { it }): Mode {
        if (chosen == Mode.Timetable || !rowShown || chosenAt == null) return Mode.Timetable
        if (now - chosenAt > KEEP_MS) return Mode.Timetable
        val dueAt = (plan?.card?.remindAtMs ?: plan?.leaveAtMs)?.let(toDevice)
        if (dueAt != null && dueAt in (chosenAt + 1)..now && plan?.card?.phase in LiveService.TRIP_PHASES) return Mode.Timetable
        return chosen
    }

    fun fitting(labels: List<String>, widthDp: Float): Int {
        var used = 0f
        labels.forEachIndexed { i, l ->
            used += (if (i > 0) 6f else 0f) + 28f + l.length * 7.2f
            if (used > widthDp) return i
        }
        return labels.size
    }

    internal fun rowWanted(shape: WidgetShape, large: Boolean): Boolean = shape.roomy && (large || shape == WidgetShape.DAY)

    internal fun rowWidth(widthDp: Float, shape: WidgetShape): Float = widthDp - 28f - if (shape == WidgetShape.DAY) 44f else 0f

    internal fun rowShown(widthDp: Float, heightDp: Float, large: Boolean): Boolean {
        val shape = WidgetShape.of(widthDp, heightDp)
        return rowWanted(shape, large) && fitting(listOf(Mode.Timetable.label, Mode.Nearby.label), rowWidth(widthDp, shape)) == 2
    }

    private fun rowShownAnySize(ctx: Context, id: GlanceId, large: Boolean): Boolean =
        anySize(ctx, id, unknown = true) { w, h -> rowShown(w, h, large) }

    internal fun bigAnySize(ctx: Context, id: GlanceId): Boolean =
        anySize(ctx, id, unknown = false) { w, h -> WidgetShape.of(w, h) == WidgetShape.DAY }

    private fun anySize(ctx: Context, id: GlanceId, unknown: Boolean, test: (Float, Float) -> Boolean): Boolean {
        val options = AppWidgetManager.getInstance(ctx).getAppWidgetOptions(GlanceAppWidgetManager(ctx).getAppWidgetId(id))
        val sizes = BundleCompat.getParcelableArrayList(options, AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF::class.java)
        if (!sizes.isNullOrEmpty()) return sizes.any { test(it.width, it.height) }
        val minW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
        val maxH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)
        val maxW = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)
        val minH = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)
        if (maxW == 0 || maxH == 0) return unknown
        return test(minW.toFloat(), maxH.toFloat()) || test(maxW.toFloat(), minH.toFloat())
    }

    fun chips(
        uses: Map<String, Destinations.Use>,
        places: List<Place>,
        added: List<Destinations.Dest>,
        widthDp: Float,
        now: Long = System.currentTimeMillis(),
    ): List<Mode> {
        val ranked = Destinations.rank(places, added, uses, now).map { Mode.To(it) }
        return pick(listOf(Mode.Timetable, Mode.Nearby) + ranked, ranked.firstOrNull { it.dest.id == added.firstOrNull()?.id }, widthDp)
    }

    fun pick(all: List<Mode>, newest: Mode?, widthDp: Float): List<Mode> {
        val fits = { modes: List<Mode> -> fitting(modes.map { it.label }, widthDp) == modes.size }
        val shown = all.take(minOf(fitting(all.map { it.label }, widthDp), MAX_BUTTONS))
        if (shown.size < 2) return emptyList()
        if (newest == null || newest in shown) return shown
        var head = shown.dropLast(1).let { if (it.size < 2) shown else it }
        while (head.size > 2 && !fits(head + newest)) head = head.dropLast(1)
        return if (fits(head + newest)) head + newest else shown
    }

    suspend fun show(ctx: Context, id: GlanceId, mode: Mode, fresh: Boolean) {
        val now = System.currentTimeMillis()
        val same = currentMode(ctx, id).id == mode.id
        updateAppWidgetState(ctx, id) {
            it[MODE] = mode.id
            it[MODE_LABEL] = mode.label
            it[MODE_AT] = now
            it[MODE_ERROR] = UPDATING
            if (!same) {
                it.remove(MODE_JSON)
                it.remove(MODE_FETCHED)
            }
        }
        redrawWidgets(ctx)
        if (mode is Mode.To) Store(ctx).noteDestination(mode.dest, now)
        if (mode == Mode.Timetable) {
            updateAppWidgetState(ctx, id) { it.remove(MODE_ERROR) }
            Store(ctx).lastError = UPDATING
            redrawWidgets(ctx)
            Refresher.refresh(ctx, fast = true, extras = false)
            armChosen(ctx)
            return
        }
        request(ctx, mode, fresh)?.let { (token, result) -> record(ctx, id, mode, token, result) }
        redrawWidgets(ctx)
        armChosen(ctx)
    }

    private suspend fun request(ctx: Context, mode: Mode, fresh: Boolean): Pair<String, Result<JSONObject>>? {
        val store = Store(ctx)
        val token = store.token ?: return null
        val loc = if (fresh) Locator.current(ctx) else Locator.lastKnown(ctx)
        val api = Api(token, fast = true, hour12 = hour12(ctx))
        val result = runCatching {
            when (mode) {
                Mode.Nearby -> api.nearbyJson(loc?.latitude, loc?.longitude, Locator.accOf(loc), stopped = true)
                is Mode.To -> api.nextJson(mode.target, loc?.latitude, loc?.longitude, Locator.accOf(loc))
                Mode.Timetable -> JSONObject()
            }
        }
        when (val e = result.exceptionOrNull()) {
            is kotlinx.coroutines.CancellationException -> throw e
            is ApiError -> if (e.status == 401 && sh.rcn.terminus.Session.rejected(ctx, token)) return null
        }
        return token to result
    }

    private suspend fun record(ctx: Context, id: GlanceId, mode: Mode, sentWith: String, result: Result<JSONObject>) {
        updateAppWidgetState(ctx, id) {
            if (Store(ctx).token != sentWith) return@updateAppWidgetState
            result
                .onSuccess { json ->
                    it[MODE_JSON] = json.toString()
                    it[MODE_FETCHED] = System.currentTimeMillis()
                    it.remove(MODE_ERROR)
                }
                .onFailure { e ->
                    it[MODE_ERROR] =
                        when {
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

    private class Chosen(val id: GlanceId, val mode: Mode, val at: Long, val fetchedAt: Long?, val json: String?) {
        val answer: NextAnswer? by lazy {
            json?.takeIf { mode is Mode.To }?.let { runCatching { NextAnswer.parse(JSONObject(it)) }.getOrNull() }
        }

        fun busGoes(now: Long, exact: Boolean): Long? {
            if (mode != Mode.Nearby || fetchedAt == null) return null
            val stops = json?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() } ?: return null
            return NearbyBoard.redrawAt(
                stops.take(2).flatMap { NearbyBoard.buses(it, fetchedAt, now, sh.rcn.terminus.ServerClock.skewMs) },
                now,
                (fetchedAt + NEARBY_OLD_MS).takeIf { exact },
            )
        }
    }

    private suspend fun chosen(ctx: Context, now: Long): List<Chosen> {
        val mgr = GlanceAppWidgetManager(ctx)
        val plan = Store(ctx).lastAnswer()?.first
        return listOf(NextBusWidget::class.java to false, PlacesWidget::class.java to true).flatMap { (cls, large) ->
            mgr.getGlanceIds(cls).mapNotNull { id ->
                val prefs: Preferences = getAppWidgetState(ctx, PreferencesGlanceStateDefinition, id)
                val mode = Mode.of(prefs[MODE], prefs[MODE_LABEL])
                val at = prefs[MODE_AT] ?: return@mapNotNull null
                val rowShown = mode != Mode.Timetable && rowShownAnySize(ctx, id, large)
                if (effective(mode, at, plan, rowShown = rowShown, now = now, toDevice = ServerClock::toDevice) == Mode.Timetable) null
                else Chosen(id, mode, at, prefs[MODE_FETCHED], prefs[MODE_JSON])
            }
        }
    }

    private fun due(all: List<Chosen>, now: Long, staleOnly: Boolean): List<Chosen> = all.filter { c ->
        now - (c.fetchedAt ?: 0L) >= REFETCH_MS && (!staleOnly || c.answer?.let { isOld(it, ServerClock.fromDevice(now)) } == true)
    }

    suspend fun anyDue(ctx: Context): Boolean {
        val now = System.currentTimeMillis()
        return due(chosen(ctx, now), now, staleOnly = false).isNotEmpty()
    }

    suspend fun refreshChosen(ctx: Context, staleOnly: Boolean = false) {
        val now = System.currentTimeMillis()
        for ((_, same) in due(chosen(ctx, now), now, staleOnly).groupBy { it.mode.id }) {
            val (token, result) = request(ctx, same.first().mode, fresh = false) ?: return
            for (c in same) record(ctx, c.id, c.mode, token, result)
        }
    }

    suspend fun armChosen(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val now = System.currentTimeMillis()
        val exact = am.canScheduleExactAlarms()
        val at =
            if (Store(ctx).paired) {
                val chosen = chosen(ctx, now).mapNotNull { redrawAt(it.mode, it.at, it.fetchedAt, it.answer, now, it.busGoes(now, exact)) }
                val shared = if (NearbyShared.wanted(ctx)) NearbyShared.redrawAt(ctx, now) else null
                (chosen + listOfNotNull(shared)).minOrNull()
            } else null
        if (at == null) am.cancel(alarmIntent(ctx)) else am.setWhileIdle(stepTo(at + 1_000, now, exact), alarmIntent(ctx), wake = false)
        val backstop = backstopAt(at, exact)
        if (backstop == null) am.cancel(backstopIntent(ctx)) else am.setAndAllowWhileIdle(AlarmManager.RTC, backstop, backstopIntent(ctx))
    }

    internal fun backstopAt(at: Long?, exact: Boolean): Long? = at?.takeIf { exact }?.plus(BACKSTOP_MS)

    private const val BACKSTOP_MS = 120_000L

    const val LAST_STEP_MS = 25_000L

    internal fun stepTo(at: Long, now: Long, exact: Boolean): Long = if (exact || at - now <= LAST_STEP_MS) at else now + (at - now) / 3

    internal fun redrawAt(mode: Mode, chosenAt: Long, fetchedAt: Long?, answer: NextAnswer?, now: Long, busGoes: Long? = null): Long? =
        listOfNotNull(
                chosenAt + KEEP_MS,
                fetchedAt?.takeIf { mode == Mode.Nearby }?.plus(NEARBY_OLD_MS),
                busGoes,
                answer?.let { Refresher.redrawAt(it, ServerClock.fromDevice(now)) }?.let(ServerClock::toDevice),
            )
            .filter { it > now }
            .minOrNull()

    internal fun alarmIntent(ctx: Context, requestCode: Int = 2): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            requestCode,
            Intent(ctx, RefreshReceiver::class.java).setAction(Refresher.ACTION_REDRAW_CHOSEN),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    internal fun backstopIntent(ctx: Context): PendingIntent = alarmIntent(ctx, requestCode = 10)
}

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

class WidgetModeService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val widgetId = intent?.getIntExtra(EXTRA_WIDGET, -1) ?: -1
        val shared = intent?.getBooleanExtra(EXTRA_SHARED, false) ?: false
        val mode = Mode.of(intent?.getStringExtra(EXTRA_MODE), intent?.getStringExtra(EXTRA_LABEL))
        val location = Locator.hasForeground(this)
        val started = runCatching {
            val type =
                if (location) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE
                else 0
            if (type == 0) startForeground(NOTIFICATION_ID, notification()) else startForeground(NOTIFICATION_ID, notification(), type)
        }
            .isSuccess
        scope.launch {
            try {
                if (shared) {
                    NearbyShared.refresh(this@WidgetModeService, fresh = started && location, tapped = true)
                } else {
                    val id = runCatching { GlanceAppWidgetManager(this@WidgetModeService).getGlanceIdBy(widgetId) }.getOrNull()
                    if (id != null) WidgetModes.show(this@WidgetModeService, id, mode, fresh = started && location)
                }
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

    @Deprecated("Android 15 calls onTimeout(startId, fgsType)")
    override fun onTimeout(startId: Int) {
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
            }
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
        const val EXTRA_SHARED = "shared"

        fun intent(ctx: Context, appWidgetId: Int, mode: Mode): Intent =
            Intent(ctx, WidgetModeService::class.java)
                .setData("terminus-widget://$appWidgetId/${Uri.encode(mode.id)}".toUri())
                .putExtra(EXTRA_WIDGET, appWidgetId)
                .putExtra(EXTRA_MODE, mode.id)
                .putExtra(EXTRA_LABEL, mode.label)

        fun nearbyIntent(ctx: Context, appWidgetId: Int): Intent =
            Intent(ctx, WidgetModeService::class.java)
                .setData("terminus-widget://$appWidgetId/nearby-shared".toUri())
                .putExtra(EXTRA_WIDGET, appWidgetId)
                .putExtra(EXTRA_SHARED, true)
    }
}
