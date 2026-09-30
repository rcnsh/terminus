package sh.rcn.terminus

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * "Notice when I board" (phase 8.1): location updates while the live
 * notification follows a trip, for the server to tell whether you're on the
 * bus, missed it or are there (the API's detect.ts). Only ever inside the
 * live notification's foreground service, which asks for the location type
 * only when a tap started it (the app, the notification or the widget), so
 * this never needs background location.
 */
class TripWatch(private val ctx: Context) {
    private var latest: Location? = null
    private var previous: Location? = null
    private val listener = LocationListener { loc ->
        previous = latest
        latest = loc
    }

    /** False when there's no provider or permission: the notification then just follows the timetable. */
    fun start(): Boolean {
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return false
        val provider = listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER)
            .firstOrNull { lm.allProviders.contains(it) && lm.isProviderEnabled(it) } ?: return false
        return try {
            lm.requestLocationUpdates(provider, INTERVAL_MS, 0f, ctx.mainExecutor, listener)
            true
        } catch (_: SecurityException) {
            false
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    fun stop() {
        runCatching { ctx.getSystemService(LocationManager::class.java)?.removeUpdates(listener) }
        latest = null
        previous = null
    }

    /** The latest fix if it's recent, with its speed: the provider's, or worked out from the one before. */
    fun fix(now: Long): Fix? {
        val cur = latest ?: return null
        if (now - cur.time > MAX_AGE_MS) return null
        val prev = previous
        val speed = when {
            cur.hasSpeed() -> cur.speed.toDouble()
            prev != null -> speedBetween(prev.latitude, prev.longitude, prev.time, cur.latitude, cur.longitude, cur.time)
            else -> null
        }
        return Fix(cur.latitude, cur.longitude, speed, if (cur.hasAccuracy()) cur.accuracy.toDouble() else null)
    }

    data class Fix(val lat: Double, val lon: Double, val speedMs: Double?, val accM: Double?)

    companion object {
        /** A fix about this often: enough to see a bus pass one stop. */
        const val INTERVAL_MS = 10_000L
        /** Older than this, a fix says where you were, not where you are. */
        const val MAX_AGE_MS = 45_000L

        /** Metres per second between two fixes, or null when they're too close together in time or too far apart. */
        fun speedBetween(lat1: Double, lon1: Double, t1: Long, lat2: Double, lon2: Double, t2: Long): Double? {
            val dt = (t2 - t1) / 1000.0
            if (dt < 3 || dt > 120) return null
            return metres(lat1, lon1, lat2, lon2) / dt
        }

        fun metres(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
            val r = 6_371_000.0
            val dLat = Math.toRadians(lat2 - lat1)
            val dLon = Math.toRadians(lon2 - lon1)
            val s = sin(dLat / 2).let { it * it } + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).let { it * it }
            return 2 * r * asin(min(1.0, sqrt(s)))
        }
    }
}
