package sh.rcn.terminus

import android.app.Application
import android.content.Context
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
import sh.rcn.terminus.widget.Refresher

/**
 * Push, phase 3: the server says when the card changes, so the phone doesn't
 * have to keep asking.
 *
 * Firebase Cloud Messaging, only on a phone with Google Play services and a
 * build that has the Firebase config (BuildConfig.FIREBASE_*). A push is a
 * nudge (`{kind: 'card', phase, ask}`); the app fetches /me/next itself and
 * redraws the widgets and the trip's notification from it. Everything else
 * (the heads-up alarm, the widget refresh) still works without it.
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

    /** Sends this phone's token to the server when it's new. Call once paired, and at start. */
    fun register(ctx: Context) {
        if (!Store(ctx).paired || !init(ctx)) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { send(ctx.applicationContext, it) }
    }

    fun send(ctx: Context, token: String) {
        val store = Store(ctx)
        val auth = store.token ?: return
        if (token == store.pushToken) return
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Api(auth).registerPush(token) }.onSuccess { store.pushToken = token }
        }
    }

    /** Unpaired or signed out: the next account registers again. */
    fun forget(ctx: Context) {
        Store(ctx).pushToken = null
    }

    /** This phone hears about changes by push. */
    fun active(ctx: Context): Boolean = Store(ctx).pushToken != null && available(ctx)
}

/** Firebase is ready before anything else runs, including a push that starts the process. */
class TerminusApp : Application() {
    override fun onCreate() {
        super.onCreate()
        L.init(this)
        Push.init(this)
    }
}

class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        Push.send(applicationContext, token)
    }

    /** The card changed: fetch it, and let the widgets and the trip's notification follow. */
    override fun onMessageReceived(message: RemoteMessage) {
        if (message.data["kind"] != "card") return
        val ctx = applicationContext
        // A background thread with a few seconds to spare; the fetch is one request.
        runBlocking { Refresher.refresh(ctx, fast = true) }
        // The live notification runs from "due" until you're there.
        if (message.data["phase"] in LiveService.TRIP_PHASES) LiveService.start(ctx)
    }
}
