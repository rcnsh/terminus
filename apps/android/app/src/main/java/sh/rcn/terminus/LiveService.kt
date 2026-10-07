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
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.redrawWidgets

/**
 * The live notification: during a trip, from "time to go" until you're there
 * (phase 3), a silent ongoing notification with the next bus and a ticking
 * countdown, refreshed every 30 s (2 min with the screen off), and the
 * widgets redrawn with it.
 *
 * Between trips it stops itself, and starts again when the next trip is due:
 * from a push, or an exact alarm on a phone without one. The API's 15 s
 * per-stop cache means this costs NUS nothing more than having the app open.
 */
class LiveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
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
        val watching = wantWatch && runCatching { foreground(cached?.first, location = true) }.isSuccess
        // Restarted by the system after it stopped the app (START_STICKY), Android
        // can refuse a foreground service at all: then stop, rather than crash.
        if (!watching && runCatching { foreground(cached?.first, location = false) }.isFailure) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (watching && watch == null) watch = TripWatch(this).takeIf { it.start() }
        if (loop?.isActive != true) loop = scope.launch { run() }
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
        return runCatching { Api(token, fast = true, hour12 = hour12(this)).signal("location", null, fix.lat, fix.lon, fix.speedMs, fix.accM) }
            .onSuccess { json ->
                val now = System.currentTimeMillis()
                store.saveAnswer(json, now)
                store.lastError = null
                Refresher.scheduleNext(this, NextAnswer.parse(json), now)
                redrawWidgets(this)
            }
            .isSuccess
    }

    private suspend fun run() {
        val store = Store(this)
        val nm = getSystemService(NotificationManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        while (scope.isActive) {
            if (!store.liveUpdates || !store.paired) break
            if (!sendFix(store)) Refresher.refresh(this)
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
            delay(if (watch != null) WATCH_MS else if (power?.isInteractive != false) SCREEN_ON_MS else SCREEN_OFF_MS)
        }
        stopWatching()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        stopWatching()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "live"
        private const val NOTIFICATION_ID = 2
        private const val SCREEN_ON_MS = 30_000L
        private const val SCREEN_OFF_MS = 120_000L
        /** A location to the server this often while following a trip. */
        private const val WATCH_MS = 20_000L
        const val ACTION_STOP = "sh.rcn.terminus.LIVE_STOP"
        const val ACTION_START = "sh.rcn.terminus.LIVE_START"
        const val ACTION_WATCH = "sh.rcn.terminus.LIVE_WATCH"
        const val ACTION_UNWATCH = "sh.rcn.terminus.LIVE_UNWATCH"
        /** From "time to go" until you're there. */
        val TRIP_PHASES = setOf("due", "heading", "waiting", "riding", "missed")

        fun start(ctx: Context) {
            val store = Store(ctx)
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx)) return
            runCatching { ctx.startForegroundService(Intent(ctx, LiveService::class.java)) }
        }

        /**
         * Starts (or upgrades) the live notification to follow the trip by
         * location. Only from a tap: the app coming to the front, a button on
         * the notification or the widget. Android lets a foreground service
         * take the location then, and not from an alarm or a push.
         */
        fun watch(ctx: Context) {
            val store = Store(ctx)
            if (!store.detectTrips || !store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx) || !Locator.hasPrecise(ctx)) return
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
         * start can be refused; a push at the trip's next phase starts it then.
         */
        private fun wakeAt(ctx: Context, at: Long) {
            ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(at, startIntent(ctx))
        }

        private fun startIntent(ctx: Context): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, 3, Intent(ctx, LiveReceiver::class.java).setAction(ACTION_START),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

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
            // SDK_INT_FULL only exists from API 36: reading it on 12-15 throws, so check SDK_INT first.
            if (android.os.Build.VERSION.SDK_INT >= 36 && android.os.Build.VERSION.SDK_INT_FULL >= android.os.Build.VERSION_CODES_FULL.BAKLAVA_1 && card?.phase in TRIP_PHASES) {
                b.setRequestPromotedOngoing(true)
                card?.glance?.let { b.setShortCriticalText(it) }
            }
            // On the bus: the ride, stop by stop (RideStyle).
            val ride = card?.ride
            if (card != null && card.phase == "riding" && ride != null) {
                b.setSubText(answer.destLabel)
                return RideStyle.apply(ctx, b, card, ride, now).build()
            }

            // Collapsed, one line each: the bus, then when to leave. Where to
            // goes in the header, next to the ticking countdown.
            val fmt = { ms: Long -> clock(ctx, ms) }
            if (answer.isClassPlan) {
                // A class: count down to leaving, not to the next bus.
                val catch = answer.catchLine
                b.setContentTitle(answer.leaveHeadline(now))
                    .setContentText(catch)
                    .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(catch, answer.leaveNote, answer.goNowLine).joinToString("\n")))
                    .setSubText(listOfNotNull(answer.destLabel, answer.classAtMs?.let { L.s(R.string.starts_at, fmt(it)) }).joinToString(" · "))
                // A class card can come without a leave time: no countdown then.
                return b.countdownTo(answer.leaveAtMs, now).build()
            }
            val title = if (answer.arrived) answer.label else answer.clockLabel(fmt)
            val leave = answer.leaveText(now)
            b.setContentTitle(title)
                .setContentText(leave ?: answer.detail)
                .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(leave, answer.detail).joinToString("\n")))
            (answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null)?.let { b.setSubText(it) }
            // The system ticks this down; nothing to redraw between refreshes.
            return b.countdownTo(answer.departsAtMs?.takeIf { answer.quality != "unknown" }, now).build()
        }
    }
}

class LiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == LiveService.ACTION_START) LiveService.start(context)
    }
}
