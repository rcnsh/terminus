package sh.rcn.terminus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

object Locator {
    private const val MAX_AGE_MS = 10 * 60_000L

    private const val DRIFT_M_PER_S = 1.3

    private const val UNKNOWN_ACC_M = 1_000.0

    private val PROVIDERS = listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)

    fun uncertaintyM(loc: Location, nowMs: Long = System.currentTimeMillis()): Double {
        val ageS = ((nowMs - loc.time).coerceAtLeast(0)) / 1000.0
        return (if (loc.hasAccuracy()) loc.accuracy.toDouble() else UNKNOWN_ACC_M) + ageS * DRIFT_M_PER_S
    }

    fun accOf(loc: Location?): Double? = loc?.let { Math.round(uncertaintyM(it)).toDouble() }

    fun hasForeground(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    fun lastKnown(ctx: Context, maxAgeMs: Long = MAX_AGE_MS): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        return try {
            val now = System.currentTimeMillis()
            PROVIDERS.filter { lm.allProviders.contains(it) }
                .mapNotNull { lm.getLastKnownLocation(it) }
                .filter { now - it.time < maxAgeMs }
                .minByOrNull { uncertaintyM(it, now) }
        } catch (_: SecurityException) {
            null
        }
    }

    suspend fun current(ctx: Context): Location? = fresh(ctx) ?: lastKnown(ctx)

    suspend fun fresh(ctx: Context): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        val provider = PROVIDERS.firstOrNull { lm.allProviders.contains(it) && lm.isProviderEnabled(it) } ?: return null
        return withTimeoutOrNull(6_000) {
            suspendCancellableCoroutine { cont ->
                val cancel = CancellationSignal()
                cont.invokeOnCancellation { cancel.cancel() }
                try {
                    lm.getCurrentLocation(provider, cancel, ctx.mainExecutor) { cont.resume(it) }
                } catch (_: SecurityException) {
                    cont.resume(null)
                }
            }
        }
    }

    private fun granted(ctx: Context, perm: String) = ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
}
