package sh.rcn.terminus

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.graphics.drawable.Icon
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailabilityLight
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.widget.Refresher

/**
 * Push, phase 3: the server says when the card changes, so the phone doesn't
 * have to keep asking.
 *
 * Firebase Cloud Messaging, only on a phone with Google Play services and a
 * build that has the Firebase config (BuildConfig.FIREBASE_*). A push is a
 * nudge (`{kind: 'card', phase}`); the app fetches /me/next itself and
 * redraws the widgets and the trip's notification from it. Everything else
 * (the heads-up alarm, the widget refresh) still works without it. The one
 * other kind, `term`, is the reminder to import a new semester's timetable,
 * worded by the server in both languages. Since 2.5.0 the push carries no
 * words, so none pass through Google: the app fetches them (GET /me/notice).
 * Older versions are still sent them.
 */
object Push {
    /** This build has Firebase, and the phone has Play services. */
    fun available(ctx: Context): Boolean =
        BuildConfig.FIREBASE_APP_ID.isNotEmpty() &&
            GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS

    /** Sets up Firebase in code (there's no google-services plugin). False when push isn't available. */
    fun init(ctx: Context): Boolean {
        if (!available(ctx)) return false
        if (FirebaseApp.getApps(ctx).isEmpty()) {
            FirebaseApp.initializeApp(
                ctx,
                FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                    .build(),
            )
        }
        return true
    }

    /**
     * The same token is sent again after this long: the server drops one
     * that Firebase stopped delivering to, and nothing tells the phone. At
     * most twice a day, one small request.
     */
    private const val RESEND_MS = 12 * 60 * 60_000L

    /** Push is relied on alone only with a token sent and a push heard within this. */
    private const val TRUST_MS = 24 * 60 * 60_000L

    /**
     * A push only moves the leave alert and the live notification on (the
     * widgets keep their own alarms), and the server sends some at high
     * priority, which wakes the phone. So this phone asks for them only
     * while one of the two is on and can be seen.
     */
    fun wanted(ctx: Context): Boolean {
        val store = Store(ctx)
        return store.paired &&
            ((store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)) || (store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL)))
    }

    /** Which session a token was sent with, without keeping the session token in plain prefs. */
    internal fun tag(session: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(session.toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }

    /**
     * No token sent for this session yet (a new sign-in or pairing, whatever
     * was sent before it), or not for [RESEND_MS].
     */
    fun due(store: Store, now: Long = System.currentTimeMillis()): Boolean {
        val session = store.token ?: return false
        return store.pushToken == null || store.pushFor != tag(session) || now - store.pushSentAt >= RESEND_MS
    }

    /** [sync] would change something: a token to send, or one to take back. */
    fun stale(ctx: Context): Boolean = if (wanted(ctx)) due(Store(ctx)) else Store(ctx).pushToken != null

    /**
     * Sends this phone's token when [wanted] and new or [due], or takes it
     * back from the server when no longer wanted. Call when the session
     * changes, when the alerts or notifications are turned on or off, at
     * start, and from refreshes.
     */
    fun sync(ctx: Context) {
        val app = ctx.applicationContext
        if (!Store(app).paired || !init(app)) return
        if (wanted(app)) FirebaseMessaging.getInstance().token.addOnSuccessListener { send(app, it) }
        else drop(app)
    }

    fun send(ctx: Context, token: String) {
        val store = Store(ctx)
        val auth = store.token ?: return
        if (!wanted(ctx) || (token == store.pushToken && !due(store))) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api(auth).registerPush(token) }.onSuccess {
                // Signed in again meanwhile: the new session hasn't got it.
                if (store.token != auth) return@onSuccess
                store.pushToken = token
                store.pushFor = tag(auth)
                store.pushSentAt = System.currentTimeMillis()
            }
        }
    }

    /** Not wanted any more: the server stops sending to this session. */
    private fun drop(ctx: Context) {
        val store = Store(ctx)
        if (store.pushToken == null) return
        val auth = store.token ?: return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api(auth).unregisterPush() }.onSuccess {
                if (store.token == auth) store.pushToken = null
            }
        }
    }

    /**
     * This phone hears about changes by push: a token this session sent and
     * the server took, and a push that arrived, both within [TRUST_MS].
     * Otherwise the alarms keep the trip in step too (LeaveAlerts.followUp),
     * in case the server has dropped the token.
     */
    fun active(ctx: Context): Boolean {
        val store = Store(ctx)
        val now = System.currentTimeMillis()
        val session = store.token ?: return false
        return store.pushToken != null && store.pushFor == tag(session) &&
            now - store.pushSentAt < TRUST_MS && now - store.pushHeardAt < TRUST_MS && available(ctx)
    }
}

/** Firebase is ready before anything else runs, including a push that starts the process. */
class TerminusApp : Application() {
    override fun onCreate() {
        super.onCreate()
        L.init(this)
        ServerClock.init(this)
        Quiet.init(this)
        Outdated.init(this)
        Push.init(this)
        // The token is read once per process, through the Keystore: started
        // here, off the main thread, so the first screen rarely waits for it.
        val app = this
        Thread { Store(app).token }.start()
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.send(applicationContext, token)
    }

    /** The card changed: fetch it, and let the widgets and the trip's notification follow. */
    override fun onMessageReceived(message: RemoteMessage) {
        Store(applicationContext).pushHeardAt = System.currentTimeMillis()
        if (message.data["kind"] == "term") {
            val ctx = applicationContext
            // Words in the push (an older server), or fetched: one request, on this background thread.
            val words = if (message.data["title"] != null) message.data else runBlocking { TermReminder.fetch(ctx) }
            if (words != null) TermReminder.post(ctx, words)
            return
        }
        if (message.data["kind"] != "card") return
        val ctx = applicationContext
        // The live notification runs from "due" until you're there. Started
        // first: a high-priority push ("due", "missed") lets it start only
        // for a few seconds. It fetches the answer itself, and stops if the
        // trip is over.
        if (message.data["phase"] in LiveService.TRIP_PHASES && LiveService.start(ctx)) return
        // A background thread with a few seconds to spare: only the answer
        // here, one request; the rest of a refresh follows in a job. Asked
        // for even just after another refresh: the card changed since.
        runBlocking { Refresher.refresh(ctx, fast = true, extras = false, force = true) }
    }
}

/** A new semester starts within the week and the account's timetable is last semester's. */
object TermReminder {
    const val CHANNEL = "term"
    private const val NOTIFICATION_ID = 3

    /** The reminder's words from the server, or null (signed out, offline, or no reminder due). */
    suspend fun fetch(ctx: Context): Map<String, String>? {
        val token = Store(ctx).token ?: return null
        // Fast timeouts: this runs inside the few seconds Firebase gives a message.
        return runCatching { Api(token, fast = true).notice() }.getOrNull()
    }

    fun post(ctx: Context, data: Map<String, String>) {
        if (!LeaveAlerts.canNotify(ctx, CHANNEL)) return
        val zh = Lang.current(ctx) == Lang.ZH
        // A reminder without words (a field missing from the server's) isn't shown blank.
        val title = (if (zh) data["zhTitle"] else data["title"])?.takeIf { it.isNotBlank() } ?: return
        val body = (if (zh) data["zhBody"] else data["body"]).orEmpty()
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, L.s(R.string.channel_term), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = L.s(R.string.channel_term_desc)
            },
        )
        val open = PendingIntent.getActivity(
            ctx, NOTIFICATION_ID, MainActivity.intentFor(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(Icon.createWithResource(ctx, R.drawable.ic_bus))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .build()
        nm.notify(NOTIFICATION_ID, n)
    }
}
