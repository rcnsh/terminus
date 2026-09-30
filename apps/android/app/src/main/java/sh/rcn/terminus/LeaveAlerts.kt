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
 * place and never posted again once dismissed: at the bus's departure it
 * asks "On the 9:41 D2?" with On it · Missed it · Not going (the server's
 * `card.ask`), then shows the ride or the next way there. A push brings each
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

    /** Android 12 needs no permission to notify; 13 and later ask. */
    fun canNotify(ctx: Context): Boolean =
        android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU ||
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

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
            if (following || card?.remind == false) cancel(ctx)
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
        val ask = card?.ask
        // The words follow the trip: the question at the departure, then the
        // ride or the next way there; before that, when to leave.
        val (title, body) = when {
            ask != null -> ask.question to (card.line ?: answer.catchLine.orEmpty())
            card?.phase == "riding" || card?.phase == "missed" -> (card.line ?: answer.label) to answer.detail
            else -> (answer.leaveHeadline(now) ?: return) to (answer.catchLine ?: answer.destLabel.orEmpty())
        }
        val where = listOfNotNull(answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · ")
        val open = PendingIntent.getActivity(
            ctx, 0, MainActivity.intentFor(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Sound for the heads-up and for the question, once each; quiet for the rest.
        val store = Store(ctx)
        val moment = if (ask != null) "ask:${ask.trip}" else if (card?.phase == "riding" || card?.phase == "missed") store.leaveAlertedMoment else "leave:${answer.classAtMs}"
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
            .apply { ask?.actions?.take(3)?.forEachIndexed { i, a -> addAction(signalAction(ctx, i, a)) } }
            // Gone once the class has started: it's no longer true.
            .apply { answer.classAtMs?.let { setTimeoutAfter((it - now).coerceAtLeast(60_000)) } }
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }

    /** A button that answers the question from the notification (SignalReceiver). */
    private fun signalAction(ctx: Context, i: Int, a: CardAction): android.app.Notification.Action {
        val pi = PendingIntent.getBroadcast(
            ctx, 10 + i,
            Intent(ctx, SignalReceiver::class.java).setAction(SignalReceiver.ACTION)
                .putExtra(SignalReceiver.EXTRA_KIND, a.id).putExtra(SignalReceiver.EXTRA_TRIP, a.trip),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return android.app.Notification.Action.Builder(Icon.createWithResource(ctx, R.drawable.ic_bus), a.label, pi).build()
    }

    // Exact only when canScheduleExactAlarms() says so; lint can't see the check.
    @android.annotation.SuppressLint("MissingPermission")
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
