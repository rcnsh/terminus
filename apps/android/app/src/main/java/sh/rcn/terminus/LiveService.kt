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

/**
 * The live notification: while your day is on, a silent ongoing notification
 * with the next bus and a ticking countdown, refreshed every 30 s (2 min
 * with the screen off), and the widgets redrawn with it.
 *
 * Outside your day (a `rest` answer) it stops itself and an exact alarm
 * starts it again when the day begins. The API's 15 s per-stop cache means
 * this costs NUS nothing more than having the app open.
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
            stopSelf()
            return START_NOT_STICKY
        }
        // Must be in the foreground within seconds of starting, before any fetch.
        val cached = Store(this).lastAnswer()
        startForeground(NOTIFICATION_ID, build(this, cached?.first), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (loop?.isActive != true) loop = scope.launch { run() }
        return START_STICKY
    }

    private suspend fun run() {
        val store = Store(this)
        val nm = getSystemService(NotificationManager::class.java)
        val power = getSystemService(PowerManager::class.java)
        while (scope.isActive) {
            if (!store.liveUpdates || !store.paired) break
            Refresher.refresh(this)
            val answer = store.lastAnswer()?.first
            if (answer?.mode == "rest") {
                // Day's over (or not begun): come back when the plan changes.
                answer.refreshAtMs?.let { wakeAt(this, it) }
                break
            }
            nm?.notify(NOTIFICATION_ID, build(this, answer))
            delay(if (power?.isInteractive != false) SCREEN_ON_MS else SCREEN_OFF_MS)
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
         * Exact, so the service may start from the background: an app holding
         * USE_EXACT_ALARM is allowed to when its exact alarm fires.
         */
        private fun wakeAt(ctx: Context, at: Long) {
            val am = ctx.getSystemService(AlarmManager::class.java) ?: return
            if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, startIntent(ctx))
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, startIntent(ctx))
        }

        private fun startIntent(ctx: Context): PendingIntent =
            PendingIntent.getBroadcast(
                ctx, 3, Intent(ctx, LiveReceiver::class.java).setAction(ACTION_START),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )

        private fun build(ctx: Context, answer: NextAnswer?): Notification {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            nm?.createNotificationChannel(
                NotificationChannel(CHANNEL, "Live bus times", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "The next bus, kept up to date while your day is on"
                    setShowBadge(false)
                },
            )
            val now = System.currentTimeMillis()
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
                .addAction(Notification.Action.Builder(null, "Turn off", stop).build())
            if (answer == null) return b.setContentTitle("terminus").setContentText("Checking…").build()

            // Collapsed, one line each: the bus, then when to leave. Where to
            // goes in the header, next to the ticking countdown.
            val title = if (answer.arrived) answer.label else answer.clockLabel { clock(ctx, it) }
            val leave = answer.leaveText(now) { clock(ctx, it) }
            b.setContentTitle(title)
                .setContentText(leave ?: answer.detail)
                .setStyle(Notification.BigTextStyle().bigText(listOfNotNull(leave, answer.detail).joinToString("\n")))
            (answer.destLabel ?: if (answer.mode == "nearby") "Nearby" else null)?.let { b.setSubText(it) }
            // The system ticks this down; nothing to redraw between refreshes.
            val departs = answer.departsAtMs
            if (departs != null && departs > now && answer.quality != "unknown") {
                b.setWhen(departs).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
            } else {
                b.setShowWhen(false)
            }
            return b.build()
        }
    }
}

class LiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == LiveService.ACTION_START) LiveService.start(context)
    }
}
