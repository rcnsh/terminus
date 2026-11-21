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

class LiveService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var loop: Job? = null
    @Volatile private var lastStartId = 0
    @Volatile private var handledStartId = 0
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private val force = java.util.concurrent.atomic.AtomicBoolean(false)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Store(this).liveUpdates = false
            getSystemService(AlarmManager::class.java)?.cancel(startIntent(this))
            stopForeground(STOP_FOREGROUND_REMOVE)
            val app = applicationContext
            CoroutineScope(Dispatchers.Default).launch { redrawWidgets(app) }
            stopSelf()
            return START_NOT_STICKY
        }
        lastStartId = startId
        if (intent?.getBooleanExtra(EXTRA_FORCE, false) == true) force.set(true)
        val store = Store(this)
        val cached = store.lastAnswer()
        if (runCatching { foreground(cached?.first) }.isFailure) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (!LeaveAlerts.canNotify(this, CHANNEL)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (loop?.isActive != true) {
            wake.tryReceive()
            loop = scope.launch { run() }
        } else {
            wake.trySend(Unit)
        }
        return START_STICKY
    }

    private fun foreground(answer: NextAnswer?) {
        val n = build(this, answer)
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
        var failures = 0
        while (scope.isActive) {
            handledStartId = lastStartId
            val pushed = force.getAndSet(false)
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(this, CHANNEL)) break
            val fresh = !pushed && store.lastAnswer()?.second?.let { System.currentTimeMillis() - it in 0 until FRESH_MS } == true
            if (!fresh) {
                if (Refresher.refresh(this, force = pushed) != null) failures = 0 else failures++
            }
            if (Outdated.holding() || !store.paired) break
            val answer = store.lastAnswer()?.first
            if (answer == null || answer.mode == "rest" || answer.card?.phase !in TRIP_PHASES) {
                betweenTripsWakeAt(answer, ServerClock.now())?.let { wakeAt(this, ServerClock.toDevice(it)) }
                break
            }
            nm?.notify(NOTIFICATION_ID, build(this, answer))
            val every = if (power?.isInteractive != false) SCREEN_ON_MS else SCREEN_OFF_MS
            val wait = maxOf(every, liveBackoffMs(failures), Quiet.waitMs())
            val end = countdownAt(answer)?.let { it - ServerClock.now() + 1_000 }?.takeIf { it in 1 until wait }
            if (end != null) {
                if (pause(end)) continue
                nm?.notify(NOTIFICATION_ID, build(this, store.lastAnswer()?.first ?: answer))
                pause(wait - end)
            } else {
                pause(wait)
            }
        }
        withContext(Dispatchers.Main) {
            if (lastStartId != handledStartId && scope.isActive) {
                loop = scope.launch { run() }
            } else {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelfResult(handledStartId)
            }
        }
    }

    private suspend fun pause(ms: Long): Boolean = withTimeoutOrNull(ms) { wake.receive() } != null

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val CHANNEL = "live"
        private const val NOTIFICATION_ID = 2
        private const val SCREEN_ON_MS = 30_000L
        private const val SCREEN_OFF_MS = 120_000L
        private const val FRESH_MS = 10_000L
        internal const val MIN_WAKE_MS = 60_000L
        const val ACTION_STOP = "sh.rcn.terminus.LIVE_STOP"
        const val ACTION_START = "sh.rcn.terminus.LIVE_START"
        private const val EXTRA_FORCE = "force"
        val TRIP_PHASES = setOf("due", "heading", "waiting", "riding", "missed")

        fun start(ctx: Context, force: Boolean = false): Boolean {
            val store = Store(ctx)
            if (!store.liveUpdates || !store.paired || !LeaveAlerts.canNotify(ctx, CHANNEL)) return false
            val intent = Intent(ctx, LiveService::class.java).putExtra(EXTRA_FORCE, force)
            return runCatching { ctx.startForegroundService(intent) }.isSuccess
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, LiveService::class.java))
            ctx.getSystemService(AlarmManager::class.java)?.cancel(startIntent(ctx))
        }

        private fun wakeAt(ctx: Context, at: Long) {
            ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(at, startIntent(ctx))
        }

        private fun startIntent(ctx: Context): PendingIntent =
            PendingIntent.getBroadcast(
                ctx,
                3,
                Intent(ctx, LiveReceiver::class.java).setAction(ACTION_START),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        internal fun betweenTripsWakeAt(answer: NextAnswer?, now: Long): Long? =
            listOfNotNull(answer?.card?.remindAtMs, answer?.refreshAtMs).filter { it > now }.minOrNull()?.coerceAtLeast(now + MIN_WAKE_MS)

        internal fun countdownAt(answer: NextAnswer): Long? {
            val card = answer.card
            return when {
                card?.phase == "riding" && card.ride != null -> card.ride.arriveMs
                card?.phase == "waiting" && card.journey?.boardAtMs != null -> card.journey?.boardAtMs
                card?.phase == "waiting" && answer.isClassPlan -> null
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
                }
            )
            val now = ServerClock.now()
            val open =
                PendingIntent.getActivity(
                    ctx,
                    0,
                    MainActivity.intentFor(ctx),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            val stop =
                PendingIntent.getService(
                    ctx,
                    4,
                    Intent(ctx, LiveService::class.java).setAction(ACTION_STOP),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            val b =
                Notification.Builder(ctx, CHANNEL)
                    .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .setContentIntent(open)
                    .setCategory(Notification.CATEGORY_STATUS)
            b.addAction(Notification.Action.Builder(null, L.s(R.string.turn_off), stop).build())
            if (answer == null) return b.setContentTitle("terminus").setContentText(L.s(R.string.checking)).build()
            val card = answer.card
            val fmt = { ms: Long -> clock(ctx, ms) }
            val unconfirmed =
                if (isOld(answer, now)) Store(ctx).lastAnswer()?.second?.let { L.s(R.string.unconfirmed_checked, fmt(it)) } else null
            if (
                android.os.Build.VERSION.SDK_INT >= 36 &&
                    android.os.Build.VERSION.SDK_INT_FULL >= android.os.Build.VERSION_CODES_FULL.BAKLAVA_1 &&
                    card?.phase in TRIP_PHASES
            ) {
                b.setRequestPromotedOngoing(true)
                if (unconfirmed == null) card?.glance?.let { b.setShortCriticalText(it) }
            }
            val ride = card?.ride
            if (card != null && card.phase == "riding" && ride != null) {
                b.setSubText(answer.destLabel)
                RideStyle.apply(ctx, b, card, ride, now)
                if (unconfirmed != null) b.setContentText(listOf(unconfirmed, ride.nextText(now)).joinToString(" · "))
                return b.build()
            }

            if (answer.isClassPlan) {
                val catch = answer.catchLine
                val gone = card?.gone == true && card.line != null
                val head =
                    if (gone) card?.line
                    else if (unconfirmed != null) card?.leaveBy ?: answer.leaveHeadline(now) else answer.leaveHeadline(now)
                b.setContentTitle(head)
                    .setContentText(unconfirmed ?: if (gone) card?.phaseText ?: catch else catch)
                    .setStyle(
                        Notification.BigTextStyle()
                            .bigText(
                                listOfNotNull(
                                        unconfirmed,
                                        card?.phaseText.takeIf { gone },
                                        catch,
                                        answer.leaveNote.takeIf { unconfirmed == null },
                                        answer.goNowLine.takeIf { unconfirmed == null },
                                    )
                                    .joinToString("\n")
                            )
                    )
                    .setSubText(
                        listOfNotNull(answer.destLabel, answer.classAtMs?.let { L.s(answer.startsRes, fmt(it)) }).joinToString(" · ")
                    )
                return b.countdownTo(countdownAt(answer).takeIf { unconfirmed == null }, now).build()
            }
            val title = if (answer.arrived) answer.label else answer.clockLabel(fmt)
            val leave = answer.leaveText(now).takeIf { unconfirmed == null }
            b.setContentTitle(title)
                .setContentText(unconfirmed ?: leave ?: answer.detail)
                .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(unconfirmed ?: leave, answer.detail).joinToString("\n")))
            (answer.destLabel ?: if (answer.mode == "nearby") L.s(R.string.chip_nearby) else null)?.let { b.setSubText(it) }
            return b.countdownTo(countdownAt(answer).takeIf { unconfirmed == null }, now).build()
        }
    }
}

internal fun liveBackoffMs(failures: Int): Long = if (failures <= 0) 0 else 60_000L shl (failures - 1).coerceAtMost(3)

class LiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == LiveService.ACTION_START) LiveService.start(context)
    }
}
