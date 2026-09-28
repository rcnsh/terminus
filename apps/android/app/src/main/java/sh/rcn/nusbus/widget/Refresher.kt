package sh.rcn.nusbus.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import sh.rcn.nusbus.Api
import sh.rcn.nusbus.ApiError
import sh.rcn.nusbus.Locator
import sh.rcn.nusbus.Store
import sh.rcn.nusbus.Target
import java.util.concurrent.TimeUnit

object Refresher {
    private const val WORK = "nusbus-refresh"

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
            store.saveAnswer(json, System.currentTimeMillis())
            store.lastError = null
        } catch (e: ApiError) {
            if (e.status == 401) store.token = null
            store.lastError = if (e.status == 401) "Device removed. Pair again in the app." else e.message
        } catch (e: Exception) {
            store.lastError = "Offline"
        }
        redrawWidgets(ctx)
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
