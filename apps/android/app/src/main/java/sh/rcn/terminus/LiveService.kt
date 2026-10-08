package sh.rcn.terminus

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.IBinder
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.isOld
import sh.rcn.terminus.widget.redrawWidgets

/**
 * The live notification: during a trip, from "time to go" until you're there
 * (phase 3), a silent ongoing notification with the next bus and a ticking
 * countdown, refreshed every 30 s (2 min with the screen off), and the
 * widgets redrawn with it.
 *
 * Between trips it stops itself, and starts again when the next trip is due:
 * from a high-priority push ("due", "missed"), or an exact alarm (its own, a
 * refresh's or a leave check's). Other pushes come at normal priority, which
 * Android doesn't let start it. The API's 15 s per-stop cache means this
 * costs NUS nothing more than having the app open.
 */
class LiveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    /** Only touched on the main thread, as onStartCommand is. */
    private var loop: Job? = null
    /** The latest start, and the one the loop last acted on: a start that comes as the loop ends isn't lost. */
    @Volatile private var lastStartId = 0
    @Volatile private var handledStartId = 0
    /** A start while the loop runs (a push: the card changed) fetches now rather than at the next turn. */
    private val wake = Channel<Unit>(Channel.CONFLATED)
    /** A push said the card changed: the next turn fetches, however new the kept answer. */
    @Volatile private var force = false
    /** Following the trip by location ("Notice when I board"), when a tap started it. */
    @Volatile private var watch: TripWatch? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Store(this).liveUpdates = false
            getSystemService(AlarmManager::class.java)?.cancel(startIntent(this))
            stopForeground(STOP_FOREGROUND_REMOVE)
            // Turned off from the notification: the widget's refresh button returns.
            val app = applicationContext
            CoroutineScope(Dispatchers.Default).launch { redrawWidgets(app) }
            stopSelf()
            return START_NOT_STICKY
        }
        lastStartId = startId
        if (intent?.getBooleanExtra(EXTRA_FORCE, false) == true) force = true
        // Must be in the foreground within seconds of starting, before any fetch.
        val store = Store(this)
        val cached = store.lastAnswer()
        val wantWatch = when (intent?.action) {
            ACTION_UNWATCH -> false
            ACTION_WATCH -> true
            else -> watch != null
        } && store.detectTrips && Locator.hasPrecise(this)
        if (!wantWatch) stopWatching()
        // The location type only when a tap started this (the app, the
        // notification, the widget): from an alarm or a push Android refuses it.
        // On Android 12 and 13 the plain startForeground (foreground() with no
        // type) takes every type in the manifest, location included; started
        // from the background it simply gets no location there.
        val watching = wantWatch && runCatching { foreground(cached?.first, location = true) }.isSuccess
        // Restarted by the system after it stopped the app (START_STICKY), Android
        // can refuse a foreground service at all: then stop, rather than crash.
        if (!watching && runCatching { foreground(cached?.first, location = false) }.isFailure) {
            stopSelf()
            return START_NOT_STICKY
        }
        // Notifications or this channel turned off: a notification nobody
        // can see isn't worth a request every 30 s. (In the foreground first
        // all the same: a started service that isn't crashes the app.)
        if (!LeaveAlerts.canNotify(this, CHANNEL)) {
            stopWatching()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (watching && watch == null) watch = TripWatch(this).takeIf { it.start() }
        if (loop?.isActive != true) loop = scope.launch { run() } else wake.trySend(Unit)
        return START_STICKY
    }

    private fun foreground(answer: NextAnswer?, location: Boolean) {
        val n = build(this, answer, watching = location)
        var type = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        if (location) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        // The special-use type exists from Android 14; before that the plain call.
        if (type == 0) startForeground(NOTIFICATION_ID, n) else startForeground(NOTIFICATION_ID, n, type)
    }

    private fun stopWatching() {
        watch?.stop()
        watch = null
    }

    /** Sends the latest fix as a location signal (the server works out the trip from it); false when there's none. */
    private suspend fun sendFix(store: Store): Boolean {
        val fix = watch?.fix(System.currentTimeMillis()) ?: return false
        val token = store.token ?: return false
        return try {
            val json = Api(token, fast = true, hour12 = hour12(this)).signal("location", null, fix.lat, fix.lon, fix.speedMs, fix.accM)
            val now = System.currentTimeMillis()
            // Read before it's kept (a ParseError lands below): the last good answer stays.
            val answer = store.saveAnswer(json, now)
            store.lastError = null
            Refresher.scheduleNext(this, answer, now)
            redrawWidgets(this)
            true
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401) Session.rejected(this, token)
            false
        } catch (e: Exception) {
            false
        }
    }

    private suspend fun run() {
        val store = Store(this)
        val nm = getSystemService(NotificationManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        // Failed refreshes in a row: the next one waits longer (offline, the server failing).
        var failures = 0
        while (scope.isActive) {
            handledStartId = lastStartId
            val pushed = force.also { force = false }
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(this, CHANNEL)) break
            // An answer fetched a moment ago (the leave check that started this)
            // isn't asked for again; after a push it is: the card changed since.
            val fresh = !pushed && store.lastAnswer()?.second?.let { System.currentTimeMillis() - it in 0 until FRESH_MS } == true
            if (!sendFix(store) && !fresh) {
                if (Refresher.refresh(this, force = pushed) != null) failures = 0 else failures++
            }
            // Refused as too old: no more asking until the app is updated.
            if (Outdated.holding() || !store.paired) break
            val answer = store.lastAnswer()?.first
            if (answer == null || answer.mode == "rest" || answer.card?.phase !in TRIP_PHASES) {
                // Between trips: come back when the next one is due, the card changes (a
                // trip that isn't a class has no remindAt), or the plan changes.
                val now = ServerClock.now()
                listOfNotNull(answer?.card?.remindAtMs, answer?.card?.nextChangeAtMs, answer?.refreshAtMs)
                    .filter { it > now }
                    .minOrNull()
                    ?.let { wakeAt(this, ServerClock.toDevice(it)) }
                break
            }
            nm?.notify(NOTIFICATION_ID, build(this, answer, watching = watch != null))
            // Following by location: every fix counts, screen on or off.
            // Never sooner than a 429's or a 503's Retry-After, nor than the back-off.
            val every = if (watch != null) WATCH_MS else if (power?.isInteractive != false) SCREEN_ON_MS else SCREEN_OFF_MS
            val wait = maxOf(every, liveBackoffMs(failures), Quiet.waitMs())
            // The header's countdown runs on past zero ("-1:20") until it's
            // rebuilt: rebuilt just after it ends, without a fetch.
            val end = countdownAt(answer)?.let { it - ServerClock.now() + 1_000 }?.takeIf { it in 1 until wait }
            if (end != null) {
                if (pause(end)) continue
                nm?.notify(NOTIFICATION_ID, build(this, store.lastAnswer()?.first ?: answer, watching = watch != null))
                pause(wait - end)
            } else {
                pause(wait)
            }
        }
        // Decided on the main thread, where starts arrive: one that came
        // after the loop last looked runs it again rather than being dropped.
        withContext(Dispatchers.Main) {
            if (lastStartId != handledStartId && scope.isActive) {
                loop = scope.launch { run() }
            } else {
                stopWatching()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelfResult(handledStartId)
            }
        }
    }

    /** Waits [ms], or until a new start wakes it: true when woken. */
    private suspend fun pause(ms: Long): Boolean = withTimeoutOrNull(ms) { wake.receive() } != null

    override fun onDestroy() {
        stopWatching()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "live"
        private const val NOTIFICATION_ID = 2
        private const val SCREEN_ON_MS = 30_000L
        private const val SCREEN_OFF_MS = 120_000L
        /** A location to the server this often while following a trip. */
        private const val WATCH_MS = 20_000L
        /** An answer this new is used as it is when the loop starts. */
        private const val FRESH_MS = 10_000L
        const val ACTION_STOP = "sh.rcn.terminus.LIVE_STOP"
        const val ACTION_START = "sh.rcn.terminus.LIVE_START"
        const val ACTION_WATCH = "sh.rcn.terminus.LIVE_WATCH"
        const val ACTION_UNWATCH = "sh.rcn.terminus.LIVE_UNWATCH"
        /** Started by a push: the card changed, so the answer is fetched even if just kept. */
        private const val EXTRA_FORCE = "force"
        /** From "time to go" until you're there. */
        val TRIP_PHASES = setOf("due", "heading", "waiting", "riding", "missed")

        /**
         * Starts the live notification when it's on and can be seen. False when
         * it isn't, or Android refused the start (from the background, outside
         * the moments it allows: a high-priority push, an exact alarm, boot).
         * [force] (a push) fetches at once, past the answer kept a moment ago.
         */
        fun start(ctx: Context, force: Boolean = false): Boolean {
            val store = Store(ctx)
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx, CHANNEL)) return false
            val intent = Intent(ctx, LiveService::class.java).putExtra(EXTRA_FORCE, force)
            return runCatching { ctx.startForegroundService(intent) }.isSuccess
        }

        /**
         * Starts (or upgrades) the live notification to follow the trip by
         * location. Only from a tap: the app coming to the front, a button on
         * the notification or the widget. Android lets a foreground service
         * take the location then, and not from an alarm or a push.
         */
        fun watch(ctx: Context) {
            val store = Store(ctx)
            if (!store.detectTrips || !store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx, CHANNEL) || !Locator.hasPrecise(ctx)) return
            if (store.lastAnswer()?.first?.card?.phase !in TRIP_PHASES) return
            runCatching { ctx.startForegroundService(Intent(ctx, LiveService::class.java).setAction(ACTION_WATCH)) }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, LiveService::class.java))
            ctx.getSystemService(AlarmManager::class.java)?.cancel(startIntent(ctx))
        }

        /**
         * Exact, so the service may start from the background: an app allowed
         * SCHEDULE_EXACT_ALARM may when its exact alarm fires. Without it the
         * start is refused; a high-priority push ("due", "missed") starts it
         * then, or opening the app. A normal-priority one (heading, waiting,
         * riding) can't.
         */
        private fun wakeAt(ctx: Context, at: Long) {
            ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(at, startIntent(ctx))
        }

        private fun startIntent(ctx: Context): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, 3, Intent(ctx, LiveReceiver::class.java).setAction(ACTION_START),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        /** What the header counts down to: getting off, leaving for a class, or the bus. */
        private fun countdownAt(answer: NextAnswer): Long? {
            val card = answer.card
            return when {
                card?.phase == "riding" && card.ride != null -> card.ride.arriveMs
                answer.isClassPlan -> answer.leaveAtMs
                else -> answer.departsAtMs?.takeIf { answer.quality != "unknown" }
            }
        }

        private fun build(ctx: Context, answer: NextAnswer?, watching: Boolean = false): Notification {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(
                NotificationChannel(CHANNEL, L.s(R.string.channel_live), NotificationManager.IMPORTANCE_LOW).apply {
                    description = L.s(R.string.channel_live_desc)
                    setShowBadge(false)
                },
            )
            val now = ServerClock.now()
            val open = PendingIntent.getActivity(
                ctx, 0, MainActivity.intentFor(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val stop = PendingIntent.getService(
                ctx, 4, Intent(ctx, LiveService::class.java).setAction(ACTION_STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val b = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .setCategory(Notification.CATEGORY_STATUS)
            b.addAction(Notification.Action.Builder(null, L.s(R.string.turn_off), stop).build())
            // "Notice when I board": on while following, offered while not (a tap is what lets it start).
            if (Store(ctx).detectTrips && Locator.hasPrecise(ctx)) {
                val action = if (watching) ACTION_UNWATCH else ACTION_WATCH
                val pi = PendingIntent.getForegroundService(
                    ctx, if (watching) 6 else 7, Intent(ctx, LiveService::class.java).setAction(action),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                b.addAction(Notification.Action.Builder(null, if (watching) L.s(R.string.stop_following) else L.s(R.string.follow_trip), pi).build())
            }
            if (answer == null) return b.setContentTitle("terminus").setContentText(L.s(R.string.checking)).build()
            // During a trip, a Live Update (Android 16 QPR1, API 36.1): kept at
            // the top of the shade and on the lock screen, with the card's
            // glance ("Off 9:52") as the chip in the status bar.
            val card = answer.card
            val fmt = { ms: Long -> clock(ctx, ms) }
            // Past its staleAt with no fresh answer (offline, or the server
            // failing): the bus may be long gone. No countdown then, and said so.
            val unconfirmed = if (isOld(answer, now)) Store(ctx).lastAnswer()?.second?.let { L.s(R.string.unconfirmed_checked, fmt(it)) } else null
            // SDK_INT_FULL only exists from API 36: reading it on 12-15 throws, so check SDK_INT first.
            if (android.os.Build.VERSION.SDK_INT >= 36 && android.os.Build.VERSION.SDK_INT_FULL >= android.os.Build.VERSION_CODES_FULL.BAKLAVA_1 && card?.phase in TRIP_PHASES) {
                b.setRequestPromotedOngoing(true)
                if (unconfirmed == null) card?.glance?.let { b.setShortCriticalText(it) }
            }
            // On the bus: the ride, stop by stop (RideStyle).
            val ride = card?.ride
            if (card != null && card.phase == "riding" && ride != null) {
                b.setSubText(answer.destLabel)
                RideStyle.apply(ctx, b, card, ride, now)
                // The stops are the clock's estimate either way; unconfirmed, it says so.
                if (unconfirmed != null) b.setContentText(listOf(unconfirmed, ride.nextText(now)).joinToString(" · "))
                return b.build()
            }

            // Collapsed, one line each: the bus, then when to leave. Where to
            // goes in the header, next to the ticking countdown.
            if (answer.isClassPlan) {
                // A class: count down to leaving, not to the next bus. Unconfirmed,
                // the leave time as it was, not "Leave now" for a bus that's gone.
                val catch = answer.catchLine
                b.setContentTitle(if (unconfirmed != null) card?.leaveBy ?: answer.leaveHeadline(now) else answer.leaveHeadline(now))
                    .setContentText(unconfirmed ?: catch)
                    .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(unconfirmed, catch, answer.leaveNote.takeIf { unconfirmed == null }, answer.goNowLine.takeIf { unconfirmed == null }).joinToString("\n")))
                    .setSubText(listOfNotNull(answer.destLabel, answer.classAtMs?.let { L.s(R.string.starts_at, fmt(it)) }).joinToString(" · "))
                // A class card can come without a leave time: no countdown then.
                return b.countdownTo(answer.leaveAtMs.takeIf { unconfirmed == null }, now).build()
            }
            val title = if (answer.arrived) answer.label else answer.clockLabel(fmt)
            val leave = answer.leaveText(now).takeIf { unconfirmed == null }
            b.setContentTitle(title)
                .setContentText(unconfirmed ?: leave ?: answer.detail)
                .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(unconfirmed ?: leave, answer.detail).joinToString("\n")))
            (answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null)?.let { b.setSubText(it) }
            // The system ticks this down; nothing to redraw between refreshes.
            return b.countdownTo(answer.departsAtMs?.takeIf { answer.quality != "unknown" && unconfirmed == null }, now).build()
        }
    }
}

/**
 * How long the live notification waits at least after [failures] failed
 * refreshes in a row (offline, the server failing): 1, 2, 4, then 8 minutes;
 * nothing extra after a success.
 */
internal fun liveBackoffMs(failures: Int): Long =
    if (failures <= 0) 0 else 60_000L shl (failures - 1).coerceAtMost(3)

class LiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == LiveService.ACTION_START) LiveService.start(context)
    }
}
