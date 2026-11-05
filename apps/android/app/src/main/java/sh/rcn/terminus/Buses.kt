package sh.rcn.terminus

import java.time.Instant
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Stops tab's data: a stop's board (`/api/arrivals`, or a `/api/me/nearby` stop), a service's line (`/api/line`), the pinned stops on
 * its home, and the search. Plain JSON in and plain values out, so it's tested on the JVM (BusesTest); the screens only lay it out.
 *
 * Every time shown is one the API gave: the next bus and its `later` list. Nothing here works out a time from a headway or for another
 * stop.
 */

/** A stop's board. [distM] only for the nearest stop, from /api/me/nearby. */
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
    /** When this phone got the board, on the server's clock ([ServerClock]); null: not known. See [BusTimes.aged]. */
    val gotMs: Long? = null,
) {
    /** The board as it stands at [nowMs]: its rows [BusTimes.aged]. */
    fun aged(nowMs: Long): Board = if (gotMs == null) this else copy(rows = rows.map { BusTimes.aged(it, gotMs, nowMs) })

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

        /** A stop from /api/me/nearby, as a board; its answer's time is [asOfMs]. */
        fun of(s: NearbyStop, asOfMs: Long?) =
            Board(s.code, s.longName ?: s.name, s.opposite, s.available, s.board, asOfMs, s.distM, s.oppositeAcross, s.oppositeName)
    }
}

/** A stop on a line, with the other shuttle services that call there. */
data class LineStop(val code: String, val name: String, val services: List<String>)

/**
 * A bus on a line: at stop [at] (an index into the line's stops), or between stop [after] and the one after it. A loop's line ends with its
 * first stop again, so a bus on its last stretch is between the last two.
 */
data class LineBus(val id: String, val plate: String?, val crowd: String?, val at: Int?, val after: Int?)

/** The stop the line was opened from: its place on the line and its board row there. */
data class LineHere(val code: String, val index: Int, val row: BoardRow?)

/** `/api/line`: one service's stops in route order and where its buses are. */
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
    /** When this phone got the line, on the server's clock; null: not known. See [BusTimes.aged]. */
    val gotMs: Long? = null,
    /** Its buses out, as /api/lines words them, for the list of lines ([Outs]); null from an older server or with no feed. */
    val out: LineOut? = null,
) {
    /** The line as it stands at [nowMs]: your stop's row [BusTimes.aged]. */
    fun aged(nowMs: Long): Line =
        if (gotMs == null || here?.row == null) this else copy(here = here.copy(row = BusTimes.aged(here.row, gotMs, nowMs)))

    /**
     * The line as it's drawn, top to bottom: every stop with the buses at it, and between two stops a row for the buses on the way. A bus
     * whose place isn't on the list (an index out of range) isn't drawn.
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
        /**
         * Service [svc]'s line as the campus data already says it, while /api/line is on its way: its stops in order (a loop's first again
         * at the end, as /api/line lists it), each named and with the other services there as /api/line has them, opened from [from]. No
         * buses, no times: only the server knows those. Null when the campus data doesn't have the service.
         */
        fun fromCampus(campus: CampusMap, svc: String, from: String?): Line? {
            val route = campus.lines.firstOrNull { it.svc == svc }?.takeIf { it.seq.isNotEmpty() } ?: return null
            val seq = if (route.loop && route.seq.size > 1) route.seq + route.seq.first() else route.seq
            val stops = seq.map { code ->
                val stop = campus.stop(code)
                LineStop(code, stop?.fullName ?: code, stop?.services.orEmpty().filter { it != svc })
            }
            val here = from?.let { seq.indexOf(it) }?.takeIf { it >= 0 }?.let { LineHere(from, it, null) }
            return Line(svc, campus.routes[svc]?.color ?: 0xFF8A939C, null, stops, emptyList(), here, available = true, asOfMs = null)
        }

        fun parse(o: JSONObject): Line {
            val s = o.optJSONArray("stops") ?: JSONArray()
            val b = o.optJSONArray("buses") ?: JSONArray()
            val stops =
                (0 until s.length()).mapNotNull { i ->
                    val x = s.optJSONObject(i) ?: return@mapNotNull null
                    val code = x.optString("code")
                    LineStop(
                        code,
                        x.optStringOrNull("longName")?.ifEmpty { null } ?: x.optStringOrNull("name")?.ifEmpty { null } ?: code,
                        x.optJSONArray("services").strings(),
                    )
                }
            val here =
                o.optJSONObject("stop")?.let { h ->
                    LineHere(h.optString("code"), h.optInt("index", -1), h.optJSONObject("row")?.let(::parseBoardRow))
                }
            return Line(
                svc = o.optString("svc"),
                color = parseColor(o.optStringOrNull("color")),
                endsAtMs = o.optStringOrNull("endsAt")?.let(::parseInstant),
                stops = stops,
                buses =
                    (0 until b.length()).mapNotNull { i ->
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
                out = LineOut.of(o.optJSONObject("out")),
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
    /** Under this long away: "Arriving", not "0 min" (the server's own threshold, format.ts). */
    const val ARRIVING_S = 45

    /** The tab refreshes the page in view this often (the API caches arrivals 15 s). */
    const val REFRESH_MS = 15_000L

    /**
     * Times got longer ago than this have missed a refresh at least: counted down here from when they came, and no longer shown as live.
     */
    const val OLD_MS = 2 * REFRESH_MS

    /**
     * Row [r] from an answer this phone got at [gotMs], as it stands at [nowMs] (both on the server's clock). The server counts its times
     * down to when it answered, so they're counted from [gotMs], never from the feed's `asOf` (that would take the same seconds off twice).
     * Once the answer is [OLD_MS] old (refreshes failing), its times are counted down, a bus over a minute past has no time, and a live
     * time says "Last known": nothing old passes for live. As the web's `aged()`.
     */
    fun aged(r: BoardRow, gotMs: Long, nowMs: Long): BoardRow {
        val ms = nowMs - gotMs
        if (r.etaS == null || ms <= OLD_MS) return r
        val s = (ms / 1000).toInt()
        val left = r.etaS - s
        return r.copy(
            etaS = if (left > -60) maxOf(0, left) else null,
            // Worded here from etaS, not the server's words from then.
            eta = null,
            quality = if (r.quality == "live") "stale" else r.quality,
            laterText = null,
            later =
                r.later
                    .map { it.copy(etaS = it.etaS - s, eta = null, quality = if (it.quality == "live") "stale" else it.quality) }
                    .filter { it.etaS > 0 },
        )
    }

    /** Rounded to the nearest minute, never below 1 (under [ARRIVING_S] is "Arriving"). */
    fun minutes(etaS: Int): Int = maxOf(1, (etaS + 30) / 60)

    /**
     * A bus seen under [ARRIVING_S] away, said "Arriving". Only a live time: an estimate that close is "~1 min", never one that passes for
     * a bus at the stop.
     */
    fun arriving(etaS: Int?, quality: String): Boolean = etaS != null && etaS < ARRIVING_S && quality == "live"

    /** How many later buses "then …" names, as the server's (THEN_MAX in the API's src/answer/resolve.ts). */
    const val THEN_MAX = 2

    /** The later buses as minutes, soonest first: "then 12, 20 min". Only the ones the API gave. */
    fun later(row: BoardRow, max: Int = THEN_MAX): List<Int> = row.later.sortedBy { it.etaS }.take(max).map { minutes(it.etaS) }

    /** A later bus is from the timetable while the next one isn't: the "then" line says so. */
    fun laterScheduled(row: BoardRow): Boolean = row.quality != "scheduled" && row.later.take(THEN_MAX).any { it.quality == "scheduled" }

    /**
     * The services that stop within [withinMs] (two hours), soonest first, once each: "Runs until 11:15 pm" only when it's worth knowing.
     */
    fun endingSoon(rows: List<BoardRow>, nowMs: Long, withinMs: Long = 2 * 3_600_000L): List<Pair<String, Long>> =
        rows
            .mapNotNull { r -> r.endsAtMs?.takeIf { it > nowMs && it - nowMs <= withinMs }?.let { r.svc to it } }
            .sortedBy { it.second }
            .distinctBy { it.first }

    /** Minutes past midnight in Singapore, for [hhmm] and [hhmm12]. */
    fun campusMinute(ms: Long): Int = Instant.ofEpochMilli(ms).atZone(ZoneId.of("Asia/Singapore")).let { it.hour * 60 + it.minute }

    /** How long ago [asOfMs] was, in whole seconds, never negative. */
    fun ageS(asOfMs: Long, nowMs: Long): Long = ((nowMs - asOfMs) / 1000).coerceAtLeast(0)
}

/**
 * What a service that isn't running says instead of a time: why ("Stopped for today") and, when it's known, when it's back ("Back tomorrow
 * at 7:40 am"). Pure, for the tests; [Stopped.lines] words it.
 */
data class Stopped(val why: String, val back: Back?) {
    /** When it starts again: later [today] ("Starts at"), [tomorrow], or on [weekday] (0 = Sunday). */
    data class Back(val minute: Int, val today: Boolean, val tomorrow: Boolean, val weekday: Int)

    /** The two lines, in the app's language; [h12] for 7:40 am rather than 07:40. */
    fun lines(h12: Boolean): Pair<String, String?> {
        val first =
            L.s(
                when (why) {
                    "notYet" -> R.string.buses_not_yet
                    "noService" -> R.string.buses_no_service
                    else -> R.string.buses_stopped_today
                }
            )
        val b = back ?: return first to null
        val time = if (h12) hhmm12(b.minute) else hhmm(b.minute)
        val second =
            when {
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
            val back =
                resumesAtMs
                    ?.takeIf { it > nowMs }
                    ?.let { at ->
                        val then = Instant.ofEpochMilli(at).atZone(SG)
                        val days =
                            java.time.temporal.ChronoUnit.DAYS.between(
                                Instant.ofEpochMilli(nowMs).atZone(SG).toLocalDate(),
                                then.toLocalDate(),
                            )
                        Back(then.hour * 60 + then.minute, today = days <= 0L, tomorrow = days == 1L, weekday = then.dayOfWeek.value % 7)
                    }
            return Stopped(why ?: "ended", back)
        }
    }
}

/** The account's pinned stops, as the profile keeps them. */
object Pins {
    /** Pinned: unpinned. Otherwise pinned at the end, unless there are [max] already (the profile's limit). */
    fun toggle(pins: List<String>, code: String, max: Int = Limits.DEFAULT.pinnedStops): List<String> = set(pins, code, code !in pins, max)

    /**
     * [code] pinned ([on]) or not, whatever [pins] says now: a pin made again on a profile another device saved meanwhile (which may have
     * pinned it too) stays a pin rather than toggling back off.
     */
    fun set(pins: List<String>, code: String, on: Boolean, max: Int = Limits.DEFAULT.pinnedStops): List<String> =
        when {
            !on -> pins - code
            code in pins || pins.size >= max -> pins
            else -> pins + code
        }

    /** The pinned stops the Stops tab's home shows and refreshes, in the profile's order: each once, no more than [max]. */
    fun shown(pins: List<String>, max: Int = Limits.DEFAULT.pinnedStops): List<String> = pins.distinct().take(max)
}

/**
 * The Stops tab's pinned stops as pages, one card at a time: a page per pinned stop in pin order, then a last one saying how to pin another
 * ([ADD]). The page showing is kept by its stop's code, so it stays on the same stop when the pins change around it.
 */
object PinPages {
    /** The last page, "Pin another stop". */
    const val ADD = ""

    /** The page for [selected] among [pins]: its own, the last for [ADD], else the first. */
    fun index(pins: List<String>, selected: String?): Int = if (selected == ADD) pins.size else pins.indexOf(selected).coerceAtLeast(0)

    /** What page [page] shows: a pinned stop's code, or [ADD]. */
    fun at(pins: List<String>, page: Int): String = pins.getOrNull(page) ?: ADD

    /**
     * The page to show once the pins have gone from [before] to [after]: the same one while it's still there; for a stop unpinned, the one
     * that came after it, else the one before it; null (the first) when nothing was chosen or nothing is left.
     */
    fun kept(before: List<String>, after: List<String>, selected: String?): String? {
        if (selected == null || selected == ADD || selected in after) return selected
        val i = before.indexOf(selected)
        if (i < 0) return after.firstOrNull()
        return (before.drop(i + 1) + before.take(i).reversed()).firstOrNull { it in after } ?: after.firstOrNull()
    }

    /** The stops to ask for with page [page] showing: its own and its two neighbours', so a swipe shows the next at once. */
    fun around(pins: List<String>, page: Int): List<String> = (page - 1..page + 1).mapNotNull { pins.getOrNull(it) }

    /**
     * Of the stops [codes], the ones to ask for now, each once: those not asked within [gapMs] ([askedAt] says when each last was), so a
     * swipe back and forth doesn't ask again at once.
     */
    fun due(codes: List<String>, askedAt: (String) -> Long?, nowMs: Long, gapMs: Long): List<String> =
        codes.distinct().filter { code -> askedAt(code)?.let { nowMs - it < gapMs } != true }
}

/** A pinned stop as Nearby shows it (/api/me/stops), and when this phone got it, on the server's clock ([ServerClock]). */
data class PinnedStop(val stop: NearbyStop, val gotMs: Long?) {
    /** The stop as it stands at [nowMs]: its rows [BusTimes.aged], so nothing old passes for live while refreshes fail. */
    fun aged(nowMs: Long): NearbyStop = if (gotMs == null) stop else stop.copy(board = stop.board.map { BusTimes.aged(it, gotMs, nowMs) })
}

/** One service's buses on the road (/api/lines), in the server's words ([outText]: "3 out", "None out"). */
data class LineOut(val out: Int, val outText: String, val stale: Boolean) {
    companion object {
        /** By service; null for one whose live feed couldn't be reached, which isn't the same as none out. */
        fun parse(o: JSONObject): Map<String, LineOut?> {
            val lines = o.optJSONObject("lines") ?: return emptyMap()
            return lines.keys().asSequence().associateWith { svc -> of(lines.optJSONObject(svc)) }
        }

        /** One service's entry, as /api/lines and /api/line (`out`) give it. */
        fun of(x: JSONObject?): LineOut? =
            x?.optStringOrNull("outText")?.ifEmpty { null }?.let { LineOut(x.optInt("out"), it, x.optBoolean("stale")) }
    }
}

/**
 * The list of lines' counts: /api/lines's ([list], counted at [listAsOfMs]), with a newer count from a service's own page in its place
 * ([pages]: when it was counted, and the count), so going back from a page never shows an older count than the page did.
 */
data class Outs(
    val list: Map<String, LineOut?> = emptyMap(),
    val listAsOfMs: Long = 0,
    val pages: Map<String, Pair<Long, LineOut>> = emptyMap(),
) {
    /** By service, as the list shows them; nothing while the list itself has none. */
    val shown: Map<String, LineOut?>
        get() = if (list.isEmpty()) list else list + pages.filterValues { it.first > listAsOfMs }.mapValues { it.value.second }

    fun listed(lines: Map<String, LineOut?>, asOfMs: Long) = copy(list = lines, listAsOfMs = asOfMs)

    /** [svc]'s page counted [out] at [asOfMs]; an answer older than the one kept changes nothing. */
    fun paged(svc: String, out: LineOut?, asOfMs: Long): Outs =
        if (out == null || (pages[svc]?.first ?: Long.MIN_VALUE) > asOfMs) this else copy(pages = pages + (svc to (asOfMs to out)))
}

/**
 * How often the Stops tab asks /api/lines: when its list comes on screen, then at most once a minute while it stays there. It reads every
 * service from NUS, so never more often.
 */
object LinesPoll {
    const val EVERY_MS = 60_000L

    /** How long until it may be asked again, [lastMs] the last time it was: now for never. */
    fun waitMs(lastMs: Long?, nowMs: Long): Long = if (lastMs == null) 0 else (lastMs + EVERY_MS - nowMs).coerceIn(0, EVERY_MS)

    /** How long to sleep before trying again: until it's due, or a whole minute when it wasn't asked (no account yet) or is due now. */
    fun nextMs(lastMs: Long?, nowMs: Long): Long = waitMs(lastMs, nowMs).takeIf { it > 0 } ?: EVERY_MS
}

/**
 * A row of the Stops tab's list of lines: the service, its [name] and [via] as the server words them ("Loop from KR Bus Ter", "via AS 5,
 * PGP, KR MRT"), and its buses out, if known.
 */
data class LineRow(val svc: String, val name: String?, val via: String?, val out: LineOut?) {
    /** The green dot by the count: buses on the road just now. A count from last time ([LineOut.stale]) isn't live: its words alone. */
    val live: Boolean
        get() = out != null && out.out > 0 && !out.stale

    /** The row as one thing said: "Bus D2, Loop from COM 3, via PGP, KR MRT, UTown, 3 out". */
    fun said(): String = listOfNotNull(L.s(R.string.a11y_bus, svc), name, via, out?.outText).joinToString(L.s(R.string.clause_sep))

    companion object {
        /** From /api/campus's route; without the server's `name` (a copy kept from an older server), worded here from its stops. */
        fun of(route: ServiceRoute, out: LineOut?, stopName: (String) -> String) =
            LineRow(route.svc, route.name ?: serviceWhere(route, stopName), route.via, out)
    }
}

/** The services not running come after the ones that are, as the API sorts them. */
fun runningFirst(rows: List<BoardRow>): List<BoardRow> = rows.filter { it.running } + rows.filter { !it.running }

/**
 * Where a service goes, from /api/campus's route: "Loop from Kent Ridge MRT", or "Kent Ridge MRT to Opp HSSML". [name] gives a stop's name
 * from its code. Null without its stops.
 */
fun serviceWhere(route: ServiceRoute, name: (String) -> String): String? {
    val first = route.seq.firstOrNull() ?: return null
    return if (route.loop) L.s(R.string.buses_loop_from, name(first)) else L.s(R.string.buses_from_to, name(first), name(route.seq.last()))
}

/** A search result: a stop opens its board, a service its line. */
sealed interface BusHit {
    val key: SearchRank.Key

    data class Service(val svc: String) : BusHit {
        override val key
            get() = SearchRank.Key("service", svc, svc)
    }

    /** [name] is the full name; [aliases] its short name, lower case, and the nicknames /api/campus has for it ("library"). */
    data class Stop(val code: String, val name: String, val services: List<String>, val aliases: List<String> = emptyList()) : BusHit {
        override val key
            get() = SearchRank.Key("stop", code, name, aliases)
    }
}

/**
 * What the tab's search looks through, as the web builds it (busesTabIndex): every service by its code, in code order, then every stop by
 * its full name, in /api/campus order, also found by its short name and its nicknames ([stopAliases], from /api/campus's destinations of
 * kind "stop").
 */
fun busesTabIndex(stops: List<MapStop>, services: List<String>, stopAliases: Map<String, List<String>>): List<BusHit> =
    services.sorted().map { BusHit.Service(it) } +
        stops.map { s -> BusHit.Stop(s.code, s.fullName, s.services, listOf(s.name.lowercase()) + stopAliases[s.code].orEmpty()) }

/** The tab's index from the map's /api/campus. */
fun busesTabIndex(campus: CampusMap): List<BusHit> = busesTabIndex(campus.stops, campus.serviceCodes, campus.stopAliases)

/**
 * The tab's search, by the destination search's rules ([SearchRank]). With nothing typed, the suggestions: every service, in order, not
 * limited.
 */
fun searchBuses(query: String, index: List<BusHit>, max: Int = SearchRank.MAX): List<BusHit> {
    if (query.trim { it.isWhitespace() || it == '\uFEFF' }.isEmpty()) return index.filterIsInstance<BusHit.Service>()
    return SearchRank.rank(index, query, max) { it.key }
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { i -> optString(i).takeIf { it.isNotEmpty() && !isNull(i) } }

private fun JSONObject.index(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key, -1).takeIf { it >= 0 }
