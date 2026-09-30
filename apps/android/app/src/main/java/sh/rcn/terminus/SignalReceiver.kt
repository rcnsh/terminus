package sh.rcn.terminus

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.redrawWidgets

/**
 * A button on the trip's notification or the widget: "On it", "Missed it",
 * "Not going". Sends it to /me/signal and redraws from the card that comes
 * back, so the notification and the widgets change in place, and the user's
 * other devices hear about it from the server.
 */
class SignalReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val kind = intent.getStringExtra(EXTRA_KIND) ?: return
        val trip = intent.getStringExtra(EXTRA_TRIP)
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                send(context.applicationContext, kind, trip)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION = "sh.rcn.terminus.SIGNAL"
        const val EXTRA_KIND = "kind"
        const val EXTRA_TRIP = "trip"

        suspend fun send(ctx: Context, kind: String, trip: String?) {
            val store = Store(ctx)
            val token = store.token ?: return
            // "Not going": that trip's notification has nothing more to say.
            if (kind == "skipped") ctx.getSystemService(NotificationManager::class.java)?.cancel(LeaveAlerts.NOTIFICATION_ID)
            runCatching { Api(token, fast = true, hour12 = hour12(ctx)).signal(kind, trip) }
                .onSuccess { json ->
                    val now = System.currentTimeMillis()
                    store.saveAnswer(json, now)
                    store.lastError = null
                    Refresher.scheduleNext(ctx, NextAnswer.parse(json), now)
                    // A tap on the notification or the widget: the moment Android
                    // lets the live notification start following the trip.
                    LiveService.watch(ctx)
                }
                .onFailure { store.lastError = "Couldn't send that; try again in the app" }
            redrawWidgets(ctx)
        }
    }
}
