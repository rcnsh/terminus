package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId

/**
 * The Buses tab's data: a stop's board (`/arrivals`, or a `/me/nearby`
 * stop), a service's line (`/line`), the pages to swipe between, and the
 * search. Plain JSON in and plain values out, so it's tested on the JVM
 * (BusesTest); the screens only lay it out.
 *
 * Every time shown is one the API gave: the next bus and its `later` list.
 * Nothing here works out a time from a headway or for another stop.
 */

/** A stop's board. [distM] only for the nearest stop, from /me/nearby. */
data class Board(
    val code: String,
    val name: String,
    /** The stop across the road; null when it has none, or from an older server. */
    val opposite: String?,
    /** False when the feed couldn't be reached: no times, which isn't "no buses". */
    val available: Boolean,
    val rows: List<BoardRow>,
    val asOfMs: Long?,
    val distM: Int? = null,
    /** [opposite] is across the road; false when the two stops are only near each other. */
    val oppositeAcross: Boolean = true,
    /** [opposite]'s full name, for "This stop | Prince George's Park". */
    val oppositeName: String? = null,
) {
    companion object {
        fun parse(o: JSONObject): Board {
            val stop = o.optJSONObject("stop") ?: JSONObject()
            val code = stop.optString("code")
            val b = o.optJSONArray("board") ?: JSONArray()
            return Board(
                code = code,
                // The full name for the page's title; `name` is short (YIH).
                name = stop.optStringOrNull("longName")?.ifEmpty { null } ?: stop.optStringOrNull("name")?.ifEmpty { null } ?: code,
                opposite = stop.optStringOrNull("opposite")?.ifEmpty { null },
                oppositeAcross = stop.optBoolean("oppositeAcross", true),
                oppositeName = stop.optStringOrNull("oppositeName")?.ifEmpty { null },
                available = o.optBoolean("available", true),
                rows = (0 until b.length()).mapNotNull { i -> b.optJSONObject(i)?.let(::parseBoardRow) },
                asOfMs = o.optStringOrNull("asOf")?.let(::parseInstant),
            )
        }

        /** A stop from /me/nearby, as a board; its answer's time is [asOfMs]. */
        fun of(s: NearbyStop, asOfMs: Long?) = Board(s.code, s.longName ?: s.name, s.opposite, s.available, s.board, asOfMs, s.distM, s.oppositeAcross, s.oppositeName)
    }
}

/** A stop on a line, with the other shuttle services that call there. */
data class LineStop(val code: String, val name: String, val services: List<String>)

/**
 * A bus on a line: at stop [at] (an index into the line's stops), or
 * between stop [after] and the one after it, round to the first on a loop.
 */
data class LineBus(val id: String, val plate: String?, val crowd: String?, val at: Int?, val after: Int?)

/** The stop the line was opened from: its place on the line and its board row there. */
data class LineHere(val code: String, val index: Int, val row: BoardRow?)

/** `/line`: one service's stops in route order and where its buses are. */
data class Line(
    val svc: String,
    val color: Long,
    val endsAtMs: Long?,
    val stops: List<LineStop>,
    val buses: List<LineBus>,
    val here: LineHere?,
    val available: Boolean,
    val asOfMs: Long?,
    /** False: the service isn't running now; [stopped] and [resumesAtMs] say why and until when. */
    val running: Boolean = true,
    val stopped: String? = null,
    val resumesAtMs: Long? = null,
) {
    /**
     * The line as it's drawn, top to bottom: every stop with the buses at
     * it, and between two stops a row for the buses on the way. A bus whose
     * place isn't on the list (an index out of range) isn't drawn.
     */
    fun items(): List<LineItem> {
        val out = mutableListOf<LineItem>()
        for ((i, s) in stops.withIndex()) {
            out += LineItem.Stop(i, s, buses.filter { it.at == i }, here?.index == i)
            val between = buses.filter { it.at == null && it.after == i }
            if (between.isNotEmpty()) out += LineItem.Between(i, between)
        }
        return out
    }

    companion object {
        fun parse(o: JSONObject): Line {
            val s = o.optJSONArray("stops") ?: JSONArray()
            val b = o.optJSONArray("buses") ?: JSONArray()
            val stops = (0 until s.length()).mapNotNull { i ->
                val x = s.optJSONObject(i) ?: return@mapNotNull null
                val code = x.optString("code")
                LineStop(code, x.optStringOrNull("longName")?.ifEmpty { null } ?: x.optStringOrNull("name")?.ifEmpty { null } ?: code, x.optJSONArray("services").strings())
            }
            val here = o.optJSONObject("stop")?.let { h ->
                LineHere(h.optString("code"), h.optInt("index", -1), h.optJSONObject("row")?.let(::parseBoardRow))
            }
            return Line(
                svc = o.optString("svc"),
                color = parseColor(o.optStringOrNull("color")),
                endsAtMs = o.optStringOrNull("endsAt")?.let(::parseInstant),
                stops = stops,
                buses = (0 until b.length()).mapNotNull { i ->
                    val x = b.optJSONObject(i) ?: return@mapNotNull null
                    LineBus(
                        id = x.optString("id", "$i"),
                        plate = x.optStringOrNull("plate")?.ifEmpty { null },
                        crowd = x.optStringOrNull("crowd")?.takeIf { it == "low" || it == "medium" || it == "high" },
                        at = x.index("at")?.takeIf { it in stops.indices },
                        after = x.index("after")?.takeIf { it in stops.indices },
                    )
                },
                here = here?.takeIf { it.index in stops.indices },
                available = o.optBoolean("available", true),
                asOfMs = o.optStringOrNull("asOf")?.let(::parseInstant),
                running = o.optBoolean("running", true),
                stopped = o.optStringOrNull("stopped")?.takeIf { it in STOPPED },
                resumesAtMs = o.optStringOrNull("resumesAt")?.let(::parseInstant),
            )
        }
    }
}

sealed interface LineItem {
    data class Stop(val index: Int, val stop: LineStop, val buses: List<LineBus>, val here: Boolean) : LineItem
    /** Buses between stop [after] and the next. */
    data class Between(val after: Int, val buses: List<LineBus>) : LineItem
}

/** How the tab shows one time. */
object BusTimes {
    /** Under a minute away: "Arriving", not "0 min". */
    const val ARRIVING_S = 60

    /** Rounded to the nearest minute, never below 1 (under a minute is [ARRIVING_S]). */
    fun minutes(etaS: Int): Int = maxOf(1, (etaS + 30) / 60)

    /** The later buses as minutes, soonest first: "then 12, 20 min". Only the ones the API gave. */
    fun later(row: BoardRow, max: Int = 3): List<Int> = row.later.sortedBy { it.etaS }.take(max).map { minutes(it.etaS) }

    /** A later bus is from the timetable while the next one isn't: the "then" line says so. */
    fun laterScheduled(row: BoardRow): Boolean =
        row.quality != "scheduled" && row.later.take(3).any { it.quality == "scheduled" }

    /**
     * The services that stop within [withinMs] (two hours), soonest first,
     * once each: "Runs until 11:15 pm" only when it's worth knowing.
     */
    fun endingSoon(rows: List<BoardRow>, nowMs: Long, withinMs: Long = 2 * 3_600_000L): List<Pair<String, Long>> =
        rows.mapNotNull { r -> r.endsAtMs?.takeIf { it > nowMs && it - nowMs <= withinMs }?.let { r.svc to it } }
            .distinctBy { it.first }
            .sortedBy { it.second }

    /** Minutes past midnight in Singapore, for [hhmm] and [hhmm12]. */
    fun campusMinute(ms: Long): Int = Instant.ofEpochMilli(ms).atZone(ZoneId.of("Asia/Singapore")).let { it.hour * 60 + it.minute }

    /** How long ago [asOfMs] was, in whole seconds, never negative. */
    fun ageS(asOfMs: Long, nowMs: Long): Long = ((nowMs - asOfMs) / 1000).coerceAtLeast(0)
}

/**
 * What a service that isn't running says instead of a time: why
 * ("Stopped for today") and, when it's known, when it's back ("Back
 * tomorrow at 7:40 am"). Pure, for the tests; [Stopped.lines] words it.
 */
data class Stopped(val why: String, val back: Back?) {
    /** When it starts again: later [today] ("Starts at"), [tomorrow], or on [weekday] (0 = Sunday). */
    data class Back(val minute: Int, val today: Boolean, val tomorrow: Boolean, val weekday: Int)

    /** The two lines, in the app's language; [h12] for 7:40 am rather than 07:40. */
    fun lines(h12: Boolean): Pair<String, String?> {
        val first = L.s(
            when (why) {
                "notYet" -> R.string.buses_not_yet
                "noService" -> R.string.buses_no_service
                else -> R.string.buses_stopped_today
            },
        )
        val b = back ?: return first to null
        val time = if (h12) hhmm12(b.minute) else hhmm(b.minute)
        val second = when {
            b.today -> L.s(R.string.buses_starts_at, time)
            b.tomorrow -> L.s(R.string.buses_back_tomorrow, time)
            else -> L.s(R.string.buses_back_on, dayName(b.weekday), time)
        }
        return first to second
    }

    companion object {
        private val SG = ZoneId.of("Asia/Singapore")

        /** A row or line not running, at [nowMs]; null for one that is. The days are Singapore's. */
        fun of(running: Boolean, why: String?, resumesAtMs: Long?, nowMs: Long): Stopped? {
            if (running) return null
            val back = resumesAtMs?.takeIf { it > nowMs }?.let { at ->
                val then = Instant.ofEpochMilli(at).atZone(SG)
                val days = java.time.temporal.ChronoUnit.DAYS.between(Instant.ofEpochMilli(nowMs).atZone(SG).toLocalDate(), then.toLocalDate())
                Back(then.hour * 60 + then.minute, today = days <= 0L, tomorrow = days == 1L, weekday = then.dayOfWeek.value % 7)
            }
            return Stopped(why ?: "ended", back)
        }
    }
}

/** The account's pinned stops, as the profile keeps them. */
object Pins {
    /** PROFILE_LIMITS on the server. */
    const val MAX = 8

    /** Pinned: unpinned. Otherwise pinned at the end, unless there are [MAX] already. */
    fun toggle(pins: List<String>, code: String): List<String> =
        if (code in pins) pins - code else if (pins.size >= MAX) pins else pins + code

    /**
     * The pages to swipe between: the nearest stop first (null until it's
     * known, or when there's none), then each pinned stop, except the
     * nearest one again.
     */
    fun pages(nearest: String?, pins: List<String>): List<String?> = listOf(nearest) + pins.distinct().filter { it != nearest }
}

/** A search result: a stop opens its board, a service its line. */
sealed interface BusHit {
    data class Service(val svc: String) : BusHit
    data class Stop(val code: String, val name: String, val services: List<String>) : BusHit
}

/**
 * The tab's search, by the destination search's rules: exact, then starts
 * with, then a word starts with, then contains. A service matches by its
 * name (D1); a stop by its code, short name or full name.
 */
fun searchBuses(query: String, stops: List<MapStop>, services: List<String>, max: Int = 12): List<BusHit> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    fun score(text: String): Int? {
        val t = text.lowercase()
        return when {
            t == q -> 0
            t.startsWith(q) -> 1
            t.split(' ', '-', '/', '(').any { it.startsWith(q) } -> 2
            q.length >= 2 && t.contains(q) -> 3
            else -> null
        }
    }
    // A service by its name only from its start: "1" isn't A1, D1 and K1.
    val svc = services.mapNotNull { s -> score(s)?.takeIf { it <= 1 }?.let { Triple(it, 0, s) to BusHit.Service(s) } }
    val stop = stops.mapNotNull { s ->
        listOfNotNull(score(s.name), score(s.code), s.longName?.let(::score)).minOrNull()?.let { Triple(it, 1, s.fullName) to BusHit.Stop(s.code, s.fullName, s.services) }
    }
    // As good a match either way, the service first: its name is the whole of what was typed.
    return (svc + stop).sortedWith(compareBy({ it.first.first }, { it.first.second }, { it.first.third })).map { it.second }.take(max)
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { i -> optString(i).takeIf { it.isNotEmpty() && !isNull(i) } }

private fun JSONObject.index(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key, -1).takeIf { it >= 0 }
