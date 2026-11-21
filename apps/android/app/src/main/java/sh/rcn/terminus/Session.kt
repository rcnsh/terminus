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
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.forgetWidgets

object Session {
    private val ended = MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    val signedOut: SharedFlow<Unit> = ended

    suspend fun rejected(ctx: Context, token: String?): Boolean {
        if (token == null) return false
        val app = ctx.applicationContext
        val store = Store(app)
        if (!withContext(Dispatchers.IO) { store.signOutIf(token) }) return false
        Refresher.cancel(app)
        store.lastError = widgetMessage(store)
        runCatching { forgetWidgets(app) }
        ended.tryEmit(Unit)
        return true
    }

    suspend fun signedIn(ctx: Context) {
        val app = ctx.applicationContext
        withContext(Dispatchers.IO) { Store(app).forgetAnswers() }
        runCatching { forgetWidgets(app) }
    }

    fun clearLocal(ctx: Context) {
        val app = ctx.applicationContext
        Store(app).clear()
        Refresher.cancel(app)
        CoroutineScope(Dispatchers.Default).launch { runCatching { forgetWidgets(app) } }
    }

    fun signOut(ctx: Context) {
        val token = Store(ctx).token
        clearLocal(ctx)
        if (token == null) return
        val work =
            OneTimeWorkRequestBuilder<LogoutWorker>()
                .setInputData(workDataOf(LogoutWorker.TOKEN to token))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
        WorkManager.getInstance(ctx).enqueue(work)
    }

    fun message(reason: String?): String? =
        when (reason) {
            Store.SIGNED_OUT_REMOVED -> L.s(DeviceKind.word(R.string.signed_out_removed))
            Store.SIGNED_OUT_UNUSED -> L.s(DeviceKind.word(R.string.signed_out_unused))
            Store.SIGNED_OUT_KEY_LOST -> L.s(DeviceKind.word(R.string.signed_out_key_lost))
            else -> null
        }

    private fun widgetMessage(store: Store): String =
        L.s(if (store.signedOutReason == Store.SIGNED_OUT_UNUSED) R.string.device_removed_unused else R.string.device_removed)
}

class LogoutWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val token = inputData.getString(TOKEN) ?: return Result.success()
        return try {
            Api(token).logout()
            Result.success()
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status == 429 || e.status >= 500) again() else Result.success()
        } catch (e: Exception) {
            again()
        }
    }

    private fun again() = if (runAttemptCount < MAX_TRIES) Result.retry() else Result.success()

    companion object {
        const val TOKEN = "token"
        private const val MAX_TRIES = 10
    }
}
