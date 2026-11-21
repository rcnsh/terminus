package sh.rcn.terminus

import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.res.Configuration
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
import sh.rcn.terminus.widget.redrawWidgets

object Push {
    fun available(ctx: Context): Boolean =
        BuildConfig.FIREBASE_APP_ID.isNotEmpty() &&
            GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(ctx) == ConnectionResult.SUCCESS

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

    private const val RESEND_MS = 12 * 60 * 60_000L

    private const val TRUST_MS = 24 * 60 * 60_000L

    fun wanted(ctx: Context): Boolean = Store(ctx).paired && (follows(ctx) || LeaveAlerts.canNotify(ctx, TermReminder.CHANNEL))

    data class State(
        val token: String?,
        val sentAt: Long,
        val heardAt: Long,
        val sentFor: String? = null,
        val session: String? = null,
    ) {
        companion object {
            fun of(store: Store) =
                State(store.pushToken, store.pushSentAt, store.pushHeardAt, store.pushFor, store.token?.let { Push.tag(it) })
        }
    }

    fun follows(ctx: Context): Boolean {
        val store = Store(ctx)
        return (store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)) ||
            (store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL))
    }

    internal fun tag(session: String): String =
        java.security.MessageDigest.getInstance("SHA-256").digest(session.toByteArray()).take(8).joinToString("") { "%02x".format(it) }

    fun due(store: Store, now: Long = System.currentTimeMillis()): Boolean = store.token != null && due(State.of(store), now)

    fun due(state: State, now: Long): Boolean = state.token == null || state.sentFor != state.session || now - state.sentAt >= RESEND_MS

    fun stale(ctx: Context): Boolean = if (wanted(ctx)) due(Store(ctx)) else Store(ctx).pushToken != null

    fun sync(ctx: Context) {
        val app = ctx.applicationContext
        if (!Store(app).paired || !init(app)) return
        if (wanted(app)) FirebaseMessaging.getInstance().token.addOnSuccessListener { send(app, it) } else drop(app)
    }

    fun send(ctx: Context, token: String) {
        val store = Store(ctx)
        val auth = store.token ?: return
        if (!wanted(ctx) || (token == store.pushToken && !due(store))) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api(auth).registerPush(token) }
                .onSuccess {
                    if (store.token != auth) return@onSuccess
                    store.pushToken = token
                    store.pushFor = tag(auth)
                    store.pushSentAt = System.currentTimeMillis()
                }
        }
    }

    private fun drop(ctx: Context) {
        val store = Store(ctx)
        if (store.pushToken == null) return
        val auth = store.token ?: return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api(auth).unregisterPush() }
                .onSuccess {
                    if (store.token == auth) store.pushToken = null
                }
        }
    }

    fun active(ctx: Context): Boolean {
        val store = Store(ctx)
        return store.token != null && active(State.of(store), System.currentTimeMillis()) && available(ctx)
    }

    fun active(state: State, now: Long): Boolean =
        state.token != null && state.sentFor == state.session && now - state.sentAt < TRUST_MS && now - state.heardAt < TRUST_MS
}

class TerminusApp : Application() {
    override fun onCreate() {
        super.onCreate()
        L.init(this)
        DeviceKind.init(this)
        Servers.init(this)
        CrashReports.install(this)
        ServerClock.init(this)
        Quiet.init(this)
        Outdated.init(this)
        Push.init(this)
        val app = this
        Thread { Store(app).token }.start()
        nightMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    }

    private var nightMode = 0

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val night = newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK
        if (night == nightMode) return
        nightMode = night
        val app = this
        CoroutineScope(Dispatchers.Default).launch { redrawWidgets(app) }
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.send(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Store(applicationContext).pushHeardAt = System.currentTimeMillis()
        if (message.data["kind"] == "term") {
            val ctx = applicationContext
            val words = if (message.data["title"] != null) message.data else runBlocking { TermReminder.fetch(ctx) }
            if (words != null) TermReminder.post(ctx, words)
            return
        }
        val ctx = applicationContext
        if (message.data["kind"] != "card" || !Push.follows(ctx)) return
        if (message.data["phase"] in LiveService.TRIP_PHASES && LiveService.start(ctx, force = true)) return
        runBlocking { Refresher.refresh(ctx, fast = true, extras = false, force = true) }
    }
}

object TermReminder {
    const val CHANNEL = "term"
    private const val NOTIFICATION_ID = 3

    suspend fun fetch(ctx: Context): Map<String, String>? {
        val token = Store(ctx).token ?: return null
        return runCatching { Api(token, fast = true).notice() }.getOrNull()
    }

    fun words(data: Map<String, String>, zh: Boolean): Pair<String, String>? {
        val title = (if (zh) data["zhTitle"] else data["title"])?.takeIf { it.isNotBlank() } ?: return null
        return title to (if (zh) data["zhBody"] else data["body"]).orEmpty()
    }

    fun post(ctx: Context, data: Map<String, String>) {
        if (!LeaveAlerts.canNotify(ctx, CHANNEL)) return
        val (title, body) = words(data, Lang.current(ctx) == Lang.ZH) ?: return
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, L.s(R.string.channel_term), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = L.s(R.string.channel_term_desc)
            }
        )
        val open =
            PendingIntent.getActivity(
                ctx,
                NOTIFICATION_ID,
                MainActivity.intentFor(ctx),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        val n =
            Notification.Builder(ctx, CHANNEL)
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
