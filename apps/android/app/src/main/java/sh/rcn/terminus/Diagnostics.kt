package sh.rcn.terminus

import android.app.AlarmManager
import android.content.Context
import android.os.PowerManager
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The app's last requests to our server, kept in memory for the developer menu (Settings, About) and the diagnostics it copies. Only the
 * path is kept, never the query: /api/me/next is asked with where you are.
 */
object RequestLog {
    /** One attempt at one address: [status] null when no answer came ([failure] says why, null when cancelled or past the deadline). */
    data class Entry(
        val atMs: Long,
        val method: String,
        val path: String,
        val host: String,
        val status: Int?,
        val tookMs: Long,
        val failure: String? = null,
    )

    const val MAX = 50

    private val entries = ArrayDeque<Entry>()
    private val _changes = MutableStateFlow(0)

    /** Bumped on every entry, so an open developer menu redraws. */
    val changes: StateFlow<Int> = _changes

    fun record(
        method: String,
        path: String,
        base: String,
        status: Int?,
        tookMs: Long,
        failure: Throwable?,
        atMs: Long = System.currentTimeMillis(),
    ) {
        val entry = Entry(atMs, method, pathOnly(path), hostOf(base), status, tookMs, failure?.javaClass?.simpleName)
        synchronized(entries) {
            entries.addFirst(entry)
            while (entries.size > MAX) entries.removeLast()
        }
        _changes.value++
    }

    /** Newest first. */
    fun entries(): List<Entry> = synchronized(entries) { entries.toList() }

    fun clear() {
        synchronized(entries) { entries.clear() }
        _changes.value++
    }

    fun pathOnly(path: String): String = path.substringBefore('?').substringBefore('#')

    fun hostOf(base: String): String = base.substringAfter("://").substringBefore('/')
}

/**
 * What the developer menu shows about the app's state, and the text it copies for a bug report: the version and phone, the server and its
 * clock, what the alerts and push need, and the last answer. Nothing that identifies the account, and no place.
 */
object Diagnostics {
    /** On or off, or not known (null): an older Android without the setting. */
    data class Facts(
        val version: String,
        val build: Int,
        val flavor: String,
        val debug: Boolean,
        val android: String,
        val device: String,
        val language: String,
        val server: String,
        val skewMs: Long,
        val signedIn: Boolean,
        val anonymous: Boolean,
        val notifications: Boolean,
        val leaveAlerts: Boolean,
        val liveUpdates: Boolean,
        val exactAlarms: Boolean?,
        val batteryUnrestricted: Boolean?,
        val pushAvailable: Boolean,
        val pushActive: Boolean,
        val pushSentAt: Long,
        val pushHeardAt: Long,
        val refreshAlarmAt: Long,
        val answerAt: Long,
        val quality: String?,
        val staleAt: Long?,
        val remindAt: Long?,
        val lastError: String?,
    )

    fun facts(ctx: Context): Facts {
        val store = Store(ctx)
        val last = store.lastAnswer()
        val power = ctx.getSystemService(PowerManager::class.java)
        return Facts(
            version = BuildConfig.VERSION_NAME,
            build = BuildConfig.VERSION_CODE,
            flavor = BuildConfig.FLAVOR,
            debug = BuildConfig.DEBUG,
            android = "${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})",
            device = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}",
            language = L.header(),
            server = Servers.base,
            skewMs = ServerClock.skewMs,
            signedIn = store.paired,
            anonymous = store.anonymous,
            notifications = LeaveAlerts.canNotify(ctx),
            leaveAlerts = store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL),
            liveUpdates = store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL),
            exactAlarms = ctx.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms(),
            batteryUnrestricted = power?.isIgnoringBatteryOptimizations(ctx.packageName),
            pushAvailable = Push.available(ctx),
            pushActive = Push.active(ctx),
            pushSentAt = store.pushSentAt,
            pushHeardAt = store.pushHeardAt,
            refreshAlarmAt = store.refreshAlarmAt,
            answerAt = last?.second ?: 0,
            quality = last?.first?.card?.quality ?: last?.first?.quality,
            staleAt = last?.first?.card?.staleAtMs,
            remindAt = last?.first?.card?.remindAtMs,
            lastError = store.lastError,
        )
    }

    /** The text Copy diagnostics puts on the clipboard: English, for the operator, with times in Singapore's. */
    fun report(f: Facts, requests: List<RequestLog.Entry>, now: Long): String = buildString {
        fun line(k: String, v: Any?) = append(k).append(": ").append(v ?: "-").append('\n')
        fun on(b: Boolean?) =
            when (b) {
                true -> "yes"
                false -> "no"
                null -> "-"
            }
        line("terminus", "${f.version} (${f.build}) ${f.flavor}${if (f.debug) " debug" else ""}")
        line("android", f.android)
        line("device", f.device)
        line("language", f.language)
        line("at", stamp(now))
        line("server", f.server)
        line("clock", skew(f.skewMs))
        line("signed in", if (!f.signedIn) "no" else if (f.anonymous) "anonymous" else "yes")
        line("notifications", on(f.notifications))
        line("leave alerts", on(f.leaveAlerts))
        line("live notification", on(f.liveUpdates))
        line("exact alarms", on(f.exactAlarms))
        line("battery unrestricted", on(f.batteryUnrestricted))
        line("push", if (!f.pushAvailable) "unavailable" else if (f.pushActive) "active" else "not active")
        line("push sent", ago(f.pushSentAt, now))
        line("push heard", ago(f.pushHeardAt, now))
        line("next refresh", if (f.refreshAlarmAt > 0) stamp(f.refreshAlarmAt) else null)
        line("answer", ago(f.answerAt, now))
        line("quality", f.quality)
        line("stale at", f.staleAt?.let(::stamp))
        line("remind at", f.remindAt?.let(::stamp))
        line("last error", f.lastError)
        append("\nrequests (newest first):\n")
        if (requests.isEmpty()) append("none\n")
        for (r in requests) append(entry(r)).append('\n')
    }

    /** One request as a line: when, what, where, and how it went. */
    fun entry(r: RequestLog.Entry): String = "${time(r.atMs)} ${r.method} ${r.path} ${r.host} ${outcome(r)} ${r.tookMs} ms"

    /** The status, or why there was none. */
    fun outcome(r: RequestLog.Entry): String = r.status?.toString() ?: r.failure ?: "no answer"

    /** "+42 s" when the phone is behind the server, "-42 s" ahead, "right" within [ServerClock.MIN_SKEW_MS]. */
    fun skew(ms: Long): String = if (ms == 0L) "right" else "${if (ms > 0) "+" else "-"}${kotlin.math.abs(ms) / 1000} s"

    /** How long ago [at] was, as "3 min ago" (seconds under a minute, hours over an hour); null for never. */
    fun ago(at: Long, now: Long): String? {
        if (at <= 0) return null
        val s = ((now - at) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "$s s ago"
            s < 3600 -> "${s / 60} min ago"
            s < 48 * 3600 -> "${s / 3600} h ago"
            else -> "${s / 86_400} d ago"
        }
    }

    private val SG = ZoneId.of("Asia/Singapore")
    private val STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(SG)
    private val TIME = DateTimeFormatter.ofPattern("HH:mm:ss").withZone(SG)

    fun stamp(ms: Long): String = STAMP.format(Instant.ofEpochMilli(ms))

    fun time(ms: Long): String = TIME.format(Instant.ofEpochMilli(ms))
}
