package sh.rcn.terminus.widget

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.CrashReports
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.Push
import sh.rcn.terminus.Quiet
import sh.rcn.terminus.R
import sh.rcn.terminus.RideStyle
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Session
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.UpdateRequired
import sh.rcn.terminus.hour12
import sh.rcn.terminus.setWhileIdle

object Refresher {
    private const val WORK = "terminus-refresh-floor"
    private const val WORK_BEFORE = "terminus-refresh"
    private const val NOW = "terminus-refresh-now"
    private const val MIN_GAP_MS = 15_000L
    private const val MIN_LOCAL_GAP_MS = 60_000L
    private const val RECENT_MS = 15_000L
    private const val FALLBACK_MS = 15 * 60_000L
    private const val DAY_MAX_AGE_MS = 60 * 60_000L
    private const val EXTRAS = "terminus-refresh-extras"

    private val running = Mutex()
    private const val FAST_WAIT_MS = 1_000L

    suspend fun refresh(ctx: Context, fast: Boolean = false, extras: Boolean = true, force: Boolean = false): NextAnswer? {
        var locked = false
        if (fast)
            withTimeoutOrNull(FAST_WAIT_MS) {
                running.lock()
                locked = true
            }
        else {
            running.lock()
            locked = true
        }
        val (answer, more) =
            try {
                refreshNow(ctx, fast, extras, force)
            } finally {
                if (locked) running.unlock()
            }
        if (more) extras(ctx)
        return answer
    }

    private suspend fun refreshNow(ctx: Context, fast: Boolean, extras: Boolean, force: Boolean): Pair<NextAnswer?, Boolean> {
        val store = Store(ctx)
        val token = store.token
        if (token == null) {
            store.lastError = null
            redrawWidgets(ctx)
            return null to false
        }
        if (!force) {
            val error = store.lastError
            val recent = store.lastAnswer()?.takeIf { (_, at) -> System.currentTimeMillis() - at in 0 until RECENT_MS }
            if (recent != null && (error == null || error == UPDATING)) {
                if (error == UPDATING) store.lastError = null
                scheduleNext(ctx, recent.first, recent.second)
                redrawWidgets(ctx)
                return recent.first to false
            }
        }
        var fresh: NextAnswer? = null
        val loc = Locator.lastKnown(ctx)
        try {
            val api = Api(token, fast, hour12(ctx))
            val asked = System.currentTimeMillis()
            val json = api.nextJson(Target.Plan, loc?.latitude, loc?.longitude, Locator.accOf(loc))
            val now = System.currentTimeMillis()
            val answer = store.saveAnswer(json, now, sentWith = token, askedAtMs = asked) ?: return null to false
            fresh = answer
            store.lastError = null
            scheduleNext(ctx, answer, now)
            if (Push.stale(ctx)) Push.sync(ctx)
        } catch (e: UpdateRequired) {
            store.lastError = e.message
            armFromCache(ctx, store)
            armRedraw(ctx, store)
        } catch (e: ApiError) {
            if (e.status == 401) {
                if (!Session.rejected(ctx, token)) return null to false
            } else {
                store.lastError = e.message
                failed(ctx, store)
            }
        } catch (e: ParseError) {
            store.lastError = L.s(R.string.unexpected_answer)
            failed(ctx, store)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            store.lastError = L.s(R.string.offline)
            failed(ctx, store)
        }
        if (fresh != null && extras) return fresh to true
        if (fresh != null && extrasDue(ctx, store)) queueExtras(ctx)
        WidgetModes.armChosen(ctx)
        redrawWidgets(ctx)
        return fresh to false
    }

    private fun failed(ctx: Context, store: Store) {
        armFromCache(ctx, store)
        val retry = retryLater(ctx, store)
        armRedraw(ctx, store, before = retry)
    }

    internal suspend fun chosen(ctx: Context, staleOnly: Boolean = false) {
        try {
            WidgetModes.refreshChosen(ctx, staleOnly)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {}
    }

    private fun dayDue(store: Store, now: Long): Boolean {
        val at = store.dayFetchedAt
        return at == 0L ||
            now - at > DAY_MAX_AGE_MS ||
            store.dayLang != L.header() ||
            store.lastDay()?.first?.date != OfflineDay.sgtDate(now)
    }

    private suspend fun extrasDue(ctx: Context, store: Store): Boolean =
        dayDue(store, System.currentTimeMillis()) || WidgetModes.anyDue(ctx) || NearbyShared.due(ctx)

    private suspend fun keepDay(token: String, api: Api, store: Store, loc: android.location.Location?, now: Long) {
        if (dayDue(store, now)) {
            try {
                val (json, lang) = api.dayJson(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                store.saveDay(json, now, sentWith = token, lang = lang)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {}
        }
    }

    suspend fun extras(ctx: Context) {
        val store = Store(ctx)
        val token = store.token ?: return
        val loc = Locator.lastKnown(ctx)
        keepDay(token, Api(token, hour12 = hour12(ctx)), store, loc, System.currentTimeMillis())
        chosen(ctx)
        NearbyShared.refreshIfDue(ctx)
        WidgetModes.armChosen(ctx)
        redrawWidgets(ctx)
    }

    private fun queueExtras(ctx: Context) {
        val work =
            OneTimeWorkRequestBuilder<ExtrasWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(EXTRAS, ExistingWorkPolicy.REPLACE, work)
    }

    private fun retryLater(ctx: Context, store: Store): Long? {
        if (!active(ctx)) return null
        val failures = store.refreshFailures
        store.refreshFailures = failures + 1
        val at = retryAt(System.currentTimeMillis(), failures, Quiet.waitMs())
        ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(at, alarmIntent(ctx), wake = notifying(ctx, store))
        store.refreshAlarmAt = at
        return at
    }

    suspend fun redrawWhileWaiting(ctx: Context) {
        val store = Store(ctx)
        if (store.paired && !online(ctx)) store.lastError = L.s(R.string.offline)
        armRedraw(ctx, store)
        redrawWidgets(ctx)
        WidgetModes.armChosen(ctx)
    }

    internal fun online(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    fun armFromCache(ctx: Context, store: Store = Store(ctx)) {
        store.lastAnswer()?.let { (answer, _) -> LeaveAlerts.arm(ctx, answer) }
    }

    fun armRedraw(ctx: Context, store: Store, answer: NextAnswer? = store.lastAnswer()?.first, before: Long? = null) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        if (widgetCount(ctx) == 0) return
        val now = ServerClock.now()
        val day = if (store.lastError != null) OfflineDay.nextChangeAt(store.lastDay()?.first, now) else null
        val sky = ServerClock.fromDevice(nextPhaseAt(System.currentTimeMillis()))
        val at = listOfNotNull(answer?.let { redrawAt(it, now) }, day, sky).minOrNull()?.let { ServerClock.toDevice(it) + 1_000 }
        if (at == null || (before != null && at >= before)) am.cancel(redrawIntent(ctx))
        else am.setWhileIdle(at, redrawIntent(ctx), wake = false)
    }

    private fun redrawIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            1,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REDRAW),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    fun active(ctx: Context): Boolean =
        Store(ctx).let {
            it.paired && (widgetCount(ctx) > 0 || notifying(ctx, it))
        }

    private fun notifying(ctx: Context, store: Store): Boolean =
        (store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)) ||
            (store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL))

    internal fun refreshAlarms(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean, notifying: Boolean): Pair<Long?, Long?> {
        val wakeAt = if (notifying) nextRefreshAt(answer, fetchedAt, now, widget = false) else null
        val at = if (widget) nextRefreshAt(answer, fetchedAt, now, widget = true) else null
        return (if (at != null && wakeAt != null && wakeAt <= at) null else at) to wakeAt
    }

    fun nextRefreshAt(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean = true): Long =
        serverRefreshAt(answer, now, widget) ?: (fetchedAt + FALLBACK_MS).coerceAtLeast(now + MIN_LOCAL_GAP_MS)

    internal fun serverRefreshAt(answer: NextAnswer, now: Long, widget: Boolean = true): Long? {
        val card = answer.card
        return listOfNotNull(answer.refreshAtMs, if (widget) card?.nextChangeAtMs ?: card?.staleAtMs else null)
            .filter { it > now }
            .minOrNull()
            ?.coerceAtLeast(now + MIN_GAP_MS)
    }

    internal fun onTrack(answer: NextAnswer?, error: String?, alarmAt: Long, now: Long): Boolean =
        answer != null && error == null && !isOld(answer, now) && alarmAt > now

    internal fun redrawAt(answer: NextAnswer, now: Long): Long? {
        val card = answer.card
        val ride = card?.ride?.takeIf { card.phase == "riding" }?.let { RideStyle.nextRedrawAt(it, now) }
        val leave = answer.leaveAtMs?.takeIf { answer.mode != "rest" }
        return listOfNotNull(card?.nextChangeAtMs, card?.staleAtMs, leave, ride).filter { it > now }.minOrNull()
    }

    fun scheduleNext(ctx: Context, answer: NextAnswer, fetchedAt: Long) {
        LeaveAlerts.arm(ctx, answer)
        if (!active(ctx)) return
        val widget = widgetCount(ctx) > 0
        val store = Store(ctx)
        val (widgetAt, wakeAt) =
            refreshAlarms(answer, ServerClock.fromDevice(fetchedAt), ServerClock.now(), widget, notifying(ctx, store)).let { (a, b) ->
                a?.let(ServerClock::toDevice) to b?.let(ServerClock::toDevice)
            }
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        if (widgetAt != null) am.setWhileIdle(widgetAt, alarmIntent(ctx), wake = false) else am.cancel(alarmIntent(ctx))
        if (wakeAt != null) am.setWhileIdle(wakeAt, wakeIntent(ctx)) else am.cancel(wakeIntent(ctx))
        val at = listOfNotNull(widgetAt, wakeAt).minOrNull()
        store.refreshAlarmAt = at ?: 0
        if (widget) armRedraw(ctx, store, answer, before = at)
    }

    fun refreshSoon(ctx: Context) {
        val work =
            OneTimeWorkRequestBuilder<RefreshWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, work)
    }

    fun schedule(ctx: Context) {
        if (!active(ctx)) return
        val request =
            PeriodicWorkRequestBuilder<RefreshWorker>(60, TimeUnit.MINUTES)
                .setInputData(workDataOf(RefreshWorker.FLOOR to true))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun dropOldFloor(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK_BEFORE)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).run {
            cancelUniqueWork(WORK)
            cancelUniqueWork(WORK_BEFORE)
        }
        ctx.getSystemService(AlarmManager::class.java)?.run {
            cancel(alarmIntent(ctx))
            cancel(wakeIntent(ctx))
            cancel(redrawIntent(ctx))
            cancel(WidgetModes.alarmIntent(ctx))
            cancel(WidgetModes.backstopIntent(ctx))
        }
        Store(ctx).refreshAlarmAt = 0
        LeaveAlerts.cancel(ctx)
        LiveService.stop(ctx)
    }

    fun widgetsGone(ctx: Context) {
        ctx.getSystemService(AlarmManager::class.java)?.run {
            cancel(redrawIntent(ctx))
            cancel(WidgetModes.alarmIntent(ctx))
            cancel(WidgetModes.backstopIntent(ctx))
        }
        if (active(ctx)) return
        WorkManager.getInstance(ctx).run {
            cancelUniqueWork(WORK)
            cancelUniqueWork(WORK_BEFORE)
        }
        ctx.getSystemService(AlarmManager::class.java)?.run {
            cancel(alarmIntent(ctx))
            cancel(wakeIntent(ctx))
        }
        Store(ctx).refreshAlarmAt = 0
    }

    fun widgetCount(ctx: Context): Int {
        val mgr = AppWidgetManager.getInstance(ctx) ?: return 0
        return listOf(NextBusWidgetReceiver::class.java, PlacesWidgetReceiver::class.java, NearbyWidgetReceiver::class.java).sumOf {
            mgr.getAppWidgetIds(ComponentName(ctx, it)).size
        }
    }

    private fun alarmIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            0,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun wakeIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            9,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    const val ACTION_REFRESH = "sh.rcn.terminus.REFRESH"
    const val ACTION_REDRAW = "sh.rcn.terminus.REDRAW"
    const val ACTION_REDRAW_CHOSEN = "sh.rcn.terminus.REDRAW_CHOSEN"
}

class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val ctx = applicationContext
        val store = Store(ctx)
        val now = ServerClock.now()
        if (
            inputData.getBoolean(FLOOR, false) &&
                Refresher.onTrack(store.lastAnswer()?.first, store.lastError, ServerClock.fromDevice(store.refreshAlarmAt), now)
        ) {
            redrawWidgets(ctx)
            return Result.success()
        }
        Refresher.refresh(ctx)
        return Result.success()
    }

    companion object {
        const val FLOOR = "floor"
    }
}

class ExtrasWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Refresher.extras(applicationContext)
        return Result.success()
    }
}

internal fun retryDelay(failures: Int): Long = (60_000L shl failures.coerceIn(0, 4)).coerceAtMost(15 * 60_000L)

internal fun retryAt(now: Long, failures: Int, quietMs: Long): Long = now + maxOf(retryDelay(failures), quietMs)

class RefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Refresher.ACTION_REFRESH,
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                val store = Store(context)
                val alarm = intent.action == Refresher.ACTION_REFRESH
                val trip = store.lastAnswer()?.first?.card?.phase in LiveService.TRIP_PHASES
                val live = (!alarm || trip) && LiveService.start(context)
                if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Refresher.dropOldFloor(context)
                if (Refresher.active(context)) {
                    if (!alarm) Refresher.armFromCache(context, store)
                    Refresher.schedule(context)
                    when {
                        live -> finishAsync(context, Dispatchers.Default) { Refresher.redrawWhileWaiting(context) }
                        alarm && Refresher.online(context) ->
                            finishAsync(context, Dispatchers.IO) {
                                Refresher.refresh(context, fast = true, extras = false)
                            }
                        else -> {
                            Refresher.refreshSoon(context)
                            finishAsync(context, Dispatchers.Default) { Refresher.redrawWhileWaiting(context) }
                        }
                    }
                }
            }
            Refresher.ACTION_REDRAW ->
                finishAsync(context, Dispatchers.Default) {
                    redrawWidgets(context)
                    val store = Store(context)
                    Refresher.armRedraw(context, store, before = store.refreshAlarmAt.takeIf { it > System.currentTimeMillis() })
                }
            Refresher.ACTION_REDRAW_CHOSEN ->
                finishAsync(context, Dispatchers.IO) {
                    if (Store(context).paired && Refresher.online(context)) {
                        Refresher.chosen(context, staleOnly = true)
                        NearbyShared.refreshIfDue(context, onRedraw = true)
                    }
                    redrawWidgets(context)
                    WidgetModes.armChosen(context)
                }
            Intent.ACTION_TIME_CHANGED -> {
                if (Refresher.active(context)) Refresher.refreshSoon(context)
                finishAsync(context, Dispatchers.Default) { redrawWidgets(context) }
            }
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_LOCALE_CHANGED ->
                finishAsync(context, Dispatchers.Default) {
                    redrawWidgets(context)
                }
            NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED,
            NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED -> {
                Push.sync(context)
                if (Refresher.active(context)) {
                    Refresher.schedule(context)
                    Refresher.refreshSoon(context)
                    if (LeaveAlerts.canNotify(context, LiveService.CHANNEL)) LiveService.start(context) else LiveService.stop(context)
                } else {
                    Refresher.cancel(context)
                }
            }
        }
    }
}

internal fun BroadcastReceiver.finishAsync(context: Context, dispatcher: CoroutineDispatcher, block: suspend () -> Unit) {
    val pending = goAsync()
    val failed = CoroutineExceptionHandler { _, e ->
        Log.w("terminus", "widget broadcast failed", e)
        if (e !is java.io.IOException) CrashReports.caught(context, e)
    }
    CoroutineScope(dispatcher + failed).launch {
        try {
            block()
        } finally {
            pending.finish()
        }
    }
}
