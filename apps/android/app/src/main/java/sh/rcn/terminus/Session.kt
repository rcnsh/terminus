package sh.rcn.terminus

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.forgetWidgets
import java.util.concurrent.TimeUnit

/**
 * Leaving the account on this phone, the same way whichever way it goes:
 * signed out here, the account deleted, or the server refusing the token
 * (a 401: this phone removed from the account, or an account with no email
 * deleted after going unused). The account's things go from the phone, and
 * so does everything that would keep asking for them: the refresh chain,
 * the leave alerts, the live notification, the widgets' places, the push
 * address.
 */
object Session {
    private val ended = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** Fires when a refused token signed this phone out, for the screens open at the time. */
    val signedOut: SharedFlow<Unit> = ended

    /**
     * The server refused [token] (401), from wherever it was sent: the app,
     * the widget, a push, an alarm, the live notification. Signs out only
     * while it is still this phone's token. True when it signed out.
     */
    suspend fun rejected(ctx: Context, token: String?): Boolean {
        if (token == null) return false
        val app = ctx.applicationContext
        val store = Store(app)
        if (!withContext(Dispatchers.IO) { store.signOutIf(token) }) return false
        Refresher.cancel(app)
        // The widget says why, until the app is opened.
        store.lastError = widgetMessage(store)
        runCatching { forgetWidgets(app) }
        ended.tryEmit(Unit)
        return true
    }

    /**
     * Signed out here, or the account deleted: local state goes first, so the
     * screen can change at once, even offline.
     */
    fun clearLocal(ctx: Context) {
        val app = ctx.applicationContext
        Store(app).clear()
        Refresher.cancel(app)
        CoroutineScope(Dispatchers.Default).launch { runCatching { forgetWidgets(app) } }
    }

    /**
     * Signing out: local state goes now, and the server is told in a job that
     * waits for a network and tries again, so an offline sign-out still ends
     * the session there. The token travels in the job, not in the settings.
     */
    fun signOut(ctx: Context) {
        val token = Store(ctx).token
        clearLocal(ctx)
        if (token == null) return
        val work = OneTimeWorkRequestBuilder<LogoutWorker>()
            .setInputData(workDataOf(LogoutWorker.TOKEN to token))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()
        WorkManager.getInstance(ctx).enqueue(work)
    }

    /** What the welcome screen says about [reason] ([Store.takeSignedOut]); null for none. */
    fun message(reason: String?): String? = when (reason) {
        Store.SIGNED_OUT_REMOVED -> L.s(R.string.signed_out_removed)
        Store.SIGNED_OUT_UNUSED -> L.s(R.string.signed_out_unused)
        Store.SIGNED_OUT_KEY_LOST -> L.s(R.string.signed_out_key_lost)
        else -> null
    }

    private fun widgetMessage(store: Store): String =
        L.s(if (store.signedOutReason == Store.SIGNED_OUT_UNUSED) R.string.device_removed_unused else R.string.device_removed)
}

/** Ends a signed-out session on the server ([Session.signOut]). */
class LogoutWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val token = inputData.getString(TOKEN) ?: return Result.success()
        return try {
            Api(token).logout()
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            // Busy or down: again later. Refused (already gone): done.
            if (e.status == 429 || e.status >= 500) again() else Result.success()
        } catch (e: Exception) {
            again()
        }
    }

    /** Ten tries at most, over some hours: the session expires on the server by itself. */
    private fun again() = if (runAttemptCount < MAX_TRIES) Result.retry() else Result.success()

    companion object {
        const val TOKEN = "token"
        private const val MAX_TRIES = 10
    }
}
