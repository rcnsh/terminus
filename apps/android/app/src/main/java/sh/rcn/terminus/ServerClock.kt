package sh.rcn.terminus

import android.content.Context
import android.content.SharedPreferences
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * The time on the server's clock, for everything that compares the server's
 * times (when the bus leaves, when to leave, when the card goes stale) with
 * now. A phone set a few minutes wrong would otherwise count down to the
 * wrong moment, and say "Leave now" early or late.
 *
 * How far out the phone is comes from the `Date` header of the API's own
 * replies. Date has one-second resolution, so a difference under
 * [MIN_SKEW_MS] is taken as none. Alarms run on the phone's clock: a server
 * time goes through [toDevice] first.
 */
object ServerClock {
    /** Under this, the difference is Date's rounding and the trip, not a wrong clock. */
    const val MIN_SKEW_MS = 3_000L
    private const val KEY = "clock-skew"

    /** Server time minus the phone's; 0 when the phone is right. */
    @Volatile var skewMs = 0L
        private set

    private var prefs: SharedPreferences? = null

    /** The last skew seen, kept so a widget drawn before any request is right too. */
    fun init(ctx: Context) {
        prefs = terminusPrefs(ctx).also { skewMs = it.getLong(KEY, 0L) }
    }

    /** Now, on the server's clock. */
    fun now(): Long = System.currentTimeMillis() + skewMs

    /** A server time on the phone's clock, for AlarmManager. */
    fun toDevice(serverMs: Long): Long = serverMs - skewMs

    /** A time taken on the phone's clock, on the server's. */
    fun fromDevice(deviceMs: Long): Long = deviceMs + skewMs

    /**
     * A reply's `Date` header, read at [localMs] on the phone's clock. A reply
     * that came from a cache ([cached]) was dated earlier, so it says nothing.
     */
    fun observe(date: String?, localMs: Long, cached: Boolean = false) {
        if (cached) return
        val skew = skewOf(date, localMs) ?: return
        if (skew == skewMs) return
        skewMs = skew
        prefs?.edit()?.putLong(KEY, skew)?.apply()
    }

    /** Server time minus [localMs], 0 under [MIN_SKEW_MS]; null when [date] isn't an HTTP date. */
    fun skewOf(date: String?, localMs: Long): Long? {
        val server = date?.let { runCatching { ZonedDateTime.parse(it.trim(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull() } ?: return null
        val skew = server - localMs
        return if (kotlin.math.abs(skew) < MIN_SKEW_MS) 0L else skew
    }

    /** For tests. */
    internal fun reset(skew: Long = 0L) {
        skewMs = skew
    }
}
