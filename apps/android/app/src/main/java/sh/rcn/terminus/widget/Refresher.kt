package sh.rcn.terminus.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import java.util.concurrent.TimeUnit

object Refresher {
    private const val WORK = "terminus-refresh"
    private const val DIM = "terminus-dim"

    /** Fetch the planned answer, cache it, and redraw every widget. */
    suspend fun refresh(ctx: Context) {
        val store = Store(ctx)
        val token = store.token
        if (token == null) {
            store.lastError = null
            redrawWidgets(ctx)
            return
        }
        // In the background this is a cached fix at best, and only with
        // "Allow all the time". Without one, the API follows the timetable.
        val loc = Locator.lastKnown(ctx)
        try {
            val json = Api(token).nextJson(Target.Plan, loc?.latitude, loc?.longitude)
            val now = System.currentTimeMillis()
            store.saveAnswer(json, now)
            store.lastError = null
            scheduleDim(ctx, NextAnswer.parse(json), now)
        } catch (e: ApiError) {
            if (e.status == 401) store.token = null
            store.lastError = if (e.status == 401) "Device removed. Pair again in the app." else e.message
        } catch (e: Exception) {
            store.lastError = "Offline"
        }
        redrawWidgets(ctx)
    }

    /**
     * Widgets can't tick, so redraw once at the moment the answer goes old
     * (the bus leaves, or the data passes STALE_AFTER_MS). The redraw reads
     * the clock and dims it. No network: it just re-renders the cache.
     */
    fun scheduleDim(ctx: Context, answer: NextAnswer, fetchedAt: Long) {
        val at = listOfNotNull(answer.departsAtMs?.plus(31_000), fetchedAt + STALE_AFTER_MS + 1_000).min()
        val delay = (at - System.currentTimeMillis()).coerceAtLeast(0)
        val work = OneTimeWorkRequestBuilder<RedrawWorker>().setInitialDelay(delay, TimeUnit.MILLISECONDS).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork(DIM, ExistingWorkPolicy.REPLACE, work)
    }

    fun schedule(ctx: Context) {
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(ctx: Context) {
        WorkManager.getInstance(ctx).cancelUniqueWork(WORK)
    }
}

class RefreshWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        Refresher.refresh(applicationContext)
        return Result.success()
    }
}

class RedrawWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        redrawWidgets(applicationContext)
        return Result.success()
    }
}
