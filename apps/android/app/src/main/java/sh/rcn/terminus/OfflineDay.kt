package sh.rcn.terminus

import java.time.Instant
import java.time.ZoneOffset

/**
 * What the widget and the app show when they're offline and the last answer
 * has gone stale: the next thing on the day plan kept from /me/day. The web
 * and Mac apps follow the same rule (app/offline.js, OfflineDay.swift),
 * checked against the same cases (apps/api/test/fixtures/offline-day.json).
 */
object OfflineDay {
    /** A class still counts this long after it starts: late, but still the one to go to. */
    const val CLASS_GRACE_MS = 15 * 60_000L
    /** A trip home with no end of its own stays up this long. */
    const val HOME_FOR_MS = 60 * 60_000L

    enum class Step { LeaveBy, LeaveNow, Home }

    data class Pick(val item: DayItem, val step: Step)

    fun sgtDate(now: Long): String = Instant.ofEpochMilli(now).atOffset(ZoneOffset.ofHours(8)).toLocalDate().toString()

    /** The plan's next item at [now] and which line to show; null when it's another day's or nothing is ahead. */
    fun next(day: DayPlan?, now: Long): Pick? {
        if (day == null || day.date != sgtDate(now)) return null
        for (item in day.items) {
            if (item.status == "done" || item.status == "skipped") continue
            if (item.kind == "class") {
                if (now >= item.startsAtMs + CLASS_GRACE_MS) continue
                val leave = item.leaveAtMs
                return Pick(item, if (leave != null && now < leave) Step.LeaveBy else Step.LeaveNow)
            }
            val end = item.endsAtMs ?: (item.startsAtMs + HOME_FOR_MS)
            if (now >= end) continue
            return Pick(item, Step.Home)
        }
        return null
    }

    /** When [next] next gives something else (a leave-by passing, a class or a trip home ending), for a redraw then. */
    fun nextChangeAt(day: DayPlan?, now: Long): Long? {
        if (day == null || day.date != sgtDate(now)) return null
        val marks = day.items.filter { it.status != "done" && it.status != "skipped" }.flatMap { item ->
            if (item.kind == "class") listOfNotNull(item.leaveAtMs, item.startsAtMs + CLASS_GRACE_MS)
            else listOf(item.endsAtMs ?: (item.startsAtMs + HOME_FOR_MS))
        }
        return marks.filter { it > now }.minOrNull()
    }

    /**
     * What it's for, the headline, and how: worded as the Today list words
     * them. Always an estimate (it was planned a while ago), so always "~";
     * the class's start time is there so a "Leave now" after it has started
     * reads as late, and a trip home says from when.
     */
    data class Lines(val head: String, val big: String, val how: String?)

    fun lines(p: Pick, clock: (Long) -> String): Lines {
        val item = p.item
        if (p.step == Step.Home) return Lines(clock(item.startsAtMs), L.s(R.string.home_from, item.fromName ?: L.s(R.string.your_last_class)), null)
        val at = item.leaveAtMs
        val big = if (p.step == Step.LeaveBy && at != null) L.s(R.string.leave_by, L.s(R.string.approx, clock(at))) else L.s(R.string.leave_now)
        val how = item.svc?.let { L.s(R.string.svc_from, it, item.leaveStop ?: item.fromName.orEmpty()) } ?: at?.let { L.s(R.string.walk) }
        // Capitalised: on a line of its own, not after "Leave by …" as in Today.
        return Lines("${item.label} · ${L.s(R.string.starts_at, clock(item.startsAtMs))}", big, how?.replaceFirstChar { it.titlecase() })
    }
}
