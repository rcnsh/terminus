package sh.rcn.terminus

import android.content.Context
import android.content.SharedPreferences
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

object ServerClock : ClockSkew()

open class ClockSkew(private val wall: () -> Long = { System.currentTimeMillis() }) {
    companion object {
        const val MIN_SKEW_MS = 3_000L
        private const val KEY = "clock-skew"
    }

    @Volatile
    var skewMs = 0L
        private set

    private var prefs: SharedPreferences? = null

    fun init(ctx: Context) {
        prefs = terminusPrefs(ctx).also { skewMs = it.getLong(KEY, 0L) }
    }

    fun now(): Long = wall() + skewMs

    fun toDevice(serverMs: Long): Long = serverMs - skewMs

    fun fromDevice(deviceMs: Long): Long = deviceMs + skewMs

    fun observe(date: String?, localMs: Long, cached: Boolean = false) {
        if (cached) return
        val skew = skewOf(date, localMs) ?: return
        if (skew == skewMs) return
        skewMs = skew
        prefs?.edit()?.putLong(KEY, skew)?.apply()
    }

    fun skewOf(date: String?, localMs: Long): Long? {
        val server =
            date?.let {
                runCatching { ZonedDateTime.parse(it.trim(), DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli() }.getOrNull()
            } ?: return null
        val skew = server - localMs
        return if (kotlin.math.abs(skew) < MIN_SKEW_MS) 0L else skew
    }
}
