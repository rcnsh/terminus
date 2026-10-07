package sh.rcn.terminus.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.Push
import sh.rcn.terminus.R
import sh.rcn.terminus.RideStyle
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.setWhileIdle
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.hour12
import java.util.concurrent.TimeUnit

/**
 * Keeping the widget true without a process running:
 *
 * - a network refresh at the moments the server says the answer changes:
 *   when the card changes (`card.nextChangeAt`: the bus leaves, "Leave now"),
 *   when it goes stale (`card.staleAt`), and when the plan moves on
 *   (`refreshAt`). An idle-safe alarm, not a delayed job: Doze defers jobs
 *   for hours, and a departed bus must not sit bright.
 * - a 30-minute periodic job as the floor, in case an alarm is missed.
 * - after a failed refresh, again with a back-off (1, 2, 4, 8, then every
 *   15 min) rather than waiting for the floor, which Doze stretches.
 * - the alarm redraws the widget at once, network or not, so an answer
 *   past its `staleAt` dims (isOld) while the refresh waits for a network.
 * - after a reboot or app update, and on a time or timezone change.
 *
 * Leave alerts (LeaveAlerts) ride on the same chain, so it also runs with no
 * widget when they are on: then only when the plan changes, plus the floor.
 */
object Refresher {
    private const val WORK = "terminus-refresh"
    private const val NOW = "terminus-refresh-now"
    /** Never refresh sooner than this after the last, at a moment the server gave. */
    private const val MIN_GAP_MS = 15_000L
    /** Nor sooner than this at a moment worked out here (a ride's next stop). */
    private const val MIN_LOCAL_GAP_MS = 60_000L
    /** With no moment from the server at all (an answer kept from an older version). */
    private const val FALLBACK_MS = 15 * 60_000L
    /** The day plan kept for offline is fetched again after this long. */
    private const val DAY_MAX_AGE_MS = 60 * 60_000L
    private const val EXTRAS = "terminus-refresh-extras"

    /**
     * Fetch the planned answer, cache it, and redraw every widget. With
     * [extras] off (a push, whose handler has seconds), only the answer:
     * today's plan for offline and the widgets showing a place or Nearby
     * follow in a job (ExtrasWorker).
     */
    suspend fun refresh(ctx: Context, fast: Boolean = false, extras: Boolean = true) {
        val store = Store(ctx)
        val token = store.token
        if (token == null) {
            store.lastError = null
            redrawWidgets(ctx)
            return
        }
        // Android gives the background no location (the app doesn't ask for
        // "Allow all the time"), so this is a fix only while the app is open.
        // Without one, the API follows the timetable and the trip's state.
        val loc = Locator.lastKnown(ctx)
        try {
            val api = Api(token, fast, hour12(ctx))
            val json = api.nextJson(Target.Plan, loc?.latitude, loc?.longitude, Locator.accOf(loc))
            val now = System.currentTimeMillis()
            store.saveAnswer(json, now)
            if (extras) keepDay(api, store, loc, now)
            store.lastError = null
            store.refreshFailures = 0
            scheduleNext(ctx, NextAnswer.parse(json), now)
            // No push address sent yet (a new session, or a new Firebase
            // token), or not sent again for a while (Push.due).
            if (Push.due(store)) Push.register(ctx)
        } catch (e: ApiError) {
            // Only the token this request was sent with is dead: one stored
            // since (signed in again meanwhile) stays.
            if (e.status == 401 && store.token != token) return
            if (e.status == 401) {
                store.token = null
                cancel(ctx)
            } else {
                armFromCache(ctx, store)
                armOfflineRedraw(ctx, store)
                retryLater(ctx, store)
            }
            store.lastError = if (e.status == 401) L.s(R.string.device_removed) else e.message
        } catch (e: ParseError) {
            store.lastError = L.s(R.string.unexpected_answer)
            armFromCache(ctx, store)
            retryLater(ctx, store)
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Replaced by a newer refresh (refreshSoon): not offline, nothing to record.
            throw e
        } catch (e: Exception) {
            store.lastError = L.s(R.string.offline)
            armFromCache(ctx, store)
            armOfflineRedraw(ctx, store)
            retryLater(ctx, store)
        }
        // Widgets showing a place or Nearby (phase 8.3) keep counting down too.
        if (extras) runCatching { WidgetModes.refreshChosen(ctx) } else queueExtras(ctx)
        redrawWidgets(ctx)
    }

    /**
     * Today's plan, kept for when the phone goes offline (OfflineDay): when
     * the one kept is another day's or an hour old.
     */
    private suspend fun keepDay(api: Api, store: Store, loc: android.location.Location?, now: Long) {
        val kept = store.lastDay()
        if (kept == null || kept.first.date != OfflineDay.sgtDate(now) || now - kept.second > DAY_MAX_AGE_MS) {
            runCatching { store.saveDay(api.dayJson(loc?.latitude, loc?.longitude, Locator.accOf(loc)), now) }
        }
    }

    /** What [refresh] leaves out without [extras], run once there's time and a network. */
    suspend fun extras(ctx: Context) {
        val store = Store(ctx)
        val token = store.token ?: return
        val loc = Locator.lastKnown(ctx)
        keepDay(Api(token, hour12 = hour12(ctx)), store, loc, System.currentTimeMillis())
        runCatching { WidgetModes.refreshChosen(ctx) }
        redrawWidgets(ctx)
    }

    private fun queueExtras(ctx: Context) {
        val work = OneTimeWorkRequestBuilder<ExtrasWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(EXTRAS, ExistingWorkPolicy.REPLACE, work)
    }

    /**
     * A failed refresh is tried again after [retryDelay], through the
     * refresh alarm, rather than at the 30-minute floor: the widget and the
     * leave alerts would otherwise go quiet until then. Offline, the alarm
     * only redraws until a network is back (RefreshReceiver).
     */
    private fun retryLater(ctx: Context, store: Store) {
        if (!active(ctx)) return
        val failures = store.refreshFailures
        store.refreshFailures = failures + 1
        ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(System.currentTimeMillis() + retryDelay(failures), alarmIntent(ctx))
    }

    /**
     * Called by the refresh alarm, which only queues a refresh that waits
     * for a network: the widget is redrawn now regardless, so an answer
     * past its `staleAt` dims rather than staying bright. With no network
     * it says Offline and moves on through the day plan kept for it.
     */
    suspend fun redrawWhileWaiting(ctx: Context) {
        val store = Store(ctx)
        if (store.paired && !online(ctx)) {
            store.lastError = L.s(R.string.offline)
            armOfflineRedraw(ctx, store)
        }
        redrawWidgets(ctx)
    }

    private fun online(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** Offline when a leave check fires: the last answer's time beats no heads-up. */
    private fun armFromCache(ctx: Context, store: Store) {
        store.lastAnswer()?.let { (answer, _) -> LeaveAlerts.arm(ctx, answer) }
    }

    /**
     * Offline, refreshes wait for a network, so nothing would redraw the
     * widget as its offline line moves on ("Leave by" to "Leave now", then
     * the next class). An alarm that only redraws, at the next such moment.
     */
    fun armOfflineRedraw(ctx: Context, store: Store) {
        if (widgetCount(ctx) == 0) return
        val at = OfflineDay.nextChangeAt(store.lastDay()?.first, ServerClock.now()) ?: return
        ctx.getSystemService(AlarmManager::class.java)?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, ServerClock.toDevice(at) + 1_000, redrawIntent(ctx))
    }

    private fun redrawIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, 1,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REDRAW),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** Anything on screen, or on the lock screen, that needs this chain. */
    fun active(ctx: Context): Boolean = widgetCount(ctx) > 0 || Store(ctx).let { (it.leaveAlerts || it.liveUpdates) && it.paired }

    /**
     * When this answer next needs a network refresh, on the server's clock
     * ([now] too; [fetchedAt] is when it came, on the same clock). With no
     * widget, only when the plan changes: the leave check fetches its own
     * fresh times.
     */
    fun nextRefreshAt(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean = true): Long {
        val card = answer.card
        // The server's moments, at most every 15 s: "Leave now" mustn't wait a minute.
        val server = buildList {
            answer.refreshAtMs?.let(::add)
            if (widget) {
                card?.nextChangeAtMs?.let(::add)
                card?.staleAtMs?.let(::add)
                // "Leave by" turns into "Leave now" at the leave time.
                if (answer.mode != "rest") answer.leaveAtMs?.let(::add)
            }
        }.filter { it > now }.minOrNull()?.coerceAtLeast(now + MIN_GAP_MS)
        // On the bus: at each stop, so the progress bar and the arrival move on.
        val local = card?.ride?.takeIf { widget && card.phase == "riding" }?.let { r -> RideStyle.nextRedrawAt(r, now) }?.coerceAtLeast(now + MIN_LOCAL_GAP_MS)
        return listOfNotNull(server, local).minOrNull() ?: (fetchedAt + FALLBACK_MS).coerceAtLeast(now + MIN_LOCAL_GAP_MS)
    }

    /** Arm the next refresh, and the leave alert. Only while something needs them. [fetchedAt] is on the phone's clock. */
    fun scheduleNext(ctx: Context, answer: NextAnswer, fetchedAt: Long) {
        LeaveAlerts.arm(ctx, answer)
        if (!active(ctx)) return
        val at = nextRefreshAt(answer, ServerClock.fromDevice(fetchedAt), ServerClock.now(), widget = widgetCount(ctx) > 0)
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        // Honoured in Doze (at most every ~9 min there). Without "Alarms &
        // reminders" allowed it's inexact, and the system may run it a few
        // minutes late; the widget shows a clock time, which stays true until then.
        am.setWhileIdle(ServerClock.toDevice(at), alarmIntent(ctx))
    }

    /** A refresh as soon as possible, with network. */
    fun refreshSoon(ctx: Context) {
        val work = OneTimeWorkRequestBuilder<RefreshWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, work)
    }

    fun schedule(ctx: Context) {
        if (!active(ctx)) return
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
        ctx.getSystemService(AlarmManager::class.java)?.run {
            cancel(alarmIntent(ctx))
            cancel(redrawIntent(ctx))
        }
        LeaveAlerts.cancel(ctx)
        LiveService.stop(ctx)
    }

    /** The last widget went away: stop, unless leave alerts still need the chain. */
    fun widgetsGone(ctx: Context) {
        if (active(ctx)) return
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx))
    }

    fun widgetCount(ctx: Context): Int {
        val mgr = AppWidgetManager.getInstance(ctx) ?: return 0
        return listOf(NextBusWidgetReceiver::class.java, PlacesWidgetReceiver::class.java)
            .sumOf { mgr.getAppWidgetIds(ComponentName(ctx, it)).size }
    }

    private fun alarmIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, 0,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    const val ACTION_REFRESH = "sh.rcn.terminus.REFRESH"
    const val ACTION_REDRAW = "sh.rcn.terminus.REDRAW"
}

class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Refresher.refresh(applicationContext)
        return Result.success()
    }
}

class ExtrasWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Refresher.extras(applicationContext)
        return Result.success()
    }
}

/** Retry waits after [failures] failed refreshes in a row: 1, 2, 4, 8, then 15 minutes. */
internal fun retryDelay(failures: Int): Long = (60_000L shl failures.coerceIn(0, 4)).coerceAtMost(15 * 60_000L)

/**
 * The refresh alarm, plus the system events after which the widget's
 * pre-drawn text is wrong: a reboot or app update (alarms are gone, the cache
 * is old), and a clock, timezone or locale change (times were formatted
 * before it).
 */
class RefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Refresher.ACTION_REFRESH, Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                // Boot or update: the live notification comes back if it was on.
                if (intent.action != Refresher.ACTION_REFRESH) LiveService.start(context)
                if (Refresher.active(context)) {
                    Refresher.refreshSoon(context)
                    Refresher.schedule(context)
                    finishAsync(Dispatchers.Default) { Refresher.redrawWhileWaiting(context) }
                }
            }
            // Offline: the widget's day-plan line moves on; then the next such moment.
            Refresher.ACTION_REDRAW -> finishAsync(Dispatchers.Default) {
                redrawWidgets(context)
                val store = Store(context)
                if (store.lastError != null) Refresher.armOfflineRedraw(context, store)
            }
            Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_LOCALE_CHANGED -> finishAsync(Dispatchers.Default) {
                redrawWidgets(context)
            }
        }
    }
}

/**
 * Runs [block] on [dispatcher], keeping the broadcast open (goAsync) until
 * it's done, rather than letting the process go once onReceive returns.
 */
internal fun BroadcastReceiver.finishAsync(dispatcher: CoroutineDispatcher, block: suspend () -> Unit) {
    val pending = goAsync()
    CoroutineScope(dispatcher).launch {
        try {
            block()
        } finally {
            pending.finish()
        }
    }
}
