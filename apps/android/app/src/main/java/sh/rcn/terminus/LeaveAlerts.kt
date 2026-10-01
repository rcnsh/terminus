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
 * "Time to leave" for the next class, and then the trip, in one notification.
 *
 * Every planned answer carries a leave-by time. A few minutes before the
 * heads-up is due, an exact alarm fetches a fresh answer (live times by
 * then, not the headway guess from hours ago) and that answer decides: post
 * now, or check again later. A second alarm at the leave time turns the
 * notification into "Leave now", unless it was dismissed.
 *
 * From then on (phase 3) the same notification follows the trip, updated in
 * place and never posted again once dismissed: the ride, or the next way
 * there after a missed bus. It never asks anything or offers buttons: what
 * happened comes from the plan and the phone's location. A push brings each
 * change; without one, an alarm at the card's next change does. A class with
 * reminders turned off (`card.remind`) gets none of it.
 */
object LeaveAlerts {
    private const val CHANNEL = "leave"
    const val NOTIFICATION_ID = 1
    /** Heads-up this long before the leave time. */
    const val LEAD_MS = 5 * 60_000L
    /** Fetch fresh times this long before the heads-up is due. */
    private const val CHECK_AHEAD_MS = 2 * 60_000L

    const val ACTION_CHECK = "sh.rcn.terminus.LEAVE_CHECK"
    const val ACTION_NOW = "sh.rcn.terminus.LEAVE_NOW"
    /** On the bus: redraw the ride at the next stop, from the saved answer. */
    const val ACTION_RIDE = "sh.rcn.terminus.LEAVE_RIDE"

    /** Android 12 needs no permission to notify; 13 and later ask. */
    fun canNotify(ctx: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU ||
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * "Alarms & reminders" (SCHEDULE_EXACT_ALARM), which the user allows in
     * system settings. Without it every alarm here is inexact, and Doze may
     * run it a few minutes late.
     */
    fun canBeExact(ctx: Context): Boolean = ctx.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true

    /** The system page that allows it, for this app. */
    fun exactAlarmSettings(ctx: Context): Intent =
        Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.fromParts("package", ctx.packageName, null))

    /** Called with every planned answer, from the app and from the background refresh. */
    fun arm(ctx: Context, answer: NextAnswer, now: Long = System.currentTimeMillis()) {
        val store = Store(ctx)
        val leaveAt = answer.leaveAtMs
        val classAt = answer.classAtMs
        val card = answer.card
        // "On it", "Missed it" or "Not going" was just answered for the trip on
        // screen: its notification follows, even though the plan (and its
        // leave time) has moved on.
        val following = store.leaveNotifiedFor != 0L && store.leaveNotifiedFor == classAt && showing(ctx)
        if (card?.remind == false || (answer.why == "class" && card?.phase == "arrived")) {
            // Reminders off for this class, or you're there: nothing more to say.
            if (following || card.remind == false) cancel(ctx)
            return
        }
        if (!store.leaveAlerts || !canNotify(ctx) || answer.why != "class" || classAt == null || now >= classAt || (leaveAt == null && !following)) {
            cancelAlarm(ctx, ACTION_CHECK)
            return
        }
        // One heads-up per class. A new plan (the next class) has a new classAt.
        // After it, the same notification follows the trip, but only while it's showing.
        if (store.leaveNotifiedFor == classAt) {
            if (showing(ctx)) post(ctx, answer, now)
            followUp(ctx, answer, now)
            return
        }
        if (leaveAt == null) return
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
        cancelAlarm(ctx, ACTION_RIDE)
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    /** At the leave time: the heads-up, if still showing, becomes "Leave now". */
    fun leaveNow(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        post(ctx, answer, System.currentTimeMillis())
    }

    private fun showing(ctx: Context): Boolean =
        ctx.getSystemService(NotificationManager::class.java)?.activeNotifications?.any { it.id == NOTIFICATION_ID } == true

    /**
     * Without push, a check at the card's next change (the bus leaving, then
     * "no answer means on it") keeps the notification in step. With push the
     * server says when, so no alarm is needed.
     */
    private fun followUp(ctx: Context, answer: NextAnswer, now: Long) {
        val next = answer.card?.nextChangeAtMs
        val until = answer.classAtMs ?: return
        if (Push.active(ctx) || next == null || next <= now || next >= until) cancelAlarm(ctx, ACTION_CHECK)
        else setAlarm(ctx, ACTION_CHECK, next + 2_000)
    }

    private fun post(ctx: Context, answer: NextAnswer, now: Long) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "Time to leave", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When to set off for your next class"
            },
        )
        val fmt = { ms: Long -> clock(ctx, ms) }
        val card = answer.card
        // The words follow the trip: the ride or the next way there; before
        // that, when to leave.
        val ride = card?.ride?.takeIf { card.phase == "riding" }
        val (title, body) = when {
            card?.phase == "riding" || card?.phase == "missed" -> (card.line ?: answer.label) to answer.detail
            else -> (answer.leaveHeadline(now) ?: return) to (answer.catchLine ?: answer.destLabel.orEmpty())
        }
        val where = listOfNotNull(answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · ")
        val open = PendingIntent.getActivity(
            ctx, 0, MainActivity.intentFor(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Sound for the heads-up, once; quiet for the rest.
        val store = Store(ctx)
        val moment = if (card?.phase == "riding" || card?.phase == "missed") store.leaveAlertedMoment else "leave:${answer.classAtMs}"
        val alert = moment != store.leaveAlertedMoment
        store.leaveAlertedMoment = moment
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
            .setContentTitle(title)
            .setContentText(body)
            .setSubText(where)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(android.app.Notification.CATEGORY_REMINDER)
            .setOnlyAlertOnce(!alert)
            // Gone once the class has started: it's no longer true.
            .apply { answer.classAtMs?.let { setTimeoutAfter((it - now).coerceAtLeast(60_000)) } }
            .apply { ride?.let { RideStyle.apply(ctx, this, card, it, now) } }
            .build()
        nm.notify(NOTIFICATION_ID, n)
        // The bus's place on the bar is the clock's estimate: move it on at each stop.
        val redraw = ride?.let { RideStyle.nextRedrawAt(it, now) }
        if (redraw != null) setAlarm(ctx, ACTION_RIDE, redraw) else cancelAlarm(ctx, ACTION_RIDE)
    }

    /** At the next stop on the ride: redraw from the saved answer, if still showing. */
    fun redrawRide(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        if (answer.card?.phase == "riding") post(ctx, answer, System.currentTimeMillis())
    }

    // Exact only when canScheduleExactAlarms() says so; lint can't see the check.
    @android.annotation.SuppressLint("MissingPermission")
    private fun setAlarm(ctx: Context, action: String, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java) ?: return
        val pi = alarmIntent(ctx, action)
        // Without "Alarms & reminders" allowed, an inexact alarm, which Doze
        // may run a few minutes late.
        if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    private fun cancelAlarm(ctx: Context, action: String) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx, action))
    }

    private fun alarmIntent(ctx: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, when (action) { ACTION_CHECK -> 1; ACTION_NOW -> 2; else -> 5 },
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
            LeaveAlerts.ACTION_RIDE -> LeaveAlerts.redrawRide(context)
        }
    }
}
