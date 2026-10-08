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
import sh.rcn.terminus.widget.isOld
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
        // Restarted by the system after it stopped the app (START_STICKY), Android
        // can refuse a foreground service at all: then stop, rather than crash.
        if (runCatching { foreground(cached?.first) }.isFailure) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop?.isActive != true) loop = scope.launch { run() }
        return START_STICKY
    }

    private fun foreground(answer: NextAnswer?) {
        val n = build(this, answer)
        // The special-use type exists from Android 14; before that the plain call.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }

    private suspend fun run() {
        val store = Store(this)
        val nm = getSystemService(NotificationManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        while (scope.isActive) {
            if (!store.liveUpdates || !store.paired) break
            Refresher.refresh(this)
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
            nm?.notify(NOTIFICATION_ID, build(this, answer))
            val wait = if (power?.isInteractive != false) SCREEN_ON_MS else SCREEN_OFF_MS
            // The header's countdown runs on past zero ("-1:20") until it's
            // rebuilt: rebuilt just after it ends, without a fetch.
            val end = countdownAt(answer)?.let { it - ServerClock.now() + 1_000 }?.takeIf { it in 1 until wait }
            if (end != null) {
                delay(end)
                nm?.notify(NOTIFICATION_ID, build(this, store.lastAnswer()?.first ?: answer))
                delay(wait - end)
            } else {
                delay(wait)
            }
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "live"
        private const val NOTIFICATION_ID = 2
        private const val SCREEN_ON_MS = 30_000L
        private const val SCREEN_OFF_MS = 120_000L
        const val ACTION_STOP = "sh.rcn.terminus.LIVE_STOP"
        const val ACTION_START = "sh.rcn.terminus.LIVE_START"
        /** From "time to go" until you're there. */
        val TRIP_PHASES = setOf("due", "heading", "waiting", "riding", "missed")

        fun start(ctx: Context) {
            val store = Store(ctx)
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx)) return
            runCatching { ctx.startForegroundService(Intent(ctx, LiveService::class.java)) }
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

        /** What the header counts down to: getting off, leaving for a class, or the bus. */
        internal fun countdownAt(answer: NextAnswer): Long? {
            val card = answer.card
            return when {
                card?.phase == "riding" && card.ride != null -> card.ride.arriveMs
                answer.isClassPlan -> answer.leaveAtMs
                else -> answer.departsAtMs?.takeIf { answer.quality != "unknown" }
            }
        }

        private fun build(ctx: Context, answer: NextAnswer?): Notification {
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

class LiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == LiveService.ACTION_START) LiveService.start(context)
    }
}
