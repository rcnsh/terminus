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

    /** How far a fix drifts per second of age: a walking pace. */
    private const val DRIFT_M_PER_S = 1.3

    /** The providers to ask, best first. */
    private val PROVIDERS = listOf(LocationManager.FUSED_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)

    /**
     * How far out a fix may be, in metres: its accuracy, plus how far you
     * could have walked since it was taken. Sent to the API as `acc`, which
     * drops a fix too rough to say where you are (a cell-tower fix, or one
     * from ten minutes ago) and follows the timetable instead.
     */
    fun uncertaintyM(loc: Location, nowMs: Long = System.currentTimeMillis()): Double {
        val ageS = ((nowMs - loc.time).coerceAtLeast(0)) / 1000.0
        return (if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0) + ageS * DRIFT_M_PER_S
    }

    /** `uncertaintyM` of a fix, rounded, for the API; null without one. */
    fun accOf(loc: Location?): Double? = loc?.let { Math.round(uncertaintyM(it)).toDouble() }

    fun hasForeground(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** For the widget and worker: a cached fix only, never a new GPS request. */
    fun lastKnown(ctx: Context, maxAgeMs: Long = MAX_AGE_MS): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        return try {
            val now = System.currentTimeMillis()
            // The one that could be least wrong now: a fresh network fix over
            // a precise GPS fix from before the walk here.
            PROVIDERS
                .filter { lm.allProviders.contains(it) }
                .mapNotNull { lm.getLastKnownLocation(it) }
                .filter { now - it.time < maxAgeMs }
                .minByOrNull { uncertaintyM(it, now) }
        } catch (_: SecurityException) {
            null
        }
    }

    /** For the app in the foreground: a fresh fix, or the last known one. */
    suspend fun current(ctx: Context): Location? {
        if (!hasForeground(ctx)) return null
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        val provider = PROVIDERS
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
