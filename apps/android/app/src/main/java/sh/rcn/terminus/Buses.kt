package sh.rcn.terminus

import java.time.Instant
import java.time.ZoneId
import org.json.JSONArray
import org.json.JSONObject

data class Board(
    val code: String,
    val name: String,
    val opposite: String?,
    val available: Boolean,
    val rows: List<BoardRow>,
    val asOfMs: Long?,
    val distM: Int? = null,
    val oppositeAcross: Boolean = true,
    val oppositeName: String? = null,
    val gotMs: Long? = null,
) {
    fun aged(nowMs: Long): Board = if (gotMs == null) this else copy(rows = rows.map { BusTimes.aged(it, gotMs, nowMs) })

    companion object {
        fun parse(o: JSONObject): Board {
            val stop = o.optJSONObject("stop") ?: JSONObject()
            val code = stop.optString("code")
            val b = o.optJSONArray("board") ?: JSONArray()
            return Board(
                code = code,
                name = stop.optStringOrNull("longName")?.ifEmpty { null } ?: stop.optStringOrNull("name")?.ifEmpty { null } ?: code,
                opposite = stop.optStringOrNull("opposite")?.ifEmpty { null },
                oppositeAcross = stop.optBoolean("oppositeAcross", true),
                oppositeName = stop.optStringOrNull("oppositeName")?.ifEmpty { null },
                available = o.optBoolean("available", true),
                rows = (0 until b.length()).mapNotNull { i -> b.optJSONObject(i)?.let(::parseBoardRow) },
                asOfMs = o.optStringOrNull("asOf")?.let(::parseInstant),
            )
        }

        fun of(s: NearbyStop, asOfMs: Long?) =
            Board(s.code, s.longName ?: s.name, s.opposite, s.available, s.board, asOfMs, s.distM, s.oppositeAcross, s.oppositeName)
    }
}

data class LineStop(val code: String, val name: String, val services: List<String>)

data class LineBus(val id: String, val plate: String?, val crowd: String?, val at: Int?, val after: Int?)

data class LineHere(val code: String, val index: Int, val row: BoardRow?)

data class Line(
    val svc: String,
    val color: Long,
    val endsAtMs: Long?,
    val stops: List<LineStop>,
    val buses: List<LineBus>,
    val here: LineHere?,
    val available: Boolean,
    val asOfMs: Long?,
    val running: Boolean = true,
    val stopped: String? = null,
    val resumesAtMs: Long? = null,
    val gotMs: Long? = null,
    val out: LineOut? = null,
) {
    fun aged(nowMs: Long): Line =
        if (gotMs == null || here?.row == null) this else copy(here = here.copy(row = BusTimes.aged(here.row, gotMs, nowMs)))

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

    data class Between(val after: Int, val buses: List<LineBus>) : LineItem
}

object BusTimes {
    const val ARRIVING_S = 45

    const val REFRESH_MS = 15_000L

    const val OLD_MS = 2 * REFRESH_MS

    fun aged(r: BoardRow, gotMs: Long, nowMs: Long): BoardRow {
        val ms = nowMs - gotMs
        if (r.etaS == null || ms <= OLD_MS) return r
        val s = (ms / 1000).toInt()
        val left = r.etaS - s
        return r.copy(
            etaS = if (left > -60) maxOf(0, left) else null,
            eta = null,
            quality = if (r.quality == "live") "stale" else r.quality,
            laterText = null,
            later =
                r.later
                    .map { it.copy(etaS = it.etaS - s, eta = null, quality = if (it.quality == "live") "stale" else it.quality) }
                    .filter { it.etaS > 0 },
        )
    }

    fun minutes(etaS: Int): Int = maxOf(1, (etaS + 30) / 60)

    fun arriving(etaS: Int?, quality: String): Boolean = etaS != null && etaS < ARRIVING_S && quality == "live"

    const val THEN_MAX = 2

    fun later(row: BoardRow, max: Int = THEN_MAX): List<Int> = row.later.sortedBy { it.etaS }.take(max).map { minutes(it.etaS) }

    fun laterScheduled(row: BoardRow): Boolean = row.quality != "scheduled" && row.later.take(THEN_MAX).any { it.quality == "scheduled" }

    fun endingSoon(rows: List<BoardRow>, nowMs: Long, withinMs: Long = 2 * 3_600_000L): List<Pair<String, Long>> =
        rows
            .mapNotNull { r -> r.endsAtMs?.takeIf { it > nowMs && it - nowMs <= withinMs }?.let { r.svc to it } }
            .sortedBy { it.second }
            .distinctBy { it.first }

    fun campusMinute(ms: Long): Int = Instant.ofEpochMilli(ms).atZone(ZoneId.of("Asia/Singapore")).let { it.hour * 60 + it.minute }

    fun ageS(asOfMs: Long, nowMs: Long): Long = ((nowMs - asOfMs) / 1000).coerceAtLeast(0)
}

data class Stopped(val why: String, val back: Back?) {
    data class Back(val minute: Int, val today: Boolean, val tomorrow: Boolean, val weekday: Int)

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

object Pins {
    fun toggle(pins: List<String>, code: String, max: Int = Limits.DEFAULT.pinnedStops): List<String> = set(pins, code, code !in pins, max)

    fun set(pins: List<String>, code: String, on: Boolean, max: Int = Limits.DEFAULT.pinnedStops): List<String> =
        when {
            !on -> pins - code
            code in pins || pins.size >= max -> pins
            else -> pins + code
        }

    fun shown(pins: List<String>, max: Int = Limits.DEFAULT.pinnedStops): List<String> = pins.distinct().take(max)
}

object PinPages {
    const val ADD = ""

    fun index(pins: List<String>, selected: String?): Int = if (selected == ADD) pins.size else pins.indexOf(selected).coerceAtLeast(0)

    fun at(pins: List<String>, page: Int): String = pins.getOrNull(page) ?: ADD

    fun kept(before: List<String>, after: List<String>, selected: String?): String? {
        if (selected == null || selected == ADD || selected in after) return selected
        val i = before.indexOf(selected)
        if (i < 0) return after.firstOrNull()
        return (before.drop(i + 1) + before.take(i).reversed()).firstOrNull { it in after } ?: after.firstOrNull()
    }

    fun around(pins: List<String>, page: Int): List<String> = (page - 1..page + 1).mapNotNull { pins.getOrNull(it) }

    fun due(codes: List<String>, askedAt: (String) -> Long?, nowMs: Long, gapMs: Long, open: String? = null): List<String> =
        codes.distinct().filter { code -> code != open && askedAt(code)?.let { nowMs - it < gapMs } != true }
}

data class PinnedStop(val stop: NearbyStop, val gotMs: Long?, val answeredMs: Long? = gotMs, val own: NearbyStop = stop) {
    fun aged(nowMs: Long): NearbyStop = if (gotMs == null) stop else stop.copy(board = stop.board.map { BusTimes.aged(it, gotMs, nowMs) })

    fun answerFresh(nowMs: Long): Boolean = answeredMs != null && nowMs - answeredMs < ANSWER_MS

    fun withBoard(board: Board): PinnedStop {
        val now = board.gotMs ?: gotMs
        val since = if (now != null && answeredMs != null) ((now - answeredMs) / 1000).toInt() else 0
        val left = board.rows.filterNot { it.paid }.toMutableList()
        val exact = own.board.map { row -> left.firstOrNull { it.svc == row.svc && it.towards == row.towards }?.also { left.remove(it) } }
        val taken = own.board.mapIndexed { i, row -> exact[i] ?: left.firstOrNull { it.svc == row.svc }?.also { left.remove(it) } }
        val rows =
            own.board.mapIndexed { i, row ->
                val b = taken[i]
                if (b == null) {
                    if (row.etaS == null || since <= 0) row
                    else
                        (row.etaS - since).let { s ->
                            row.copy(
                                etaS = if (s > -60) maxOf(0, s) else null,
                                eta = null,
                                quality = if (row.quality == "live") "stale" else row.quality,
                                later = guessesAfter(row.later, since, 0),
                                laterText = null,
                            )
                        }
                } else {
                    row.copy(
                        etaS = b.etaS,
                        quality = b.quality,
                        eta = b.eta,
                        crowd = b.crowd,
                        running = b.running,
                        stopped = b.stopped,
                        resumesAtMs = b.resumesAtMs,
                        later =
                            b.later +
                                guessesAfter(
                                    listOfNotNull(row.etaS?.let { LaterBus(it, row.quality) }) + row.later,
                                    since,
                                    (if (b.etaS != null) 1 else 0) + b.later.size,
                                ),
                        laterText = null,
                    )
                }
            }
        return PinnedStop(stop.copy(board = rows, available = board.available), now, answeredMs, own)
    }

    companion object {
        const val ANSWER_MS = 120_000L

        internal fun guessesAfter(buses: List<LaterBus>, since: Int, shown: Int): List<LaterBus> =
            buses
                .map { it.copy(etaS = it.etaS - since, eta = null) }
                .filter { it.etaS > 0 }
                .drop(shown)
                .filter { it.quality == "scheduled" }
    }
}

data class LineOut(val out: Int, val outText: String, val stale: Boolean) {
    companion object {
        fun parse(o: JSONObject): Map<String, LineOut?> {
            val lines = o.optJSONObject("lines") ?: return emptyMap()
            return lines.keys().asSequence().associateWith { svc -> of(lines.optJSONObject(svc)) }
        }

        fun of(x: JSONObject?): LineOut? =
            x?.optStringOrNull("outText")?.ifEmpty { null }?.let { LineOut(x.optInt("out"), it, x.optBoolean("stale")) }
    }
}

data class Outs(
    val list: Map<String, LineOut?> = emptyMap(),
    val listAsOfMs: Long = 0,
    val pages: Map<String, Pair<Long, LineOut>> = emptyMap(),
) {
    val shown: Map<String, LineOut?>
        get() = if (list.isEmpty()) list else list + pages.filterValues { it.first > listAsOfMs }.mapValues { it.value.second }

    fun listed(lines: Map<String, LineOut?>, asOfMs: Long) = copy(list = lines, listAsOfMs = asOfMs)

    fun paged(svc: String, out: LineOut?, asOfMs: Long): Outs =
        if (out == null || (pages[svc]?.first ?: Long.MIN_VALUE) > asOfMs) this else copy(pages = pages + (svc to (asOfMs to out)))
}

object LinesPoll {
    const val EVERY_MS = 60_000L

    fun waitMs(lastMs: Long?, nowMs: Long): Long = if (lastMs == null) 0 else (lastMs + EVERY_MS - nowMs).coerceIn(0, EVERY_MS)

    fun nextMs(lastMs: Long?, nowMs: Long): Long = waitMs(lastMs, nowMs).takeIf { it > 0 } ?: EVERY_MS
}

data class LineRow(val svc: String, val name: String?, val via: String?, val out: LineOut?) {
    val live: Boolean
        get() = out != null && out.out > 0 && !out.stale

    fun said(): String = listOfNotNull(L.s(R.string.a11y_bus, svc), name, via, out?.outText).joinToString(L.s(R.string.clause_sep))

    companion object {
        fun of(route: ServiceRoute, out: LineOut?, stopName: (String) -> String) =
            LineRow(route.svc, route.name ?: serviceWhere(route, stopName), route.via, out)
    }
}

fun runningFirst(rows: List<BoardRow>): List<BoardRow> = rows.filter { it.running } + rows.filter { !it.running }

fun serviceWhere(route: ServiceRoute, name: (String) -> String): String? {
    val first = route.seq.firstOrNull() ?: return null
    return if (route.loop) L.s(R.string.buses_loop_from, name(first)) else L.s(R.string.buses_from_to, name(first), name(route.seq.last()))
}

sealed interface BusHit {
    val key: SearchRank.Key

    data class Service(val svc: String) : BusHit {
        override val key
            get() = SearchRank.Key("service", svc, svc)
    }

    data class Stop(val code: String, val name: String, val services: List<String>, val aliases: List<String> = emptyList()) : BusHit {
        override val key
            get() = SearchRank.Key("stop", code, name, aliases)
    }
}

fun busesTabIndex(stops: List<MapStop>, services: List<String>, stopAliases: Map<String, List<String>>): List<BusHit> =
    services.sorted().map { BusHit.Service(it) } +
        stops.map { s -> BusHit.Stop(s.code, s.fullName, s.services, listOf(s.name.lowercase()) + stopAliases[s.code].orEmpty()) }

fun busesTabIndex(campus: CampusMap): List<BusHit> = busesTabIndex(campus.stops, campus.serviceCodes, campus.stopAliases)

fun searchBuses(query: String, index: List<BusHit>, max: Int = SearchRank.MAX): List<BusHit> {
    if (query.trim { it.isWhitespace() || it == '\uFEFF' }.isEmpty()) return index.filterIsInstance<BusHit.Service>()
    return SearchRank.rank(index, query, max) { it.key }
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { i -> optString(i).takeIf { it.isNotEmpty() && !isNull(i) } }

private fun JSONObject.index(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key, -1).takeIf { it >= 0 }
