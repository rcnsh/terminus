package sh.rcn.terminus.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.hour12
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.Push
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import java.util.concurrent.TimeUnit
import sh.rcn.terminus.R
import sh.rcn.terminus.L

/**
 * Keeping the widget true without a process running:
 *
 * - a network refresh at the moments the answer changes: 30 s after the bus
 *   leaves (so the next one appears), when the plan moves on (`refreshAt`),
 *   and when the answer reaches MAX_AGE_MS. An idle-safe alarm, not a delayed
 *   job: Doze defers jobs for hours, and a departed bus must not sit bright.
 * - a 30-minute periodic job as the floor, in case an alarm is missed.
 * - after a reboot or app update, and on a time or timezone change.
 *
 * Leave alerts (LeaveAlerts) ride on the same chain, so it also runs with no
 * widget when they are on: then only when the plan changes, plus the floor.
 */
object Refresher {
    private const val WORK = "terminus-refresh"
    private const val NOW = "terminus-refresh-now"
    /** Never refresh more often than this from the schedule, whatever the answer says. */
    private const val MIN_GAP_MS = 60_000L
    /** The day plan kept for offline is fetched again after this long. */
    private const val DAY_MAX_AGE_MS = 60 * 60_000L

    /** Fetch the planned answer, cache it, and redraw every widget. */
    suspend fun refresh(ctx: Context, fast: Boolean = false) {
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
            val json = api.nextJson(Target.Plan, loc?.latitude, loc?.longitude)
            val now = System.currentTimeMillis()
            store.saveAnswer(json, now)
            // Today's plan, kept for when the phone goes offline (OfflineDay):
            // when the one kept is another day's or an hour old.
            val kept = store.lastDay()
            if (kept == null || kept.first.date != OfflineDay.sgtDate(now) || now - kept.second > DAY_MAX_AGE_MS) {
                runCatching { store.saveDay(api.dayJson(), now) }
            }
            store.lastError = null
            scheduleNext(ctx, NextAnswer.parse(json), now)
            // Signed in with no push address sent yet (a new session, or a new Firebase token).
            if (store.pushToken == null) Push.register(ctx)
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
            }
            store.lastError = if (e.status == 401) L.s(R.string.device_removed) else e.message
        } catch (e: ParseError) {
            store.lastError = L.s(R.string.unexpected_answer)
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Replaced by a newer refresh (refreshSoon): not offline, nothing to record.
            throw e
        } catch (e: Exception) {
            store.lastError = L.s(R.string.offline)
            armFromCache(ctx, store)
            armOfflineRedraw(ctx, store)
        }
        // Widgets showing a place or Nearby (phase 8.3) keep counting down too.
        runCatching { WidgetModes.refreshChosen(ctx) }
        redrawWidgets(ctx)
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
        val at = OfflineDay.nextChangeAt(store.lastDay()?.first, System.currentTimeMillis()) ?: return
        ctx.getSystemService(AlarmManager::class.java)?.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at + 1_000, redrawIntent(ctx))
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
     * When this answer next needs a network refresh. With no widget, only
     * when the plan changes: the leave check fetches its own fresh times.
     */
    fun nextRefreshAt(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean = true): Long {
        val marks = buildList {
            answer.refreshAtMs?.let(::add)
            // A rest answer holds until the day starts; it does not age.
            if (widget && answer.mode != "rest") {
                answer.departsAtMs?.let { add(it + DEPARTED_GRACE_MS + 1_000) }
                // "Leave by" turns into "Leave now" at the leave time.
                answer.leaveAtMs?.let { if (it > now) add(it) }
                // On the bus: at each stop, so the progress bar and the arrival move on.
                answer.card?.ride?.takeIf { answer.card.phase == "riding" }?.let { r -> sh.rcn.terminus.RideStyle.nextRedrawAt(r, now)?.let(::add) }
                add(fetchedAt + MAX_AGE_MS)
            }
        }
        return (marks.minOrNull() ?: (fetchedAt + MAX_AGE_MS)).coerceAtLeast(now + MIN_GAP_MS)
    }

    /** Arm the next refresh, and the leave alert. Only while something needs them. */
    fun scheduleNext(ctx: Context, answer: NextAnswer, fetchedAt: Long) {
        LeaveAlerts.arm(ctx, answer)
        if (!active(ctx)) return
        val at = nextRefreshAt(answer, fetchedAt, System.currentTimeMillis(), widget = widgetCount(ctx) > 0)
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        // Honoured in Doze (at most every ~9 min there) and needs no exact-alarm
        // permission. The system may run it a few minutes late; the widget
        // shows a clock time, which stays true until then.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent(ctx))
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
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx))
        ctx.getSystemService(AlarmManager::class.java)?.cancel(redrawIntent(ctx))
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
            android.app.AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                // Boot or update: the live notification comes back if it was on.
                if (intent.action != Refresher.ACTION_REFRESH) LiveService.start(context)
                if (Refresher.active(context)) {
                    Refresher.refreshSoon(context)
                    Refresher.schedule(context)
                }
            }
            Refresher.ACTION_REDRAW -> {
                // Offline: the widget's day-plan line moves on; then the next such moment.
                val pending = goAsync()
                CoroutineScope(Dispatchers.Default).launch {
                    try {
                        redrawWidgets(context)
                        val store = Store(context)
                        if (store.lastError != null) Refresher.armOfflineRedraw(context, store)
                    } finally {
                        pending.finish()
                    }
                }
            }
            Intent.ACTION_TIME_CHANGED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_LOCALE_CHANGED -> {
                val pending = goAsync()
                CoroutineScope(Dispatchers.Default).launch {
                    try {
                        redrawWidgets(context)
                    } finally {
                        pending.finish()
                    }
                }
            }
        }
    }
}
