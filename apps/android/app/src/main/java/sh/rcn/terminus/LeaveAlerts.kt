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
import kotlinx.coroutines.Dispatchers
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.finishAsync

/**
 * "Time to leave" for the next class, and then the trip, in one notification.
 *
 * The server says when the heads-up goes (`card.remindAt`), and for which
 * trips: none when it's null. A couple of minutes before, an exact alarm fetches a fresh answer (live times by
 * then, not the headway guess from hours ago) and that answer decides: post
 * at its `remindAt` (one more alarm, from the answer just fetched), or check
 * again later. A last alarm at the leave time turns the notification into
 * "Leave now", unless it was dismissed.
 *
 * From then on the same notification follows the trip, updated in
 * place and never posted again once dismissed: the ride, or the next way
 * there after a missed bus. It never asks what happened: that comes from
 * the plan and the phone's location. Its one button, before you've left, is
 * the card's "Not going", so a class you're skipping can be dropped
 * from the alert itself. A push brings each change; without one, an alarm at
 * the card's next change does. A class with reminders turned off
 * (`card.remind`) gets none of it.
 */
object LeaveAlerts {
    const val CHANNEL = "leave"
    const val NOTIFICATION_ID = 1
    /** Fetch fresh times this long before the heads-up is due: the reminder itself is the server's `remindAt`. */
    private const val CHECK_AHEAD_MS = 2 * 60_000L
    /** An alarm this close to remindAt (or a moment late) posts at once. */
    private const val POST_SLACK_MS = 1_000L
    /** With nothing to say yet (no bus to catch), checked again at most this often... */
    private const val RETRY_GAP_MS = 2 * 60_000L
    /** ...and only this long past remindAt: then the trip counts as done, as a shown heads-up would. */
    private const val GIVE_UP_MS = 10 * 60_000L

    const val ACTION_CHECK = "sh.rcn.terminus.LEAVE_CHECK"
    const val ACTION_NOW = "sh.rcn.terminus.LEAVE_NOW"
    /** At `remindAt`: the heads-up, from the answer the check fetched. */
    const val ACTION_POST = "sh.rcn.terminus.LEAVE_POST"
    /** On the bus: redraw the ride at the next stop, from the saved answer. */
    const val ACTION_RIDE = "sh.rcn.terminus.LEAVE_RIDE"
    /** "Not going", from the notification's button: the trip in EXTRA_TRIP. */
    const val ACTION_SKIP = "sh.rcn.terminus.LEAVE_SKIP"
    const val EXTRA_TRIP = "trip"

    /**
     * Notifications from this app can be seen: allowed (Android 12 needs no
     * permission; 13 and later ask), not blocked in the phone's settings,
     * and, given a [channel], that channel not turned off. One not made yet
     * counts as on.
     */
    fun canNotify(ctx: Context, channel: String? = null): Boolean {
        if (needsPermission(ctx)) return false
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return true
        if (!nm.areNotificationsEnabled()) return false
        return channel == null || nm.getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    /** Android 13 and later, and the permission not given (yet): asking can help. Otherwise only the phone's settings can. */
    fun needsPermission(ctx: Context): Boolean =
        android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    /**
     * "Alarms & reminders" (SCHEDULE_EXACT_ALARM), which the user allows in
     * system settings. Without it every alarm here is inexact, and Doze may
     * run it a few minutes late.
     */
    fun canBeExact(ctx: Context): Boolean = ctx.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true

    /** The system page that allows it, for this app. */
    fun exactAlarmSettings(ctx: Context): Intent =
        Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.fromParts("package", ctx.packageName, null))

    /** Called with every planned answer, from the app and from the background refresh. [now] is on the server's clock. */
    fun arm(ctx: Context, answer: NextAnswer, now: Long = ServerClock.now()) {
        val store = Store(ctx)
        val state = State(
            alertsOn = store.leaveAlerts && canNotify(ctx, CHANNEL),
            notifiedFor = store.leaveNotifiedFor,
            exact = canBeExact(ctx),
        )
        when (val step = decide(answer, state, showing(ctx), Push.active(ctx), now)) {
            Step.Keep -> Unit
            Step.Cancel -> cancel(ctx)
            Step.StopChecking -> {
                cancelAlarm(ctx, ACTION_CHECK)
                cancelAlarm(ctx, ACTION_POST)
            }
            is Step.Follow -> {
                if (step.post) post(ctx, answer, now)
                if (step.checkAt != null) setAlarm(ctx, ACTION_CHECK, step.checkAt) else cancelAlarm(ctx, ACTION_CHECK)
            }
            is Step.HeadsUp -> {
                cancelAlarm(ctx, ACTION_CHECK)
                cancelAlarm(ctx, ACTION_POST)
                // Marked once shown: decide() only asks with something to say.
                if (post(ctx, answer, now)) {
                    store.leaveNotifiedFor = step.trip
                    if (step.leaveNowAt != null) setAlarm(ctx, ACTION_NOW, step.leaveNowAt)
                }
            }
            is Step.PostAt -> {
                cancelAlarm(ctx, ACTION_CHECK)
                setAlarm(ctx, ACTION_POST, step.at)
            }
            is Step.GiveUp -> {
                cancelAlarm(ctx, ACTION_CHECK)
                cancelAlarm(ctx, ACTION_POST)
                store.leaveNotifiedFor = step.trip
            }
            is Step.CheckAt -> {
                cancelAlarm(ctx, ACTION_POST)
                setAlarm(ctx, ACTION_CHECK, step.at)
            }
        }
    }

    /** At remindAt: the answer the check fetched a moment ago decides, as [arm] does. */
    fun postDue(ctx: Context) {
        val answer = Store(ctx).lastAnswer()?.first ?: return
        arm(ctx, answer)
    }

    /**
     * What [arm] reads from the phone: alerts on (and allowed), the trip the
     * last heads-up was for, and whether exact alarms are allowed.
     */
    data class State(val alertsOn: Boolean, val notifiedFor: Long, val exact: Boolean = false)

    /** What [arm] does with an answer. */
    sealed interface Step {
        /** Nothing to change. */
        data object Keep : Step
        /** The notification and every alarm go. */
        data object Cancel : Step
        /** No heads-up to come: only the pending check (and post) go. */
        data object StopChecking : Step
        /** The heads-up was posted for this trip: redraw it if [post] (it's showing), then check again at [checkAt], or stop checking. */
        data class Follow(val post: Boolean, val checkAt: Long?) : Step
        /** Post the heads-up now, for [trip], and turn it into "Leave now" at [leaveNowAt]. */
        data class HeadsUp(val trip: Long, val leaveNowAt: Long?) : Step
        /** Fresh times in hand, but not yet: post at [at] (remindAt), from the answer kept. */
        data class PostAt(val at: Long) : Step
        /** Nothing to say for [trip] and its reminder long past: counted as done, nothing posted. */
        data class GiveUp(val trip: Long) : Step
        /** Fetch fresh times at [at] and decide again. */
        data class CheckAt(val at: Long) : Step
    }

    /**
     * The choice [arm] makes, apart from the phone so it can be tested.
     * [showing] is whether the notification is up; [pushActive] whether
     * pushes bring the card's changes (then no follow-up alarm is needed).
     */
    fun decide(answer: NextAnswer, state: State, showing: Boolean, pushActive: Boolean, now: Long): Step {
        val leaveAt = answer.leaveAtMs
        val classAt = answer.classAtMs
        val card = answer.card
        val remindAt = card?.remindAtMs
        // Which trip the heads-up was for: a class by its start, which stays put
        // while its leave time moves with the buses.
        val trip = classAt ?: remindAt
        // "Not going" was just answered for the trip on
        // screen: its notification follows, even though the plan (and its
        // leave time) has moved on.
        val following = trip != null && state.notifiedFor != 0L && state.notifiedFor == trip && showing
        if (card?.remind == false || card?.phase == "arrived") {
            // Reminders off for this trip, or you're there: nothing more to say.
            return if (following || card.remind == false) Step.Cancel else Step.Keep
        }
        if (!state.alertsOn || trip == null || (classAt != null && now >= classAt) || (remindAt == null && !following)) return Step.StopChecking
        // One heads-up per trip. A new plan (the next class) has a new classAt.
        // After it, the same notification follows the trip, but only while it's showing.
        if (state.notifiedFor == trip) return Step.Follow(post = showing, checkAt = followUpAt(answer, pushActive, now))
        if (remindAt == null) return Step.Keep
        if (remindAt > now + CHECK_AHEAD_MS) return Step.CheckAt(remindAt - CHECK_AHEAD_MS)
        // Fresh times in hand, but not yet: the heads-up goes at remindAt, so
        // "5 minutes before you need to leave" is true when it comes. Only
        // with exact alarms: an inexact one after the inexact check could
        // land past the leave time, so then it goes now, as the check lands.
        if (remindAt > now + POST_SLACK_MS && state.exact) return Step.PostAt(remindAt)
        if (sayable(answer, now)) return Step.HeadsUp(trip, leaveAt?.takeIf { it > now })
        // Nothing to say yet (no bus to catch): the card's next change tries
        // again, every couple of minutes at most, until the reminder is well past.
        if (now - remindAt > GIVE_UP_MS) return Step.GiveUp(trip)
        return card.nextChangeAtMs?.takeIf { it > now }?.let { Step.CheckAt(maxOf(it + 2_000, now + RETRY_GAP_MS)) } ?: Step.StopChecking
    }

    /** Whether [post] has something to say for this answer: a heads-up without a leave time is left unsaid. */
    private fun sayable(answer: NextAnswer, now: Long): Boolean {
        val phase = answer.card?.phase
        return phase == "riding" || phase == "missed" || answer.leaveHeadline(now) != null
    }

    /** Turning alerts off, or unpairing. */
    fun cancel(ctx: Context) {
        cancelAlarm(ctx, ACTION_CHECK)
        cancelAlarm(ctx, ACTION_POST)
        cancelAlarm(ctx, ACTION_NOW)
        cancelAlarm(ctx, ACTION_RIDE)
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    /** At the leave time: the heads-up, if still showing, becomes "Leave now". */
    fun leaveNow(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        post(ctx, answer, ServerClock.now())
    }

    private fun showing(ctx: Context): Boolean =
        ctx.getSystemService(NotificationManager::class.java)?.activeNotifications?.any { it.id == NOTIFICATION_ID } == true

    /**
     * Without push, a check at the card's next change (the bus leaving, then
     * "no answer means on it") keeps the notification in step. With push the
     * server says when, so no alarm is needed: null.
     */
    private fun followUpAt(answer: NextAnswer, pushActive: Boolean, now: Long): Long? {
        val next = answer.card?.nextChangeAtMs
        val until = answer.classAtMs ?: Long.MAX_VALUE
        return if (pushActive || next == null || next <= now || next >= until) null else next + 2_000
    }

    /** Posts (or updates) the notification; false when there was nothing to say. */
    private fun post(ctx: Context, answer: NextAnswer, now: Long): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, L.s(R.string.channel_leave), NotificationManager.IMPORTANCE_HIGH).apply {
                description = L.s(R.string.channel_leave_desc)
            },
        )
        val fmt = { ms: Long -> clock(ctx, ms) }
        val card = answer.card
        // The words follow the trip: the ride or the next way there; before
        // that, when to leave.
        val ride = card?.ride?.takeIf { card.phase == "riding" }
        val (title, said) = when {
            card?.phase == "riding" || card?.phase == "missed" -> (card.line ?: answer.label) to answer.detail
            else -> (answer.leaveHeadline(now) ?: return false) to (answer.catchLine ?: answer.destLabel.orEmpty())
        }
        val store = Store(ctx)
        // Posted from the last answer when a fresh one couldn't be had
        // (offline): past its staleAt, its times aren't confirmed. Not
        // isOld, which also counts a card this version couldn't read.
        val body = if (card?.staleAtMs?.let { now >= it } == true) {
            store.lastAnswer()?.second?.let { listOf(L.s(R.string.unconfirmed_checked, fmt(it)), said).filter { s -> s.isNotEmpty() }.joinToString(" · ") } ?: said
        } else {
            said
        }
        val where = listOfNotNull(answer.destLabel, answer.classAtMs?.let { L.s(R.string.starts_at, fmt(it)) }).joinToString(" · ")
        val open = PendingIntent.getActivity(
            ctx, 0, MainActivity.intentFor(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Sound for the heads-up, once; quiet for the rest.
        val moment = if (card?.phase == "riding" || card?.phase == "missed") store.leaveAlertedMoment else "leave:${answer.classAtMs}"
        val alert = moment != store.leaveAlertedMoment
        store.leaveAlertedMoment = moment
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
            .setContentTitle(title)
            .setContentText(body)
            // The whole line when it's opened, not cut at the screen's edge (a ride sets its own style below).
            .setStyle(android.app.Notification.BigTextStyle().bigText(body))
            .setSubText(where)
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(android.app.Notification.CATEGORY_REMINDER)
            .setOnlyAlertOnce(!alert)
            // Gone once the class has started: it's no longer true.
            .apply { answer.classAtMs?.let { setTimeoutAfter((it - now).coerceAtLeast(60_000)) } }
            .apply { ride?.let { RideStyle.apply(ctx, this, card, it, now) } }
            .apply { skipAction(ctx, answer)?.let { addAction(it) } }
            .build()
        nm.notify(NOTIFICATION_ID, n)
        // The bus's place on the bar is the clock's estimate: move it on at
        // each stop. A second late, so the last one (getting off) is surely
        // past it and drops the countdown rather than leaving it to run below zero.
        val redraw = ride?.let { RideStyle.nextRedrawAt(it, now) }?.plus(1_000)
        if (redraw != null) setAlarm(ctx, ACTION_RIDE, redraw) else cancelAlarm(ctx, ACTION_RIDE)
        return true
    }

    /**
     * The card's "Not going", as a button, before the trip has begun
     * (not on the ride, nor after a missed bus). Its words are the server's.
     */
    private fun skipAction(ctx: Context, answer: NextAnswer): android.app.Notification.Action? {
        val card = answer.card ?: return null
        if (card.phase == "riding" || card.phase == "missed") return null
        val skip = card.actions.firstOrNull { it.id == "skipped" } ?: return null
        val pi = PendingIntent.getBroadcast(
            ctx, 6,
            Intent(ctx, LeaveReceiver::class.java).setAction(ACTION_SKIP).putExtra(EXTRA_TRIP, skip.trip),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return android.app.Notification.Action.Builder(null, skip.label, pi).build()
    }

    /**
     * "Not going" from the notification: the class taken off today, as the
     * app's button does, then the notification goes and the widgets and the
     * next alert follow the new plan. Offline, it stays as it was, so the
     * button can be tried again (or the app opened).
     */
    suspend fun skip(ctx: Context, trip: String) {
        val store = Store(ctx)
        val token = store.token ?: return
        try {
            // Fast timeouts: a broadcast has about ten seconds in all.
            val json = Api(token, fast = true, hour12 = hour12(ctx)).signal("skipped", trip)
            val now = System.currentTimeMillis()
            // Read before it's kept: one this version can't read leaves the last good one.
            val answer = store.saveAnswer(json, now)
            ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
            Refresher.scheduleNext(ctx, answer, now)
            sh.rcn.terminus.widget.redrawWidgets(ctx)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401) Session.rejected(ctx, token)
        } catch (e: Exception) {
            // Left showing, button and all.
        }
    }

    /** At the next stop on the ride: redraw from the saved answer, if still showing. */
    fun redrawRide(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        if (answer.card?.phase == "riding") post(ctx, answer, ServerClock.now())
    }

    /** [serverAt] is on the server's clock; alarms go by the phone's. */
    private fun setAlarm(ctx: Context, action: String, serverAt: Long) {
        ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(ServerClock.toDevice(serverAt), alarmIntent(ctx, action))
    }

    private fun cancelAlarm(ctx: Context, action: String) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx, action))
    }

    private fun alarmIntent(ctx: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            ctx, when (action) { ACTION_CHECK -> 1; ACTION_NOW -> 2; ACTION_POST -> 7; else -> 5 },
            Intent(ctx, LeaveReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

/**
 * An alarm at [at] that runs in Doze too: exact when "Alarms & reminders" is
 * allowed, otherwise inexact, which Doze may run a few minutes late.
 */
// Exact only when canScheduleExactAlarms() says so; lint can't see the check.
@android.annotation.SuppressLint("MissingPermission")
internal fun AlarmManager.setWhileIdle(at: Long, pi: PendingIntent) {
    if (canScheduleExactAlarms()) setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    else setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
}

class LeaveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            // A fresh answer re-arms or posts, through Refresher -> LeaveAlerts.arm.
            // Fetched right here: the alarm's idle allowance is seconds long,
            // and a queued job could run after the heads-up was due. Only
            // /me/next here; the day plan and chosen widgets follow in a job.
            // An exact alarm may start the live notification: the trip is on,
            // and no push may come to start it (one at normal priority can't).
            LeaveAlerts.ACTION_CHECK -> finishAsync(Dispatchers.IO) {
                val answer = Refresher.refresh(context, fast = true, extras = false)
                if (answer?.card?.phase in LiveService.TRIP_PHASES) LiveService.start(context)
            }
            LeaveAlerts.ACTION_POST -> LeaveAlerts.postDue(context)
            LeaveAlerts.ACTION_NOW -> LeaveAlerts.leaveNow(context)
            LeaveAlerts.ACTION_RIDE -> LeaveAlerts.redrawRide(context)
            LeaveAlerts.ACTION_SKIP -> {
                val trip = intent.getStringExtra(LeaveAlerts.EXTRA_TRIP) ?: return
                finishAsync(Dispatchers.IO) { LeaveAlerts.skip(context, trip) }
            }
        }
    }
}
