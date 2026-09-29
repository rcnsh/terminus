package sh.rcn.terminus

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Location without Play Services. Every path returns null rather than
 * throwing: without a location the API falls back to the timetable, which is
 * a fine answer, so a missing fix must never become an error.
 */
object Locator {
    /** A last-known fix younger than this is good enough for the widget. */
    private const val MAX_AGE_MS = 10 * 60_000L

    fun hasForeground(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun hasBackground(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    /** For the widget and worker: a cached fix only, never a new GPS request. */
    fun lastKnown(ctx: Context, maxAgeMs: Long = MAX_AGE_MS): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        return try {
            listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
                .filter { lm.allProviders.contains(it) }
                .mapNotNull { lm.getLastKnownLocation(it) }
                .filter { System.currentTimeMillis() - it.time < maxAgeMs }
                .minByOrNull { it.accuracy }
        } catch (_: SecurityException) {
            null
        }
    }

    /** For the app in the foreground: a fresh fix, or the last known one. */
    suspend fun current(ctx: Context): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        val provider = listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { lm.allProviders.contains(it) && lm.isProviderEnabled(it) } ?: return lastKnown(ctx)
        val fresh = withTimeoutOrNull(6_000) {
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
        return fresh ?: lastKnown(ctx)
    }

    private fun granted(ctx: Context, perm: String) =
        ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED
}
