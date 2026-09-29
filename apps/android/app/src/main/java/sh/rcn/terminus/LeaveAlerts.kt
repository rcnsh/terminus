package sh.rcn.terminus

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.clock

/**
 * "Time to leave" for the next class, entirely on the phone.
 *
 * Every planned answer carries a leave-by time. A few minutes before the
 * heads-up is due, an exact alarm fetches a fresh answer (live times by
 * then, not the headway guess from hours ago) and that answer decides: post
 * now, or check again later. A second alarm at the leave time turns the
 * notification into "Leave now", unless it was dismissed.
 */
object LeaveAlerts {
    private const val CHANNEL = "leave"
    private const val NOTIFICATION_ID = 1
    /** Heads-up this long before the leave time. */
    const val LEAD_MS = 5 * 60_000L
    /** Fetch fresh times this long before the heads-up is due. */
    private const val CHECK_AHEAD_MS = 2 * 60_000L

    const val ACTION_CHECK = "sh.rcn.terminus.LEAVE_CHECK"
    const val ACTION_NOW = "sh.rcn.terminus.LEAVE_NOW"

    fun canNotify(ctx: Context): Boolean =
        ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Called with every planned answer, from the app and from the background refresh. */
    fun arm(ctx: Context, answer: NextAnswer, now: Long = System.currentTimeMillis()) {
        val store = Store(ctx)
        val leaveAt = answer.leaveAtMs
        val classAt = answer.classAtMs
        if (!store.leaveAlerts || !canNotify(ctx) || answer.why != "class" || leaveAt == null || classAt == null || now >= classAt) {
            cancelAlarm(ctx, ACTION_CHECK)
            return
        }
        // One heads-up per class. A new plan (the next class) has a new classAt.
        if (store.leaveNotifiedFor == classAt) return
        val notifyAt = leaveAt - LEAD_MS
        if (notifyAt <= now + CHECK_AHEAD_MS) {
            post(ctx, answer, now)
            store.leaveNotifiedFor = classAt
            cancelAlarm(ctx, ACTION_CHECK)
            if (leaveAt > now) setAlarm(ctx, ACTION_NOW, leaveAt)
        } else {
            setAlarm(ctx, ACTION_CHECK, notifyAt - CHECK_AHEAD_MS)
        }
    }

    /** Turning alerts off, or unpairing. */
    fun cancel(ctx: Context) {
        cancelAlarm(ctx, ACTION_CHECK)
        cancelAlarm(ctx, ACTION_NOW)
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    /** At the leave time: the heads-up, if still showing, becomes "Leave now". */
    fun leaveNow(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        if (nm.activeNotifications.none { it.id == NOTIFICATION_ID }) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        post(ctx, answer, System.currentTimeMillis())
    }

    private fun post(ctx: Context, answer: NextAnswer, now: Long) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Time to leave", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When to set off for your next class"
            },
        )
        val fmt = { ms: Long -> clock(ctx, ms) }
        val title = answer.leaveHeadline(now) ?: return
        // Not `timingText`: that is for the headline bus, which may not be the one to wait for.
        val body = answer.catchLine ?: answer.destLabel.orEmpty()
        val where = listOfNotNull(answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · ")
        val open = PendingIntent.getActivity(
            ctx, 0, MainActivity.intentFor(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(where)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(android.app.Notification.CATEGORY_REMINDER)
            .setOnlyAlertOnce(false)
            // Gone once the class has started: it's no longer true.
            .apply { answer.classAtMs?.let { setTimeoutAfter((it - now).coerceAtLeast(60_000)) } }
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }

    private fun setAlarm(ctx: Context, action: String, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val pi = alarmIntent(ctx, action)
        // USE_EXACT_ALARM is granted at install; a phone that still refuses
        // gets an inexact alarm, which Doze may run a few minutes late.
        if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    private fun cancelAlarm(ctx: Context, action: String) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx, action))
    }

    private fun alarmIntent(ctx: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, if (action == ACTION_CHECK) 1 else 2,
            Intent(ctx, LeaveReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

class LeaveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            // A fresh answer re-arms or posts, through Refresher -> LeaveAlerts.arm.
            // Fetched right here: the alarm's idle allowance is seconds long,
            // and a queued job could run after the heads-up was due.
            LeaveAlerts.ACTION_CHECK -> {
                val pending = goAsync()
                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        Refresher.refresh(context, fast = true)
                    } finally {
                        pending.finish()
                    }
                }
            }
            LeaveAlerts.ACTION_NOW -> LeaveAlerts.leaveNow(context)
        }
    }
}
