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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeoutOrNull
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
import sh.rcn.terminus.Quiet
import sh.rcn.terminus.Session
import sh.rcn.terminus.UpdateRequired
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
 *   when the card changes (`card.nextChangeAt`: the bus leaves, the trip's
 *   next phase, going stale) and when the plan moves on (`refreshAt`). An
 *   idle-safe alarm, not a delayed job: Doze defers jobs for hours, and a
 *   departed bus must not sit bright. The alarm fetches there and then,
 *   with a job only when there's no network.
 * - a redraw, with no request, at the moments the widget changes by itself:
 *   "Leave by" turning into "Leave now", the next stop on the ride, an
 *   answer going stale and dimming (redrawAt). The server keeps a late
 *   bus's sliding leave-by out of `nextChangeAt` until it's 30 s ahead, so
 *   fetching at it would ask every few seconds.
 * - an hourly periodic job as the floor, in case an alarm is missed; it
 *   only redraws while the answer is fresh and the next alarm is armed.
 * - after a failed refresh, again with a back-off (1, 2, 4, 8, then every
 *   15 min) rather than waiting for the floor, which Doze stretches.
 * - after a reboot or app update, and on a time or timezone change.
 *
 * Leave alerts (LeaveAlerts) ride on the same chain, so it also runs with no
 * widget when they are on: then only when the plan changes, plus the floor.
 */
object Refresher {
    private const val WORK = "terminus-refresh-floor"
    /** The floor's name before it only redrew while on track: cancelled after an update. */
    private const val WORK_BEFORE = "terminus-refresh"
    private const val NOW = "terminus-refresh-now"
    /** Never refresh sooner than this after the last, at a moment the server gave. */
    private const val MIN_GAP_MS = 15_000L
    /** With no moment from the server, never sooner than this. */
    private const val MIN_LOCAL_GAP_MS = 60_000L
    /** An answer fetched this recently (by another refresh, the app, the live notification) isn't asked for again. */
    private const val RECENT_MS = 15_000L
    /** With no moment from the server at all (an answer kept from an older version). */
    private const val FALLBACK_MS = 15 * 60_000L
    /** The day plan kept for offline is fetched again after this long. */
    private const val DAY_MAX_AGE_MS = 60 * 60_000L
    private const val EXTRAS = "terminus-refresh-extras"

    /**
     * One request for the answer at a time in this process: a second waits,
     * then finds the first's answer fresh. Held only for /me/next, not for
     * the day plan or the chosen widgets that follow it.
     */
    private val running = Mutex()
    /**
     * How long a [refresh] with seconds to spare (a push, an alarm, a tap)
     * waits for one in flight before asking itself, so its own deadline
     * still bounds it.
     */
    private const val FAST_WAIT_MS = 1_000L

    /**
     * Fetch the planned answer, cache it, and redraw every widget. With
     * [extras] off (a push or an alarm, whose handler has seconds; a tap),
     * only the answer: today's plan for offline and the widgets showing a
     * place or Nearby follow in a job (ExtrasWorker), when they need it.
     * An answer fetched in the last [RECENT_MS] is used as it is, unless
     * [force] (a push: the card changed since). Returns the fresh answer,
     * or null when there's none (signed out, offline, refused).
     */
    suspend fun refresh(ctx: Context, fast: Boolean = false, extras: Boolean = true, force: Boolean = false): NextAnswer? {
        // Set inside the block: a timeout just after lock() returns still unlocks below.
        var locked = false
        if (fast) withTimeoutOrNull(FAST_WAIT_MS) { running.lock(); locked = true } else { running.lock(); locked = true }
        val (answer, more) = try {
            refreshNow(ctx, fast, extras, force)
        } finally {
            if (locked) running.unlock()
        }
        // The day plan and the chosen widgets, once the lock is free: their
        // requests don't hold up a push or an alarm waiting for the answer.
        if (more) extras(ctx)
        return answer
    }

    /** The answer (null when there's none), and whether [extras] is to run now. */
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
                // As a fresh answer would: a leave check that lands here still posts or re-arms.
                scheduleNext(ctx, recent.first, recent.second)
                redrawWidgets(ctx)
                return recent.first to false
            }
        }
        var fresh: NextAnswer? = null
        // Android gives the background no location (the app doesn't ask for
        // "Allow all the time"), so this is a fix only while the app is open.
        // Without one, the API follows the timetable and the trip's state.
        val loc = Locator.lastKnown(ctx)
        try {
            val api = Api(token, fast, hour12(ctx))
            val asked = System.currentTimeMillis()
            val json = api.nextJson(Target.Plan, loc?.latitude, loc?.longitude, Locator.accOf(loc))
            val now = System.currentTimeMillis()
            // Read before it's kept: one this version can't read leaves the last
            // good one, and one overtaken by a newer answer gives way to it.
            // Signed out while it was out: the old account's, so none of it is kept.
            val answer = store.saveAnswer(json, now, sentWith = token, askedAtMs = asked) ?: return null to false
            fresh = answer
            store.lastError = null
            scheduleNext(ctx, answer, now)
            // No push address sent for this session yet (a new session, or a
            // new Firebase token), not sent again for a while (Push.due), or
            // one to take back (alerts off, or notifications blocked).
            if (Push.stale(ctx)) Push.sync(ctx)
        } catch (e: UpdateRequired) {
            // Not tried again: nothing changes until the app is updated (Outdated holds requests for hours).
            store.lastError = e.message
            armFromCache(ctx, store)
            armRedraw(ctx, store)
        } catch (e: ApiError) {
            if (e.status == 401) {
                // Signed out everywhere on this phone, the widget saying why;
                // unless the token was replaced meanwhile (signed in again).
                if (!Session.rejected(ctx, token)) return null to false
            } else {
                store.lastError = e.message
                failed(ctx, store)
            }
        } catch (e: ParseError) {
            store.lastError = L.s(R.string.unexpected_answer)
            failed(ctx, store)
        } catch (e: kotlinx.coroutines.CancellationException) {
            // Stopped (the job or the broadcast ran out of time): not offline, nothing to record.
            throw e
        } catch (e: Exception) {
            store.lastError = L.s(R.string.offline)
            failed(ctx, store)
        }
        // Widgets showing a place or Nearby keep counting down too; not after
        // a failure, which they would only repeat once each. With [extras],
        // the caller runs them (and redraws) once the lock is free.
        if (fresh != null && extras) return fresh to true
        if (fresh != null && extrasDue(ctx, store)) queueExtras(ctx)
        WidgetModes.armChosen(ctx)
        redrawWidgets(ctx)
        return fresh to false
    }

    /** A failed refresh: the cached answer's heads-up, a redraw at its moments, and a retry. */
    private fun failed(ctx: Context, store: Store) {
        armFromCache(ctx, store)
        val retry = retryLater(ctx, store)
        armRedraw(ctx, store, before = retry)
    }

    /** [WidgetModes.refreshChosen], whose failures are its widgets' to show. */
    internal suspend fun chosen(ctx: Context, staleOnly: Boolean = false) {
        try {
            WidgetModes.refreshChosen(ctx, staleOnly)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // Each widget keeps what it showed.
        }
    }

    /** The day plan kept for offline is another day's, an hour old, or missing. */
    private fun dayDue(store: Store, now: Long): Boolean {
        val at = store.dayFetchedAt
        return at == 0L || now - at > DAY_MAX_AGE_MS || store.lastDay()?.first?.date != OfflineDay.sgtDate(now)
    }

    /** Whether a job for [extras] would do anything: else it would only redraw every widget again. */
    private suspend fun extrasDue(ctx: Context, store: Store): Boolean =
        dayDue(store, System.currentTimeMillis()) || WidgetModes.anyDue(ctx)

    /**
     * Today's plan, kept for when the phone goes offline (OfflineDay): when
     * the one kept is another day's or an hour old.
     */
    private suspend fun keepDay(token: String, api: Api, store: Store, loc: android.location.Location?, now: Long) {
        if (dayDue(store, now)) {
            try {
                // Not kept when [token] has been signed out meanwhile.
                store.saveDay(api.dayJson(loc?.latitude, loc?.longitude, Locator.accOf(loc)), now, sentWith = token)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // Kept as it was: offline, or a plan this version can't read.
            }
        }
    }

    /** What [refresh] leaves out without [extras], run once there's time and a network. */
    suspend fun extras(ctx: Context) {
        val store = Store(ctx)
        val token = store.token ?: return
        val loc = Locator.lastKnown(ctx)
        keepDay(token, Api(token, hour12 = hour12(ctx)), store, loc, System.currentTimeMillis())
        chosen(ctx)
        WidgetModes.armChosen(ctx)
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
     * refresh alarm, rather than at the floor: the widget and the leave
     * alerts would otherwise go quiet until then. Offline, the alarm only
     * redraws until a network is back (RefreshReceiver). This alarm
     * replaces the one [scheduleNext] set; what the widget shows meanwhile
     * ("Leave now", the next stop, dimming) moves on by the redraw alarm.
     * Returns when, on the phone's clock (null: nothing needs the chain).
     */
    private fun retryLater(ctx: Context, store: Store): Long? {
        if (!active(ctx)) return null
        val failures = store.refreshFailures
        store.refreshFailures = failures + 1
        val at = retryAt(System.currentTimeMillis(), failures, Quiet.waitMs())
        // Waking the phone only for the leave alerts and the live notification.
        ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(at, alarmIntent(ctx), wake = notifying(ctx, store))
        store.refreshAlarmAt = at
        return at
    }

    /**
     * Called by the refresh alarm when it queues a refresh that waits for a
     * network: the widget is redrawn now regardless, so an answer past its
     * `staleAt` dims rather than staying bright. With no network it says
     * Offline and moves on through the day plan kept for it.
     */
    suspend fun redrawWhileWaiting(ctx: Context) {
        val store = Store(ctx)
        if (store.paired && !online(ctx)) store.lastError = L.s(R.string.offline)
        armRedraw(ctx, store)
        redrawWidgets(ctx)
    }

    internal fun online(ctx: Context): Boolean {
        val cm = ctx.getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** Offline when a leave check fires: the last answer's time beats no heads-up. */
    fun armFromCache(ctx: Context, store: Store = Store(ctx)) {
        store.lastAnswer()?.let { (answer, _) -> LeaveAlerts.arm(ctx, answer) }
    }

    /**
     * An alarm that only redraws, at the next moment the widget looks
     * different with no new answer: [answer]'s own ("Leave now", the next
     * stop on the ride, going stale), and while refreshes are failing the
     * offline line moving on through the day plan (the next class). Only
     * moments before [before] (the refresh alarm, phone's clock), which
     * redraws anyway and arms the next.
     */
    fun armRedraw(ctx: Context, store: Store, answer: NextAnswer? = store.lastAnswer()?.first, before: Long? = null) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        if (widgetCount(ctx) == 0) return
        val now = ServerClock.now()
        val day = if (store.lastError != null) OfflineDay.nextChangeAt(store.lastDay()?.first, now) else null
        val at = listOfNotNull(answer?.let { redrawAt(it, now) }, day).minOrNull()?.let { ServerClock.toDevice(it) + 1_000 }
        if (at == null || (before != null && at >= before)) am.cancel(redrawIntent(ctx))
        // Only the widget looks: it can wait for the screen to come on.
        else am.setWhileIdle(at, redrawIntent(ctx), wake = false)
    }

    private fun redrawIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, 1,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REDRAW),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * Anything on screen, or on the lock screen, that needs this chain: a
     * widget, or a leave alert or live notification that can be seen.
     */
    fun active(ctx: Context): Boolean = Store(ctx).let {
        // Signed out, a widget only says so: nothing to fetch for it.
        it.paired && (widgetCount(ctx) > 0 || notifying(ctx, it))
    }

    /** The leave alerts or the live notification are on and can show: the refresh may wake the phone for them. */
    private fun notifying(ctx: Context, store: Store): Boolean =
        (store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)) || (store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL))

    /**
     * The refresh alarms for [answer] (server clock, as [nextRefreshAt]):
     * the widget's ([widget]), which doesn't wake the phone, and, for the
     * leave alerts and the live notification ([notifying]), one at the
     * server's own moments that does. Only the waking one when it comes
     * first: it refreshes the widget too. Null: none of that kind.
     */
    internal fun refreshAlarms(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean, notifying: Boolean): Pair<Long?, Long?> {
        val wakeAt = if (notifying) nextRefreshAt(answer, fetchedAt, now, widget = false) else null
        val at = if (widget) nextRefreshAt(answer, fetchedAt, now, widget = true) else null
        return (if (at != null && wakeAt != null && wakeAt <= at) null else at) to wakeAt
    }

    /**
     * When this answer next needs a network refresh, on the server's clock
     * ([now] too; [fetchedAt] is when it came, on the same clock). With no
     * widget, only when the plan changes: the leave check fetches its own
     * fresh times.
     */
    fun nextRefreshAt(answer: NextAnswer, fetchedAt: Long, now: Long, widget: Boolean = true): Long =
        serverRefreshAt(answer, now, widget) ?: (fetchedAt + FALLBACK_MS).coerceAtLeast(now + MIN_LOCAL_GAP_MS)

    /**
     * The next of the server's own moments for a refresh, at most every
     * 15 s; null when none is ahead. The card's `nextChangeAt` already
     * counts its `staleAt`, and its leave-by only from 30 s ahead; `staleAt`
     * stands in for it from a server without it. Moments the widget can
     * draw by itself ("Leave now", a ride's next stop) are [redrawAt]'s.
     */
    internal fun serverRefreshAt(answer: NextAnswer, now: Long, widget: Boolean = true): Long? {
        val card = answer.card
        return listOfNotNull(answer.refreshAtMs, if (widget) card?.nextChangeAtMs ?: card?.staleAtMs else null)
            .filter { it > now }.minOrNull()?.coerceAtLeast(now + MIN_GAP_MS)
    }

    /**
     * Whether the floor job can leave the network alone: no refresh failing,
     * the answer not past its `staleAt`, and the refresh alarm armed for
     * later ([alarmAt]; all on the server's clock).
     */
    internal fun onTrack(answer: NextAnswer?, error: String?, alarmAt: Long, now: Long): Boolean =
        answer != null && error == null && !isOld(answer, now) && alarmAt > now

    /**
     * When a widget showing [answer] next looks different with no new
     * answer (server clock): its card changing or going stale, "Leave by"
     * turning into "Leave now", or the next stop on the ride.
     */
    internal fun redrawAt(answer: NextAnswer, now: Long): Long? {
        val card = answer.card
        val ride = card?.ride?.takeIf { card.phase == "riding" }?.let { RideStyle.nextRedrawAt(it, now) }
        val leave = answer.leaveAtMs?.takeIf { answer.mode != "rest" }
        return listOfNotNull(card?.nextChangeAtMs, card?.staleAtMs, leave, ride).filter { it > now }.minOrNull()
    }

    /** Arm the next refresh, the redraws before it, and the leave alert. Only while something needs them. [fetchedAt] is on the phone's clock. */
    fun scheduleNext(ctx: Context, answer: NextAnswer, fetchedAt: Long) {
        LeaveAlerts.arm(ctx, answer)
        if (!active(ctx)) return
        val widget = widgetCount(ctx) > 0
        val store = Store(ctx)
        val (widgetAt, wakeAt) = refreshAlarms(answer, ServerClock.fromDevice(fetchedAt), ServerClock.now(), widget, notifying(ctx, store))
            .let { (a, b) -> a?.let(ServerClock::toDevice) to b?.let(ServerClock::toDevice) }
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        // Honoured in Doze (at most every ~9 min there). Without "Alarms &
        // reminders" allowed it's inexact, and the system may run it a few
        // minutes late; the widget shows a clock time, which stays true until then.
        if (widgetAt != null) am.setWhileIdle(widgetAt, alarmIntent(ctx), wake = false) else am.cancel(alarmIntent(ctx))
        if (wakeAt != null) am.setWhileIdle(wakeAt, wakeIntent(ctx)) else am.cancel(wakeIntent(ctx))
        val at = listOfNotNull(widgetAt, wakeAt).min()
        store.refreshAlarmAt = at
        if (widget) armRedraw(ctx, store, answer, before = at)
    }

    /** A refresh as soon as possible, with network; one already waiting or running stands. */
    fun refreshSoon(ctx: Context) {
        val work = OneTimeWorkRequestBuilder<RefreshWorker>()
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(NOW, ExistingWorkPolicy.KEEP, work)
    }

    fun schedule(ctx: Context) {
        if (!active(ctx)) return
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(60, TimeUnit.MINUTES)
            .setInputData(workDataOf(RefreshWorker.FLOOR to true))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** After an app update: the floor kept under its old name fetched every 30 minutes, whatever. */
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
        }
        Store(ctx).refreshAlarmAt = 0
        LeaveAlerts.cancel(ctx)
        LiveService.stop(ctx)
    }

    /** The last widget went away: its redraws stop, and the chain too unless leave alerts still need it. */
    fun widgetsGone(ctx: Context) {
        ctx.getSystemService(AlarmManager::class.java)?.run {
            cancel(redrawIntent(ctx))
            cancel(WidgetModes.alarmIntent(ctx))
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
        return listOf(NextBusWidgetReceiver::class.java, PlacesWidgetReceiver::class.java)
            .sumOf { mgr.getAppWidgetIds(ComponentName(ctx, it)).size }
    }

    private fun alarmIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, 0,
            Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REFRESH),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /** The refresh that wakes the phone ([refreshAlarms]): the same refresh, its own alarm. */
    private fun wakeIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, 9,
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
        // The floor, with the answer fresh and its alarm armed: nothing to ask the
        // network (overnight, a rest card's alarm is the morning). A redraw at most.
        val now = ServerClock.now()
        if (inputData.getBoolean(FLOOR, false) &&
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

/** Retry waits after [failures] failed refreshes in a row: 1, 2, 4, 8, then 15 minutes. */
internal fun retryDelay(failures: Int): Long = (60_000L shl failures.coerceIn(0, 4)).coerceAtMost(15 * 60_000L)

/**
 * When to try again after [failures] failed refreshes, from [now]: the
 * back-off, and never before a 429's or a 503's wait ([quietMs]) is up,
 * when the request would only be refused here.
 */
internal fun retryAt(now: Long, failures: Int, quietMs: Long): Long = now + maxOf(retryDelay(failures), quietMs)

/**
 * The refresh alarm, plus the system events after which the widget's
 * pre-drawn text is wrong: a reboot or app update (alarms are gone, the cache
 * is old), and a clock, timezone or locale change (times were formatted
 * before it). Also notifications blocked or allowed again in the phone's
 * settings: the alerts, the live notification and push follow.
 */
class RefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Refresher.ACTION_REFRESH, Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED,
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> {
                val store = Store(context)
                // Mid-trip (the process may have died with the live notification):
                // an exact alarm is a moment Android lets it start. Boot or
                // update: it comes back if it was on, and stops if there's no trip.
                val alarm = intent.action == Refresher.ACTION_REFRESH
                val trip = store.lastAnswer()?.first?.card?.phase in LiveService.TRIP_PHASES
                val live = (!alarm || trip) && LiveService.start(context)
                if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) Refresher.dropOldFloor(context)
                if (Refresher.active(context)) {
                    // Alarms are gone after a reboot or update: the cached answer's
                    // heads-up is armed now, in case the refresh waits for a network.
                    if (!alarm) Refresher.armFromCache(context, store)
                    Refresher.schedule(context)
                    when {
                        // The live notification fetches the answer itself.
                        live -> finishAsync(Dispatchers.Default) { Refresher.redrawWhileWaiting(context) }
                        // Fetched right here, as the leave check is: the alarm's idle
                        // allowance is seconds long, and a queued job may wait for
                        // hours once Android's quota for prompt jobs runs out. Only
                        // /me/next here; the rest follows in a job when it's needed.
                        alarm && Refresher.online(context) -> finishAsync(Dispatchers.IO) {
                            Refresher.refresh(context, fast = true, extras = false)
                        }
                        // No network (or just booted): a job that waits for one.
                        else -> {
                            Refresher.refreshSoon(context)
                            finishAsync(Dispatchers.Default) { Refresher.redrawWhileWaiting(context) }
                        }
                    }
                }
            }
            // "Leave now", the next stop on the ride, an answer going stale, the
            // offline day-plan line moving on: redrawn, then the next such moment.
            Refresher.ACTION_REDRAW -> finishAsync(Dispatchers.Default) {
                redrawWidgets(context)
                val store = Store(context)
                Refresher.armRedraw(context, store, before = store.refreshAlarmAt.takeIf { it > System.currentTimeMillis() })
            }
            // A widget showing a place or Nearby: redrawn as its times age, a
            // place's answer fetched again once it's stale; then its next moment.
            Refresher.ACTION_REDRAW_CHOSEN -> finishAsync(Dispatchers.IO) {
                if (Store(context).paired && Refresher.online(context)) Refresher.chosen(context, staleOnly = true)
                redrawWidgets(context)
                WidgetModes.armChosen(context)
            }
            // The clock moved: how far it is from the server's is learnt again
            // from a fresh answer, which re-arms the alarms by it.
            Intent.ACTION_TIME_CHANGED -> {
                if (Refresher.active(context)) Refresher.refreshSoon(context)
                finishAsync(Dispatchers.Default) { redrawWidgets(context) }
            }
            Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_LOCALE_CHANGED -> finishAsync(Dispatchers.Default) {
                redrawWidgets(context)
            }
            NotificationManager.ACTION_APP_BLOCK_STATE_CHANGED, NotificationManager.ACTION_NOTIFICATION_CHANNEL_BLOCK_STATE_CHANGED -> {
                Push.sync(context)
                if (Refresher.active(context)) {
                    Refresher.schedule(context)
                    // Re-arms (or stops) the leave alerts by the new state.
                    Refresher.refreshSoon(context)
                    if (LeaveAlerts.canNotify(context, LiveService.CHANNEL)) LiveService.start(context) else LiveService.stop(context)
                } else {
                    Refresher.cancel(context)
                }
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
