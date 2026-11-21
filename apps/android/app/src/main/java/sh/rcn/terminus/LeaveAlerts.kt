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

object LeaveAlerts {
    const val CHANNEL = "leave"
    const val NOTIFICATION_ID = 1
    private const val CHECK_AHEAD_MS = 2 * 60_000L
    private const val POST_SLACK_MS = 1_000L
    private const val RETRY_GAP_MS = 2 * 60_000L
    private const val GIVE_UP_MS = 10 * 60_000L

    const val ACTION_CHECK = "sh.rcn.terminus.LEAVE_CHECK"
    const val ACTION_NOW = "sh.rcn.terminus.LEAVE_NOW"
    const val ACTION_POST = "sh.rcn.terminus.LEAVE_POST"
    const val ACTION_RIDE = "sh.rcn.terminus.LEAVE_RIDE"
    const val ACTION_SKIP = "sh.rcn.terminus.LEAVE_SKIP"
    const val EXTRA_TRIP = "trip"

    fun canNotify(ctx: Context, channel: String? = null): Boolean {
        if (needsPermission(ctx)) return false
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return true
        if (!nm.areNotificationsEnabled()) return false
        return channel == null || nm.getNotificationChannel(channel)?.importance != NotificationManager.IMPORTANCE_NONE
    }

    fun needsPermission(ctx: Context): Boolean =
        android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU &&
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    fun canBeExact(ctx: Context): Boolean = ctx.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true

    fun exactAlarmSettings(ctx: Context): Intent =
        Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.fromParts("package", ctx.packageName, null))

    fun arm(ctx: Context, answer: NextAnswer, now: Long = ServerClock.now()) {
        val store = Store(ctx)
        val state =
            State(
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

    fun postDue(ctx: Context) {
        val answer = Store(ctx).lastAnswer()?.first ?: return
        arm(ctx, answer)
    }

    data class State(val alertsOn: Boolean, val notifiedFor: Long, val exact: Boolean = false)

    sealed interface Step {
        data object Keep : Step

        data object Cancel : Step

        data object StopChecking : Step

        data class Follow(val post: Boolean, val checkAt: Long?) : Step

        data class HeadsUp(val trip: Long, val leaveNowAt: Long?) : Step

        data class PostAt(val at: Long) : Step

        data class GiveUp(val trip: Long) : Step

        data class CheckAt(val at: Long) : Step
    }

    fun decide(answer: NextAnswer, state: State, showing: Boolean, pushActive: Boolean, now: Long): Step {
        val leaveAt = answer.leaveAtMs
        val classAt = answer.classAtMs
        val card = answer.card
        val remindAt = card?.remindAtMs
        val ids = listOfNotNull(card?.actions?.firstOrNull()?.trip?.hashCode()?.toLong(), classAt, remindAt)
        val trip = ids.firstOrNull()
        val noted = trip != null && state.notifiedFor != 0L && state.notifiedFor in ids
        val following = noted && showing
        if (card?.remind == false || card?.phase == "arrived") {
            return if (following || card.remind == false) Step.Cancel else Step.Keep
        }
        if (!state.alertsOn || trip == null || (classAt != null && now >= classAt) || (remindAt == null && !following))
            return Step.StopChecking
        if (noted) return Step.Follow(post = showing, checkAt = if (showing) followUpAt(answer, pushActive, now) else null)
        if (remindAt == null) return Step.Keep
        if (remindAt > now + CHECK_AHEAD_MS) return Step.CheckAt(remindAt - CHECK_AHEAD_MS)
        if (remindAt > now + POST_SLACK_MS && state.exact) return Step.PostAt(remindAt)
        if (sayable(answer, now)) return Step.HeadsUp(trip, leaveAt?.takeIf { it > now })
        if (now - remindAt > GIVE_UP_MS) return Step.GiveUp(trip)
        return card.nextChangeAtMs?.takeIf { it > now }?.let { Step.CheckAt(maxOf(it + 2_000, now + RETRY_GAP_MS)) } ?: Step.StopChecking
    }

    private fun sayable(answer: NextAnswer, now: Long): Boolean {
        val phase = answer.card?.phase
        return phase == "riding" || phase == "missed" || answer.card?.gone == true || answer.leaveHeadline(now) != null
    }

    fun cancel(ctx: Context) {
        cancelAlarm(ctx, ACTION_CHECK)
        cancelAlarm(ctx, ACTION_POST)
        cancelAlarm(ctx, ACTION_NOW)
        cancelAlarm(ctx, ACTION_RIDE)
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    fun leaveNow(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        post(ctx, answer, ServerClock.now())
    }

    private fun showing(ctx: Context): Boolean =
        ctx.getSystemService(NotificationManager::class.java)?.activeNotifications?.any { it.id == NOTIFICATION_ID } == true

    private fun followUpAt(answer: NextAnswer, pushActive: Boolean, now: Long): Long? {
        val next = answer.card?.nextChangeAtMs
        val until = answer.classAtMs ?: Long.MAX_VALUE
        return if (pushActive || next == null || next <= now || next >= until) null else next + 2_000
    }

    private fun post(ctx: Context, answer: NextAnswer, now: Long): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return false
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, L.s(R.string.channel_leave), NotificationManager.IMPORTANCE_HIGH).apply {
                description = L.s(R.string.channel_leave_desc)
            }
        )
        val fmt = { ms: Long -> clock(ctx, ms) }
        val card = answer.card
        val ride = card?.ride?.takeIf { card.phase == "riding" }
        val after = card?.phase == "riding" || card?.phase == "missed" || card?.gone == true
        val (title, said) =
            when {
                after -> (card?.line ?: answer.label) to answer.detail
                else -> (answer.leaveHeadline(now) ?: return false) to (answer.catchLine ?: answer.destLabel.orEmpty())
            }
        val store = Store(ctx)
        val body =
            if (card?.staleAtMs?.let { now >= it } == true) {
                store.lastAnswer()?.second?.let {
                    listOf(L.s(R.string.unconfirmed_checked, fmt(it)), said).filter { s -> s.isNotEmpty() }.joinToString(" · ")
                } ?: said
            } else {
                said
            }
        val where = listOfNotNull(answer.destLabel, answer.classAtMs?.let { L.s(answer.startsRes, fmt(it)) }).joinToString(" · ")
        val open =
            PendingIntent.getActivity(
                ctx,
                0,
                MainActivity.intentFor(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val moment =
            if (after) store.leaveAlertedMoment else "leave:${answer.classAtMs ?: "${answer.destLabel}:${answer.leaveAtMs?.let(::sgDate)}"}"
        val alert = moment != store.leaveAlertedMoment
        store.leaveAlertedMoment = moment
        val n =
            android.app.Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(android.app.Notification.BigTextStyle().bigText(body))
                .setSubText(where)
                .setContentIntent(open)
                .setAutoCancel(true)
                .setCategory(android.app.Notification.CATEGORY_REMINDER)
                .setOnlyAlertOnce(!alert)
                .apply { answer.classAtMs?.let { setTimeoutAfter((it - now).coerceAtLeast(60_000)) } }
                .apply { ride?.let { RideStyle.apply(ctx, this, card, it, now) } }
                .apply { skipAction(ctx, answer)?.let { addAction(it) } }
                .build()
        nm.notify(NOTIFICATION_ID, n)
        val redraw = ride?.let { RideStyle.nextRedrawAt(it, now) }?.plus(1_000)
        if (redraw != null) setAlarm(ctx, ACTION_RIDE, redraw) else cancelAlarm(ctx, ACTION_RIDE)
        return true
    }

    private fun skipAction(ctx: Context, answer: NextAnswer): android.app.Notification.Action? {
        val card = answer.card ?: return null
        if (card.phase == "riding" || card.phase == "missed") return null
        val skip = card.actions.firstOrNull { it.id == "skipped" } ?: return null
        val pi =
            PendingIntent.getBroadcast(
                ctx,
                6,
                Intent(ctx, LeaveReceiver::class.java).setAction(ACTION_SKIP).putExtra(EXTRA_TRIP, skip.trip),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        return android.app.Notification.Action.Builder(null, skip.label, pi).build()
    }

    suspend fun skip(ctx: Context, trip: String) {
        val store = Store(ctx)
        val token = store.token ?: return
        try {
            val json = Api(token, fast = true, hour12 = hour12(ctx)).signal("skipped", trip)
            val now = System.currentTimeMillis()
            val answer = store.saveAnswer(json, now, sentWith = token) ?: return
            ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
            Refresher.scheduleNext(ctx, answer, now)
            sh.rcn.terminus.widget.redrawWidgets(ctx)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 401) Session.rejected(ctx, token)
        } catch (_: java.io.IOException) {} catch (_: ParseError) {} catch (e: Exception) {
            CrashReports.caught(ctx, e)
        }
    }

    fun redrawRide(ctx: Context) {
        if (!showing(ctx)) return
        val answer = Store(ctx).lastAnswer()?.first ?: return
        if (answer.card?.phase == "riding") post(ctx, answer, ServerClock.now())
    }

    private fun setAlarm(ctx: Context, action: String, serverAt: Long) {
        ctx.getSystemService(AlarmManager::class.java)?.setWhileIdle(ServerClock.toDevice(serverAt), alarmIntent(ctx, action))
    }

    private fun cancelAlarm(ctx: Context, action: String) {
        ctx.getSystemService(AlarmManager::class.java)?.cancel(alarmIntent(ctx, action))
    }

    private fun alarmIntent(ctx: Context, action: String): PendingIntent =
        PendingIntent.getBroadcast(
            ctx,
            when (action) {
                ACTION_CHECK -> 1
                ACTION_NOW -> 2
                ACTION_POST -> 7
                else -> 5
            },
            Intent(ctx, LeaveReceiver::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}

internal fun AlarmManager.setWhileIdle(at: Long, pi: PendingIntent, wake: Boolean = true) {
    val type = if (wake) AlarmManager.RTC_WAKEUP else AlarmManager.RTC
    if (canScheduleExactAlarms()) setExactAndAllowWhileIdle(type, at, pi) else setAndAllowWhileIdle(type, at, pi)
}

class LeaveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            LeaveAlerts.ACTION_CHECK ->
                finishAsync(context, Dispatchers.IO) {
                    val answer = Refresher.refresh(context, fast = true, extras = false)
                    if (answer?.card?.phase in LiveService.TRIP_PHASES) LiveService.start(context)
                }
            LeaveAlerts.ACTION_POST -> LeaveAlerts.postDue(context)
            LeaveAlerts.ACTION_NOW -> LeaveAlerts.leaveNow(context)
            LeaveAlerts.ACTION_RIDE -> LeaveAlerts.redrawRide(context)
            LeaveAlerts.ACTION_SKIP -> {
                val trip = intent.getStringExtra(LeaveAlerts.EXTRA_TRIP) ?: return
                finishAsync(context, Dispatchers.IO) { LeaveAlerts.skip(context, trip) }
            }
        }
    }
}

private fun sgDate(ms: Long): String =
    java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.of("Asia/Singapore")).toLocalDate().toString()
