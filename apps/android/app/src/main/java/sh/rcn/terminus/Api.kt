package sh.rcn.terminus

import androidx.core.content.edit
import androidx.core.net.toUri
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.asExecutor
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

data class Place(val key: String, val label: String)

data class NextAnswer(
    val label: String,
    val detail: String,
    val alt: String?,
    val stopName: String,
    val quality: String,
    val asOf: String,
    val mode: String,
    val destLabel: String?,
    val why: String?,
    val places: List<Place>,
    val departsAtMs: Long?,
    val timingStatus: String?,
    val timingText: String?,
    val refreshAtMs: Long? = null,
    val arrived: Boolean = false,
    val leaveAtMs: Long? = null,
    val leaveEstimated: Boolean = false,
    val leaveNote: String? = null,
    val classAtMs: Long? = null,
    val destPlace: Boolean = false,
    val card: Card? = null,
    val walkSpeedMs: Double? = null,
) {
    val isClassPlan: Boolean
        get() = card?.kind == "class"

    val startsRes: Int
        get() = if (destPlace) R.string.arrive_by else R.string.starts_at

    val isFree: Boolean
        get() = mode == "free"

    val phaseText: String?
        get() = card?.phaseText

    fun leaveHeadline(now: Long): String? {
        val at = leaveAtMs ?: return null
        if (card?.phase == "waiting") return card.leaveBy
        return if (now >= at) L.s(R.string.leave_now) else card?.leaveBy
    }

    val catchHow: String?
        get() = card?.catch

    val catchArrive: String?
        get() = card?.arrive

    val catchLine: String?
        get() = card?.catchLine

    val leaveLate: Boolean
        get() = card?.late ?: false

    val goNowLine: String?
        get() = card?.goNow

    val crowdText: String?
        get() = card?.crowd?.takeUnless { detail.contains(it, ignoreCase = true) }

    val qualityText: String?
        get() = card?.quality

    fun leaveText(now: Long): String? {
        val head = leaveHeadline(now) ?: return null
        return card?.leaveVia?.let { "$head · $it" } ?: head
    }

    val title: String
        get() = card?.title ?: label

    fun clockLabel(format: (Long) -> String): String {
        card?.title?.let {
            return it
        }
        val at = departsAtMs ?: return label
        if (quality == "unknown" || quality == "ended") return label
        return "${label.substringBefore(" · ")} · ${if (quality != "live") L.s(R.string.approx, format(at)) else format(at)}"
    }

    companion object {
        fun parse(o: JSONObject): NextAnswer = parsing { parseOrThrow(o) }

        private fun parseOrThrow(o: JSONObject): NextAnswer {
            val dest = o.optJSONObject("dest")
            val places = o.optJSONArray("places") ?: JSONArray()
            return NextAnswer(
                label = o.getString("label"),
                detail = o.optStringOrNull("detail").orEmpty(),
                alt = o.optStringOrNull("alt"),
                stopName = o.optJSONObject("stop")?.optStringOrNull("name").orEmpty(),
                quality = o.optString("quality", "unknown"),
                asOf = o.optStringOrNull("asOf").orEmpty(),
                mode = o.optString("mode", "trip"),
                destLabel = dest?.optStringOrNull("label"),
                why = dest?.optStringOrNull("why"),
                places =
                    (0 until places.length()).mapNotNull {
                        val p = places.optJSONObject(it) ?: return@mapNotNull null
                        Place(p.optStringOrNull("key") ?: return@mapNotNull null, p.optStringOrNull("label") ?: return@mapNotNull null)
                    },
                departsAtMs = o.optStringOrNull("departsAt")?.let(::parseInstant),
                refreshAtMs = o.optStringOrNull("refreshAt")?.let(::parseInstant),
                arrived = o.optBoolean("arrived", false),
                leaveAtMs = o.optJSONObject("leave")?.optStringOrNull("at")?.let(::parseInstant),
                leaveEstimated = o.optJSONObject("leave")?.optBoolean("estimated", false) ?: false,
                leaveNote = o.optJSONObject("leave")?.optStringOrNull("note"),
                classAtMs = o.optJSONObject("timing")?.optStringOrNull("classAt")?.let(::parseInstant),
                destPlace = dest?.optBoolean("place", false) ?: false,
                timingStatus = o.optJSONObject("timing")?.optStringOrNull("status"),
                timingText = o.optJSONObject("timing")?.optStringOrNull("text"),
                card = o.optJSONObject("card")?.let { lenient { Card.parse(it) } },
                walkSpeedMs = o.optDouble("walkSpeedMs").takeIf { it.isFinite() && it > 0 },
            )
        }
    }
}

data class Card(
    val kind: String,
    val staleAtMs: Long?,
    val crowd: String?,
    val quality: String?,
    val leaveBy: String?,
    val leaveVia: String?,
    val catch: String?,
    val arrive: String?,
    val catchLine: String?,
    val late: Boolean,
    val goNow: String?,
    val note: String?,
    val estimate: String?,
    val phase: String = "idle",
    val phaseText: String? = null,
    val glance: String? = null,
    val line: String? = null,
    val actions: List<CardAction> = emptyList(),
    val warning: String? = null,
    val nextChangeAtMs: Long? = null,
    val remind: Boolean = true,
    val suggestion: Suggestion? = null,
    val ride: Ride? = null,
    val gone: Boolean = false,
    val walkTo: WalkTo? = null,
    val notice: String? = null,
    val journey: Journey? = null,
    val upcoming: Upcoming? = null,
    val title: String? = null,
    val heading: String? = null,
    val remindAtMs: Long? = null,
    val step: Step? = null,
    val fromNus: Boolean = false,
    val reasons: List<String>? = null,
) {
    companion object {
        fun parse(o: JSONObject) =
            Card(
                kind = o.optString("kind", "trip"),
                staleAtMs = o.optStringOrNull("staleAt")?.let(::parseInstant),
                crowd = o.optStringOrNull("crowd"),
                quality = o.optStringOrNull("quality"),
                leaveBy = o.optStringOrNull("leaveBy"),
                leaveVia = o.optStringOrNull("leaveVia"),
                catch = o.optStringOrNull("catch"),
                arrive = o.optStringOrNull("arrive"),
                catchLine = o.optStringOrNull("catchLine"),
                late = o.optBoolean("late", false),
                goNow = o.optStringOrNull("goNow"),
                note = o.optStringOrNull("note"),
                estimate = o.optStringOrNull("estimate"),
                fromNus = o.optBoolean("fromNus", false),
                reasons = o.optJSONArray("reasons")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } },
                phase = o.optString("phase", "idle"),
                phaseText = o.optStringOrNull("phaseText"),
                glance = o.optStringOrNull("glance"),
                line = o.optStringOrNull("line"),
                actions =
                    o.optJSONArray("actions")
                        ?.let { a ->
                            (0 until a.length()).mapNotNull { i -> a.optJSONObject(i)?.let { lenient { CardAction.parse(it) } } }
                        }
                        .orEmpty(),
                warning = o.optStringOrNull("warning"),
                notice = o.optStringOrNull("notice"),
                nextChangeAtMs = o.optStringOrNull("nextChangeAt")?.let(::parseInstant),
                remind = o.optBoolean("remind", true),
                suggestion = o.optJSONObject("suggestion")?.let { lenient { Suggestion.parse(it) } },
                ride = o.optJSONObject("ride")?.let { lenient { Ride.parse(it) } },
                gone = o.optBoolean("gone", false),
                walkTo = o.optJSONObject("walkTo")?.let { lenient { WalkTo.parse(it) } },
                journey = o.optJSONObject("journey")?.let { lenient { Journey.parse(it) } },
                upcoming = o.optJSONObject("upcoming")?.let { lenient { Upcoming.parse(it) } },
                title = o.optStringOrNull("title"),
                heading = o.optStringOrNull("heading"),
                remindAtMs = o.optStringOrNull("remindAt")?.let(::parseInstant),
                step = o.optJSONObject("step")?.let { lenient { Step.parse(it) } },
            )
    }
}

private inline fun <T> lenient(parse: () -> T?): T? =
    try {
        parse()
    } catch (_: org.json.JSONException) {
        null
    }

internal inline fun <T> parsing(read: () -> T): T =
    try {
        read()
    } catch (e: org.json.JSONException) {
        throw ParseError(e.message ?: "unexpected answer", e)
    }

data class Upcoming(val whenText: String, val title: String, val where: String, val off: String?) {
    companion object {
        fun parse(o: JSONObject): Upcoming? =
            Upcoming(
                o.optStringOrNull("when").orEmpty(),
                o.optStringOrNull("title") ?: return null,
                o.optStringOrNull("where").orEmpty(),
                o.optStringOrNull("off"),
            )
    }
}

data class Ride(
    val svc: String,
    val stops: List<String>,
    val boardMs: Long,
    val arriveMs: Long,
    val change: RideChange? = null,
) {
    fun progress(now: Long): Float = ((now - boardMs).toFloat() / (arriveMs - boardMs)).coerceIn(0f, 1f)

    fun passed(now: Long): Int = (progress(now) * (stops.size - 1)).toInt()

    fun nextStop(now: Long): String? = stops.getOrNull(passed(now) + 1)

    fun stopsLeft(now: Long): Int = (stops.size - 1 - passed(now)).coerceAtLeast(0)

    companion object {
        fun parse(o: JSONObject): Ride? {
            val svc = o.optStringOrNull("svc") ?: return null
            val stops = o.optJSONArray("stops") ?: return null
            val names = (0 until stops.length()).map { stops.optJSONObject(it)?.optStringOrNull("name") ?: return null }
            val board = o.optStringOrNull("board")?.let(::parseInstant) ?: return null
            val arrive = o.optStringOrNull("arrive")?.let(::parseInstant) ?: return null
            val change = o.optJSONObject("change")?.let { lenient { RideChange.parse(it) } }
            return Ride(svc, names, board, arrive, change).takeIf { names.size >= 2 && arrive > board }
        }
    }

    fun nextText(now: Long, withChange: Boolean = true): String {
        val next = nextStop(now)
        val left = stopsLeft(now)
        val text =
            when {
                next == null || left == 0 -> L.s(R.string.getting_off_at, stops.last())
                left == 1 -> L.s(R.string.next_where_off, stops.last())
                else -> L.s(R.string.next_stops_to_go, next, left)
            }
        return if (withChange && change != null && left <= 1) "$text · ${change.text}" else text
    }
}

data class RideChange(val svc: String, val color: Long, val stop: String, val board: String?, val text: String) {
    companion object {
        fun parse(o: JSONObject): RideChange? =
            RideChange(
                svc = o.optStringOrNull("svc") ?: return null,
                color = parseColor(o.optStringOrNull("color")),
                stop = o.optStringOrNull("stop").orEmpty(),
                board = o.optStringOrNull("board"),
                text = o.optStringOrNull("text") ?: return null,
            )
    }
}

data class Journey(
    val leave: String?,
    val walk: String?,
    val bus: JourneyBus?,
    val boardAtMs: Long?,
    val ride: String?,
    val off: String?,
    val to: String,
    val toStop: String,
    val arrive: String?,
    val walkEnd: String? = null,
    val arriveStop: String? = arrive,
    val slack: String?,
    val live: Boolean,
    val backup: JourneyBus?,
    val why: String? = null,
    val text: JourneyWords = JourneyWords(),
    val change: JourneyChange? = null,
) {
    val place: String
        get() = text.place ?: to.substringBefore(" @ ")

    companion object {
        fun parse(o: JSONObject): Journey? {
            val bus = o.optJSONObject("bus")?.let(JourneyBus::parse)
            if (bus == null && !o.isNull("bus")) return null
            val board = o.optStringOrNull("boardAt")?.let(::parseInstant)
            if (bus != null && board == null) return null
            if (bus == null && o.optStringOrNull("walk") == null) return null
            return Journey(
                leave = o.optStringOrNull("leave"),
                walk = o.optStringOrNull("walk"),
                bus = bus,
                boardAtMs = board?.takeIf { bus != null },
                ride = o.optStringOrNull("ride")?.takeIf { bus != null },
                off = o.optStringOrNull("off"),
                to = o.optStringOrNull("to").orEmpty(),
                toStop = o.optStringOrNull("toStop").orEmpty(),
                arrive = o.optStringOrNull("arrive"),
                walkEnd = o.optStringOrNull("walkEnd"),
                arriveStop = o.optStringOrNull("arriveStop") ?: o.optStringOrNull("arrive"),
                slack = o.optStringOrNull("slack"),
                live = o.optBoolean("live", false),
                backup = o.optJSONObject("backup")?.let(JourneyBus::parse),
                why = o.optStringOrNull("why"),
                text =
                    JourneyWords(
                        title = o.optStringOrNull("title"),
                        place = o.optStringOrNull("place"),
                        by = o.optStringOrNull("byText"),
                        walk = o.optStringOrNull("walkText"),
                        ride = o.optStringOrNull("rideText"),
                        walkEnd = o.optStringOrNull("walkEndText"),
                        arrive = o.optStringOrNull("arriveText"),
                        arriveWhere = o.optStringOrNull("arriveWhere"),
                        backup = o.optStringOrNull("backupText"),
                        summary = o.optStringOrNull("summary"),
                    ),
                change = o.optJSONObject("change")?.takeIf { bus != null }?.let { lenient { JourneyChange.parse(it) } },
            )
        }
    }
}

data class JourneyWords(
    val title: String? = null,
    val place: String? = null,
    val by: String? = null,
    val walk: String? = null,
    val ride: String? = null,
    val walkEnd: String? = null,
    val arrive: String? = null,
    val arriveWhere: String? = null,
    val backup: String? = null,
    val summary: String? = null,
)

data class JourneyChange(
    val from: String,
    val stop: String,
    val reach: String,
    val walk: String?,
    val wait: String?,
    val bus: JourneyBus,
    val boardAtMs: Long,
    val ride: String,
    val firstRide: String,
    val firstRideText: String,
    val changeText: String,
    val rideText: String,
) {
    companion object {
        fun parse(o: JSONObject): JourneyChange? =
            JourneyChange(
                from = o.optStringOrNull("from") ?: return null,
                stop = o.optStringOrNull("stop") ?: return null,
                reach = o.optStringOrNull("reach").orEmpty(),
                walk = o.optStringOrNull("walk"),
                wait = o.optStringOrNull("wait"),
                bus = o.optJSONObject("bus")?.let(JourneyBus::parse) ?: return null,
                boardAtMs = o.optStringOrNull("boardAt")?.let(::parseInstant) ?: return null,
                ride = o.optStringOrNull("ride").orEmpty(),
                firstRide = o.optStringOrNull("firstRide").orEmpty(),
                firstRideText = o.optStringOrNull("firstRideText").orEmpty(),
                changeText = o.optStringOrNull("changeText") ?: return null,
                rideText = o.optStringOrNull("rideText").orEmpty(),
            )
    }
}

data class JourneyBus(val svc: String, val color: Long, val stop: String, val board: String, val paid: Boolean = false) {
    companion object {
        fun parse(o: JSONObject): JourneyBus? {
            val svc = o.optStringOrNull("svc") ?: return null
            return JourneyBus(
                svc,
                parseColor(o.optStringOrNull("color")),
                o.optStringOrNull("stop").orEmpty(),
                o.optStringOrNull("board").orEmpty(),
                o.optBoolean("paid", false),
            )
        }
    }
}

data class WalkTo(val name: String, val lat: Double, val lon: Double) {
    companion object {
        fun parse(o: JSONObject): WalkTo? {
            val lat = o.optDouble("lat").takeIf { it.isFinite() } ?: return null
            val lon = o.optDouble("lon").takeIf { it.isFinite() } ?: return null
            return WalkTo(o.optStringOrNull("name") ?: return null, lat, lon)
        }
    }

    fun mapsUri(): android.net.Uri = "https://www.google.com/maps/dir/?api=1&destination=$lat,$lon&travelmode=walking".toUri()
}

data class Suggestion(val id: String, val text: String, val accept: String, val dismiss: String) {
    companion object {
        fun parse(o: JSONObject): Suggestion? =
            Suggestion(
                o.optStringOrNull("id") ?: return null,
                o.optStringOrNull("text") ?: return null,
                o.optStringOrNull("accept") ?: return null,
                o.optStringOrNull("dismiss") ?: return null,
            )
    }
}

data class Step(
    val trip: String,
    val earlier: StepTarget?,
    val later: StepTarget?,
    val moved: Boolean,
    val earlierLabel: String,
    val laterLabel: String,
    val bestLabel: String,
) {
    companion object {
        fun parse(o: JSONObject): Step? =
            Step(
                o.optStringOrNull("trip") ?: return null,
                o.optJSONObject("earlier")?.let(StepTarget::parse),
                o.optJSONObject("later")?.let(StepTarget::parse),
                o.optBoolean("moved", false),
                o.optStringOrNull("earlierLabel") ?: return null,
                o.optStringOrNull("laterLabel") ?: return null,
                o.optStringOrNull("bestLabel") ?: return null,
            )
    }
}

data class StepTarget(val svc: String, val stop: String, val boardMs: Long?, val json: String) {
    companion object {
        fun parse(o: JSONObject): StepTarget? =
            StepTarget(
                o.optStringOrNull("svc") ?: return null,
                o.optStringOrNull("stop") ?: return null,
                o.optStringOrNull("board")?.let(::parseInstant),
                o.toString(),
            )
    }
}

data class TripChoice(val trip: String, val pref: String, val label: String?)

data class CardAction(val id: String, val label: String, val trip: String) {
    companion object {
        fun parse(o: JSONObject): CardAction? =
            CardAction(
                o.optStringOrNull("id") ?: return null,
                o.optStringOrNull("label") ?: return null,
                o.optStringOrNull("trip") ?: return null,
            )
    }
}

data class DayItem(
    val kind: String,
    val key: String,
    val label: String,
    val status: String,
    val fromName: String?,
    val toName: String,
    val startsAtMs: Long,
    val endsAtMs: Long?,
    val leaveAtMs: Long?,
    val leaveEstimated: Boolean,
    val svc: String?,
    val leaveStop: String? = null,
    val timingText: String?,
    val timingStatus: String?,
    val onBus: OnBus? = null,
    val removable: Boolean = false,
    val line: String? = null,
    val title: String? = null,
)

data class OnBus(val svc: String, val off: String?, val arriveMs: Long?)

data class DayPlan(val items: List<DayItem>, val note: String?, val date: String? = null) {
    companion object {
        fun parse(o: JSONObject): DayPlan = parsing {
            val a = o.optJSONArray("items") ?: JSONArray()
            DayPlan(
                items =
                    (0 until a.length()).mapNotNull {
                        val x = a.getJSONObject(it)
                        val startsAtMs = parseInstant(x.optString("startsAt")) ?: return@mapNotNull null
                        val leave = x.optJSONObject("leave")
                        val timing = x.optJSONObject("timing")
                        val bus = x.optJSONObject("onBus")
                        DayItem(
                            kind = x.optString("kind"),
                            key = x.optString("key"),
                            label = x.optString("label"),
                            status = x.optString("status"),
                            fromName = x.optStringOrNull("fromName"),
                            toName = x.optString("toName"),
                            startsAtMs = startsAtMs,
                            endsAtMs = x.optStringOrNull("endsAt")?.let(::parseInstant),
                            leaveAtMs = leave?.optStringOrNull("at")?.let(::parseInstant),
                            leaveEstimated = leave?.optBoolean("estimated", false) ?: false,
                            svc = leave?.optStringOrNull("svc"),
                            leaveStop = leave?.optStringOrNull("stop"),
                            timingText = timing?.optStringOrNull("text"),
                            timingStatus = timing?.optStringOrNull("status"),
                            onBus =
                                bus?.let {
                                    OnBus(it.optString("svc"), it.optStringOrNull("off"), it.optStringOrNull("arrive")?.let(::parseInstant))
                                },
                            removable = x.optBoolean("removable", false),
                            line = x.optStringOrNull("line"),
                            title = x.optStringOrNull("title"),
                        )
                    },
                note = o.optStringOrNull("note"),
                date = o.optStringOrNull("date"),
            )
        }
    }
}

data class BoardRow(
    val svc: String,
    val etaS: Int?,
    val quality: String,
    val color: String? = null,
    val paid: Boolean = false,
    val later: List<LaterBus> = emptyList(),
    val towards: List<String> = emptyList(),
    val via: List<String> = emptyList(),
    val crowd: String? = null,
    val endsAtMs: Long? = null,
    val endsHere: Boolean = false,
    val running: Boolean = true,
    val stopped: String? = null,
    val resumesAtMs: Long? = null,
    val eta: String? = null,
    val laterText: String? = null,
    val toText: String? = null,
    val dest: String? = null,
    val destPlace: String? = null,
)

data class LaterBus(val etaS: Int, val quality: String, val eta: String? = null)

private fun parseLater(r: JSONObject): List<LaterBus> {
    val a = r.optJSONArray("later") ?: return emptyList()
    return (0 until a.length()).mapNotNull { k ->
        val b = a.optJSONObject(k) ?: return@mapNotNull null
        if (b.isNull("etaS")) null
        else
            LaterBus(
                b.optInt("etaS"),
                b.optString("quality"),
                b.optStringOrNull("eta"),
            )
    }
}

fun parseBoardRow(r: JSONObject): BoardRow =
    BoardRow(
        svc = r.getString("svc"),
        etaS = if (!r.has("etaS") || r.isNull("etaS")) null else r.optInt("etaS"),
        quality = r.optString("quality"),
        color = r.optStringOrNull("color")?.ifEmpty { null },
        paid = r.optBoolean("paid", false),
        later = parseLater(r),
        towards = r.optJSONArray("towards").stringList().filter { it.isNotBlank() },
        via = r.optJSONArray("via").stringList().filter { it.isNotBlank() },
        crowd = r.optStringOrNull("crowd")?.takeIf { it in CROWDS },
        endsAtMs = r.optStringOrNull("endsAt")?.let(::parseInstant),
        running = r.optBoolean("running", true),
        stopped = r.optStringOrNull("stopped")?.takeIf { it in STOPPED },
        resumesAtMs = r.optStringOrNull("resumesAt")?.let(::parseInstant),
        endsHere = r.optJSONArray("towards")?.let { a -> (0 until a.length()).none { a.optString(it).isNotBlank() } } ?: false,
        eta = r.optStringOrNull("eta")?.ifEmpty { null },
        laterText = r.optStringOrNull("laterText")?.ifEmpty { null },
        toText = r.optStringOrNull("toText")?.ifEmpty { null },
        dest = r.optStringOrNull("dest")?.ifEmpty { null },
        destPlace = r.optStringOrNull("destPlace")?.ifEmpty { null },
    )

private val CROWDS = setOf("low", "medium", "high")
internal val STOPPED = setOf("ended", "notYet", "noService")

data class NearbyStop(
    val code: String,
    val name: String,
    val walkS: Int?,
    val available: Boolean,
    val board: List<BoardRow>,
    val opposite: String? = null,
    val distM: Int? = null,
    val longName: String? = null,
    val oppositeAcross: Boolean = true,
    val oppositeName: String? = null,
    val viaText: String? = null,
) {
    val walkWords: String?
        get() = walkS?.let { if (it < 60) L.s(R.string.here) else L.s(R.string.min_walk, (it + 30) / 60) }
}

data class Destination(
    val code: String,
    val label: String,
    val stopCode: String,
    val kind: String,
    val walkM: Int? = null,
    val aliases: List<String> = emptyList(),
    val stops: List<String> = emptyList(),
    val detail: String? = null,
)

fun rankDestinations(all: List<Destination>, query: String, max: Int = SearchRank.MAX): List<Destination> =
    SearchRank.rank(all, query, max) { SearchRank.Key(it.kind, it.code, it.label, it.aliases) }

val Destination.id: String
    get() = "$kind:$code"

fun Destination.isPlaceOf(row: Destination): Boolean = (kind == "stop" || kind == "landmark") && code == row.code

fun whereResults(destinations: List<Destination>, pinned: List<Destination>, query: String): Pair<List<Destination>, List<Destination>> {
    if (query.isBlank()) return pinned to emptyList()
    val top = rankDestinations(pinned, query, max = 6)
    return top to rankDestinations(destinations, query, max = 6).filter { d -> top.none { d.isPlaceOf(it) } }
}

sealed interface Target {
    data object Plan : Target

    data class SavedPlace(val key: String) : Target

    data class Code(val code: String, val label: String) : Target
}

open class ApiError(val status: Int, message: String) : IOException(sentence(message))

class UpdateRequired(message: String) : ApiError(426, message)

internal fun sentence(text: String): String {
    if (text.isEmpty()) return text
    val s = if (text.startsWith("terminus")) text else text.replaceFirstChar { it.uppercaseChar() }
    val cjk = s.any { it in '\u4e00'..'\u9fff' }
    return if (s.last() in ".!?。！？") s else if (cjk) "$s。" else "$s."
}

class ParseError(message: String, cause: Throwable? = null) : Exception(message, cause)

class NotModified : Exception("not modified")

class Api(internal val token: String?, private val fast: Boolean = false, private val hour12: Boolean = false) {

    suspend fun pair(code: String, name: String): String {
        val body = JSONObject().put("code", code).put("name", name)
        return parsing { request("POST", "/api/pair", body).getString("token") }
    }

    suspend fun anon(name: String): String = parsing {
        request("POST", "/api/auth/anon", JSONObject().put("name", name).put("platform", "android")).getString("token")
    }

    suspend fun me(): Me = Me.parse(request("GET", "/api/me"))

    suspend fun profile(): Tagged {
        var tag: String? = null
        val json = request("GET", "/api/me/profile") { tag = it.getHeaderField("etag") }
        return Tagged(json, tag)
    }

    suspend fun saveProfile(profile: JSONObject, ifMatch: String?): Tagged {
        var tag: String? = null
        val json = request("PUT", "/api/me/profile", profile, ifMatch = ifMatch) { tag = it.getHeaderField("etag") }
        return Tagged(json, tag)
    }

    suspend fun import(share: String): Imported {
        var tag: String? = null
        val json = request("POST", "/api/me/import", JSONObject().put("share", share)) { tag = it.getHeaderField("etag") }
        return Imported(ImportResult.parse(json), tag)
    }

    suspend fun campusJson(etag: String? = null): Pair<JSONObject, String?>? {
        var tag: String? = null
        val json =
            try {
                request("GET", "/api/campus", ifNoneMatch = etag) { tag = it.getHeaderField("etag") }
            } catch (e: NotModified) {
                return null
            }
        return json to tag
    }

    suspend fun buses(svc: String): BusList = parsing { BusList.parse(request("GET", "/api/buses?svc=${enc(svc)}")) }

    suspend fun board(stop: String, public: Boolean = false): Board = parsing {
        Board.parse(request("GET", "/api/arrivals?stop=${enc(stop)}&stopped=1" + if (public) "&public=1" else ""))
    }

    suspend fun line(svc: String, stop: String? = null): Line = parsing {
        Line.parse(request("GET", "/api/line?svc=${enc(svc)}" + (stop?.let { "&stop=${enc(it)}" } ?: "")))
    }

    suspend fun signInStart(email: String, name: String): SignInRequest {
        val o = request("POST", "/api/auth/app/start", JSONObject().put("email", email).put("name", name))
        return parsing { SignInRequest(o.getString("request"), o.getString("poll"), o.getInt("match")) }
    }

    suspend fun signInPoll(r: SignInRequest): SignInPoll {
        val o = request("POST", "/api/auth/app/poll", JSONObject().put("request", r.request).put("poll", r.poll))
        return parsing {
            SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome"))
        }
    }

    suspend fun signInCode(r: SignInRequest, code: String): SignInPoll {
        val o = request("POST", "/api/auth/app/code", JSONObject().put("request", r.request).put("poll", r.poll).put("code", code))
        return parsing {
            SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome"))
        }
    }

    suspend fun merge(anon: String, keepDevice: Boolean) {
        request("POST", "/api/auth/app/merge", JSONObject().put("anon", anon).put("keep", if (keepDevice) "device" else "account"))
    }

    suspend fun pairCode(): String = parsing { request("POST", "/api/me/pair-code", JSONObject()).getString("code") }

    suspend fun devices(): List<Device> {
        val o = request("GET", "/api/me/devices")
        return parsing {
            val list = o.getJSONArray("devices")
            (0 until list.length()).map {
                val d = list.getJSONObject(it)
                Device(
                    d.getString("id"),
                    d.optStringOrNull("name") ?: L.s(R.string.device_unnamed),
                    d.optStringOrNull("platform"),
                    d.optLong("created"),
                    d.optLong("lastSeen"),
                    d.optBoolean("current", false),
                    d.optBoolean("watch", false),
                )
            }
        }
    }

    suspend fun removeDevice(id: String) {
        request("DELETE", "/api/me/devices/${enc(id)}")
    }

    suspend fun deleteAccount() {
        request("DELETE", "/api/me")
    }

    suspend fun next(target: Target, lat: Double?, lon: Double?, acc: Double? = null): NextAnswer =
        NextAnswer.parse(nextJson(target, lat, lon, acc))

    suspend fun nextJson(target: Target, lat: Double?, lon: Double?, acc: Double? = null): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
                acc?.let { add("acc=${Math.round(it)}") }
            }
            when (target) {
                Target.Plan -> {}
                is Target.SavedPlace -> add("place=${enc(target.key)}")
                is Target.Code -> add("to=${enc(target.code)}")
            }
            if (hour12) add("h12=1")
        }
        return request("GET", "/api/me/next" + query(q))
    }

    suspend fun nearby(lat: Double?, lon: Double?, acc: Double? = null): List<NearbyStop> = parseNearby(nearbyJson(lat, lon, acc))

    suspend fun nearbyJson(lat: Double?, lon: Double?, acc: Double? = null, stopped: Boolean = false): JSONObject {
        val q =
            (if (lat != null && lon != null) listOfNotNull("lat=${coord(lat)}", "lon=${coord(lon)}", acc?.let { "acc=${Math.round(it)}" })
            else emptyList()) + listOfNotNull("stopped=1".takeIf { stopped })
        return request("GET", "/api/me/nearby" + query(q))
    }

    suspend fun stops(codes: List<String>, lat: Double?, lon: Double?): Pair<List<NearbyStop>, Long?> {
        val q =
            listOf("codes=" + codes.joinToString(",") { enc(it) }) +
                (if (lat != null && lon != null) listOf("lat=${coord(lat)}", "lon=${coord(lon)}") else emptyList()) +
                "stopped=1"
        val json = request("GET", "/api/me/stops" + query(q))
        return parseNearby(json) to json.optStringOrNull("asOf")?.let(::parseInstant)
    }

    suspend fun lines(): Pair<Map<String, LineOut?>, Long?> = parsing {
        request("GET", "/api/lines").let { LineOut.parse(it) to it.optStringOrNull("asOf")?.let(::parseInstant) }
    }

    suspend fun destinations(): List<Destination> {
        val o = request("GET", "/api/campus")
        return parsing {
            val list = o.getJSONArray("destinations")
            (0 until list.length()).map { parseDestination(list.getJSONObject(it)) }
        }
    }

    suspend fun signal(kind: String, trip: String?): JSONObject {
        val body = JSONObject().put("kind", kind)
        trip?.let { body.put("trip", it) }
        return request("POST", "/api/me/signal" + if (hour12) "?h12=1" else "", body)
    }

    suspend fun step(step: Step, to: StepTarget?, dir: String?, lat: Double? = null, lon: Double? = null): JSONObject {
        val body = JSONObject().put("trip", step.trip).put("to", to?.let { JSONObject(it.json) } ?: JSONObject.NULL)
        dir?.let { body.put("dir", it) }
        if (lat != null && lon != null) body.put("lat", coord(lat).toDouble()).put("lon", coord(lon).toDouble())
        return request("POST", "/api/me/step" + if (hour12) "?h12=1" else "", body)
    }

    suspend fun once(target: Target, atMin: Int, lat: Double? = null, lon: Double? = null, acc: Double? = null): JSONObject {
        val body = JSONObject().put("atMin", atMin)
        when (target) {
            is Target.SavedPlace -> body.put("place", target.key)
            is Target.Code -> body.put("to", target.code).put("label", target.label)
            Target.Plan -> {}
        }
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
                acc?.let { add("acc=${Math.round(it)}") }
            }
            if (hour12) add("h12=1")
        }
        return request("POST", "/api/me/once" + query(q), body)
    }

    suspend fun registerPush(token: String) {
        request("POST", "/api/me/push", JSONObject().put("token", token))
    }

    suspend fun unregisterPush() {
        request("DELETE", "/api/me/push")
    }

    suspend fun choice(choice: String, id: String? = null, trip: String? = null, pref: String? = null): List<TripChoice> {
        val body = JSONObject().put("choice", choice)
        id?.let { body.put("id", it) }
        trip?.let { body.put("trip", it) }
        pref?.let { body.put("pref", it) }
        return parseChoices(request("POST", "/api/me/choice", body))
    }

    suspend fun notice(): Map<String, String>? {
        val n = request("GET", "/api/me/notice").optJSONObject("notice") ?: return null
        return listOf("title", "body", "zhTitle", "zhBody").mapNotNull { k -> n.optStringOrNull(k)?.let { k to it } }.toMap()
    }

    suspend fun choices(): Pair<List<TripChoice>, Int> {
        val o = request("GET", "/api/me/choices")
        return parseChoices(o) to o.optInt("history", 0)
    }

    suspend fun clearHistory() {
        request("DELETE", "/api/me/history")
    }

    private fun parseChoices(o: JSONObject): List<TripChoice> = parsing {
        val a = o.optJSONArray("choices") ?: return@parsing emptyList()
        (0 until a.length()).map {
            a.getJSONObject(it).let { c -> TripChoice(c.getString("trip"), c.getString("pref"), c.optStringOrNull("label")) }
        }
    }

    suspend fun dayJson(lat: Double? = null, lon: Double? = null, acc: Double? = null): Pair<JSONObject, String> {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
                acc?.let { add("acc=${Math.round(it)}") }
            }
            if (hour12) add("h12=1")
        }
        val asked = L.header()
        var written: String? = null
        val json =
            request("GET", "/api/me/day" + if (q.isEmpty()) "" else "?" + q.joinToString("&")) {
                written = it.getHeaderField("content-language")
            }
        return json to (written?.let { if (it.startsWith("zh")) "zh-Hans" else "en" } ?: asked)
    }

    suspend fun pairCheck(code: String): String = parsing {
        request("POST", "/api/pair/check", JSONObject().put("code", code)).getString("account")
    }

    suspend fun latestVersion(): String = parsing { request("GET", "/download/latest.json").getString("version") }

    suspend fun report(reason: String?, note: String, answer: JSONObject?, appVersion: String) {
        val body = JSONObject().put("kind", "wrong").put("note", note).put("platform", "android").put("appVersion", appVersion)
        reason?.let { body.put("reason", it) }
        answer?.let { body.put("context", it) }
        request("POST", "/api/me/feedback", body)
    }

    suspend fun feedback(note: String, appVersion: String) {
        val body = JSONObject().put("kind", "other").put("note", note).put("platform", "android").put("appVersion", appVersion)
        request("POST", "/api/me/feedback", body)
    }

    suspend fun export(): JSONObject = request("GET", "/api/me/export")

    suspend fun logout() {
        request("POST", "/api/auth/logout", JSONObject())
    }

    private suspend fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        ifNoneMatch: String? = null,
        ifMatch: String? = null,
        seen: ((HttpURLConnection) -> Unit)? = null,
    ): JSONObject =
        withContext(Dispatchers.IO) {
            if (Outdated.gated(method, path) && Outdated.holding()) throw UpdateRequired(L.s(R.string.update_required))
            if (Quiet.blocked(path)) throw ApiError(429, L.s(R.string.busy_try_again))
            try {
                withTimeout(if (fast) FAST_DEADLINE_MS else DEADLINE_MS) {
                    val tries = Servers.tries()
                    for ((i, base) in tries.withIndex()) {
                        val conn = URL(base + path).openConnection() as HttpURLConnection
                        val started = System.nanoTime()
                        var status: Int? = null
                        var failure: Throwable? = null
                        try {
                            return@withTimeout blocking(conn) {
                                exchange(conn, method, path, body, ifNoneMatch, ifMatch, seen) {
                                    status = it
                                    Servers.answered(base)
                                }
                            }
                        } catch (e: IOException) {
                            failure = e
                            if (i == tries.lastIndex || !Servers.unreached(e, method)) throw e
                        } finally {
                            conn.disconnect()
                            RequestLog.record(
                                method,
                                path,
                                base,
                                status,
                                (System.nanoTime() - started) / 1_000_000,
                                failure.takeIf { status == null },
                            )
                        }
                    }
                    error("no server to try")
                }
            } catch (e: TimeoutCancellationException) {
                throw java.net.SocketTimeoutException("no answer within the deadline")
            }
        }

    private fun exchange(
        conn: HttpURLConnection,
        method: String,
        path: String,
        body: JSONObject?,
        ifNoneMatch: String?,
        ifMatch: String?,
        seen: ((HttpURLConnection) -> Unit)?,
        reached: (Int) -> Unit,
    ): JSONObject {
        conn.requestMethod = method
        conn.connectTimeout = if (fast) 2_000 else 8_000
        conn.readTimeout = if (fast) 7_000 else 10_000
        conn.setRequestProperty("accept", "application/json")
        conn.setRequestProperty("x-terminus-client", CLIENT)
        conn.setRequestProperty("accept-language", L.header())
        token?.let { conn.setRequestProperty("authorization", "Bearer $it") }
        ifNoneMatch?.let { conn.setRequestProperty("if-none-match", it) }
        ifMatch?.let { conn.setRequestProperty("if-match", it) }
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val status = conn.responseCode
        reached(status)
        val cached =
            (conn.getHeaderField("age")?.trim()?.toLongOrNull() ?: 0) > 0 ||
                conn.getHeaderField("cf-cache-status").equals("HIT", ignoreCase = true)
        ServerClock.observe(conn.getHeaderField("date"), System.currentTimeMillis(), cached)
        val retryAfter = conn.getHeaderField("retry-after")
        if (status == 429) Quiet.after(path, retryAfter)
        if (status == 503) Quiet.later(retryAfter)
        if (status == 304 && ifNoneMatch != null) throw NotModified()
        seen?.invoke(conn)
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        val json = runCatching { JSONObject(text) }.getOrNull()
        if (status == 426) {
            Outdated.refused()
            throw UpdateRequired(L.s(R.string.update_required))
        }
        if (status !in 200..299) throw ApiError(status, json?.optStringOrNull("error") ?: L.s(R.string.server_not_answering))
        if (token != null && Outdated.gated(method, path)) Outdated.served()
        return json ?: throw ParseError("not JSON")
    }

    private fun query(parts: List<String>) = if (parts.isEmpty()) "" else "?" + parts.joinToString("&")

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

private const val FAST_DEADLINE_MS = 9_000L
private const val DEADLINE_MS = 20_000L

private suspend fun <T> blocking(conn: HttpURLConnection, block: () -> T): T = suspendCancellableCoroutine { cont ->
    val io = Dispatchers.IO.asExecutor()
    cont.invokeOnCancellation { io.execute { conn.disconnect() } }
    io.execute { cont.resumeWith(runCatching(block)) }
}

object Quiet {
    private const val MAX_S = 300L
    private const val DEFAULT_S = 60L
    private const val KEY = "quiet-until"

    internal var elapsed: () -> Long = { android.os.SystemClock.elapsedRealtime() }
    internal var wall: () -> Long = { System.currentTimeMillis() }

    @Volatile private var prefs: android.content.SharedPreferences? = null
    @Volatile private var untilElapsed = 0L
    @Volatile private var authUntilElapsed = 0L
    @Volatile private var laterElapsed = 0L

    fun init(ctx: android.content.Context) {
        val p = ctx.applicationContext.getSharedPreferences("terminus-net", android.content.Context.MODE_PRIVATE)
        prefs = p
        val left = p.getLong(KEY, 0) - wall()
        if (left > 0) untilElapsed = maxOf(untilElapsed, elapsed() + left.coerceAtMost(MAX_S * 1000))
    }

    fun blocked(path: String): Boolean {
        val now = elapsed()
        return now < untilElapsed || (auth(path) && now < authUntilElapsed)
    }

    fun after(path: String, retryAfter: String?) {
        val s = (retryAfter?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: DEFAULT_S).coerceAtMost(MAX_S)
        val until = elapsed() + s * 1000
        if (auth(path)) {
            authUntilElapsed = until
            return
        }
        untilElapsed = until
        prefs?.edit { putLong(KEY, wall() + s * 1000) }
    }

    fun later(retryAfter: String?) {
        val s = retryAfter?.trim()?.toLongOrNull()?.takeIf { it > 0 } ?: return
        laterElapsed = elapsed() + s.coerceAtMost(MAX_S) * 1000
    }

    fun remainingMs(): Long = (untilElapsed - elapsed()).coerceAtLeast(0)

    fun waitMs(): Long = maxOf(remainingMs(), laterElapsed - elapsed(), 0)

    internal fun auth(path: String) = path.startsWith("/api/auth/") || path.startsWith("/api/pair") || path.startsWith("/api/me/pair-code")

    internal fun reset() {
        untilElapsed = 0
        authUntilElapsed = 0
        laterElapsed = 0
    }
}

object Outdated {
    private const val HOLD_MS = 30 * 60_000L
    private const val KEY_AT = "outdated-at"
    private const val KEY_VERSION = "outdated-version"

    internal var wall: () -> Long = { System.currentTimeMillis() }
    @Volatile private var prefs: android.content.SharedPreferences? = null
    @Volatile private var at = 0L

    fun init(ctx: android.content.Context) {
        val p = ctx.applicationContext.getSharedPreferences("terminus-net", android.content.Context.MODE_PRIVATE)
        prefs = p
        at = if (p.getString(KEY_VERSION, null) == BuildConfig.VERSION_NAME) p.getLong(KEY_AT, 0) else 0
    }

    val required: Boolean
        get() = at != 0L

    fun holding(): Boolean = at != 0L && wall() - at in 0 until HOLD_MS

    fun gated(method: String, path: String): Boolean {
        val p = path.substringBefore('?')
        if (method == "DELETE" && (p == "/api/me" || p == "/api/me/push")) return false
        return p == "/api/me" || p.startsWith("/api/me/") || p in ANSWERS
    }

    private val ANSWERS = setOf("/api/next", "/api/trip", "/api/arrivals", "/api/buses", "/api/line", "/api/campus", "/api/stops/pairs")

    fun refused() {
        at = wall()
        prefs?.edit { putLong(KEY_AT, at).putString(KEY_VERSION, BuildConfig.VERSION_NAME) }
    }

    fun served() {
        if (at == 0L) return
        at = 0
        prefs?.edit { remove(KEY_AT).remove(KEY_VERSION) }
    }

    internal fun reset() {
        at = 0
    }
}

val CLIENT = "android/${BuildConfig.VERSION_NAME}"

data class Me(
    val email: String?,
    val anonymous: Boolean,
    val needsSetup: Boolean,
    val needsReimport: Boolean = false,
    val term: String? = null,
) {
    companion object {
        fun parse(o: JSONObject) =
            Me(
                email = o.optStringOrNull("email"),
                anonymous = o.optBoolean("anonymous", false),
                needsSetup = o.optStringOrNull("onboarding") != null,
                needsReimport = o.optBoolean("needsReimport", false),
                term = o.optStringOrNull("term"),
            )
    }
}

data class SignInRequest(val request: String, val poll: String, val match: Int)

data class SignInPoll(val status: String, val token: String?, val email: String?, val outcome: String?)

data class Device(
    val id: String,
    val name: String,
    val platform: String?,
    val createdMs: Long,
    val lastSeenMs: Long,
    val current: Boolean,
    val watch: Boolean = false,
) {
    val platformName: String?
        get() =
            if (watch) "Apple Watch"
            else
                when (platform) {
                    "android" -> "Android"
                    "mac" -> "Mac"
                    "ios" -> "iPhone"
                    else -> null
                }
}

data class Stop(val code: String, val name: String, val lat: Double, val lon: Double, val services: List<String> = emptyList())

data class Residence(
    val code: String,
    val name: String,
    val stops: List<String>,
    val walkM: Int,
    val common: Boolean = false,
    val walkMin: Int? = null,
) {
    val minutes: Int
        get() = walkMin ?: maxOf(1, Math.round(walkM / 1.3 / 60).toInt())
}

data class Campus(
    val stops: List<Stop>,
    val residences: List<Residence>,
    val destinations: List<Destination>,
    val colors: Map<String, Long> = emptyMap(),
) {
    fun stopName(code: String) = stops.firstOrNull { it.code == code }?.name ?: code

    fun stop(code: String) = stops.firstOrNull { it.code == code }

    companion object {
        fun parse(o: JSONObject): Campus = parsing {
            val s = o.getJSONArray("stops")
            val r = o.optJSONArray("residences") ?: JSONArray()
            val d = o.optJSONArray("destinations") ?: JSONArray()
            val routes = o.optJSONObject("routes")
            Campus(
                stops =
                    (0 until s.length())
                        .mapNotNull {
                            val x = s.getJSONObject(it)
                            val lat = x.optDouble("lat").takeIf { v -> v.isFinite() } ?: return@mapNotNull null
                            val lon = x.optDouble("lon").takeIf { v -> v.isFinite() } ?: return@mapNotNull null
                            Stop(
                                x.getString("code"),
                                x.optString("name", x.getString("code")),
                                lat,
                                lon,
                                x.optJSONArray("services").stringList(),
                            )
                        }
                        .sortedBy { it.name },
                residences =
                    (0 until r.length())
                        .map {
                            val x = r.getJSONObject(it)
                            val st = x.getJSONArray("stops")
                            Residence(
                                x.getString("code"),
                                x.getString("name"),
                                (0 until st.length()).map { i -> st.getString(i) },
                                x.optInt("walkM"),
                                x.optBoolean("common"),
                                x.optInt("walkMin", 0).takeIf { it >= 1 },
                            )
                        }
                        .sortedWith(compareByDescending<Residence> { it.common }.thenBy { it.name }),
                destinations = (0 until d.length()).map { parseDestination(d.getJSONObject(it)) },
                colors = routes?.keys()?.asSequence()?.associateWith { parseColor(routes.getJSONObject(it).optString("color")) }.orEmpty(),
            )
        }
    }
}

data class Unplaced(val module: String, val venue: String, val day: Int, val arriveByMin: Int, val endMin: Int?, val offCampus: Boolean)

class Imported(val result: ImportResult, val version: String?)

data class ImportResult(
    val profile: JSONObject,
    val classes: Int,
    val unresolved: List<String>,
    val missing: List<String>,
    val term: String,
    val unplaced: List<Unplaced> = emptyList(),
) {
    companion object {
        fun parse(o: JSONObject): ImportResult = parsing {
            val profile = o.getJSONObject("profile")
            val un = o.optJSONArray("unresolved") ?: JSONArray()
            val miss = o.optJSONArray("missing") ?: JSONArray()
            ImportResult(
                profile = profile,
                classes = profile.optJSONArray("trips")?.length() ?: 0,
                unresolved =
                    (0 until un.length()).map {
                        un.getJSONObject(it).let { u -> L.s(R.string.module_at_venue, u.optString("module"), u.optString("venue")) }
                    },
                missing = (0 until miss.length()).map { miss.getString(it) },
                term = o.optString("term"),
                unplaced =
                    (0 until un.length()).map {
                        un.getJSONObject(it).let { u ->
                            Unplaced(
                                u.optString("module"),
                                u.optString("venue"),
                                u.optInt("day"),
                                u.optInt("arriveByMin"),
                                if (u.has("endMin")) u.optInt("endMin") else null,
                                u.optBoolean("offCampus"),
                            )
                        }
                    },
            )
        }
    }
}

fun deviceName(): String = "${android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${android.os.Build.MODEL}".take(40)

private fun coord(v: Double) = "%.4f".format(java.util.Locale.ROOT, v)

private fun parseDestination(d: JSONObject) =
    Destination(
        d.getString("code"),
        d.getString("label"),
        d.getString("stopCode"),
        d.optString("kind"),
        walkM = if (d.has("walkM")) d.optInt("walkM") else null,
        aliases = d.optJSONArray("aliases")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
        stops = d.optJSONArray("stops")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
        detail = d.optStringOrNull("detail"),
    )

internal fun parseInstant(s: String): Long? = runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()

fun hour12(ctx: android.content.Context): Boolean =
    when (Clock.pref(ctx)) {
        Clock.H12 -> true
        Clock.H24 -> false
        else -> !android.text.format.DateFormat.is24HourFormat(ctx)
    }

object Clock {
    const val AUTO = "auto"
    const val H12 = "12"
    const val H24 = "24"
    private const val KEY = "clock"

    private fun prefs(ctx: android.content.Context) =
        ctx.applicationContext.getSharedPreferences("terminus", android.content.Context.MODE_PRIVATE)

    fun pref(ctx: android.content.Context): String = prefs(ctx).getString(KEY, AUTO) ?: AUTO

    fun keep(ctx: android.content.Context, pref: String) {
        prefs(ctx).edit().putString(KEY, if (pref == H12 || pref == H24) pref else AUTO).apply()
    }
}

fun isNewer(latest: String, current: String): Boolean {
    fun parts(v: String): Pair<List<Int>, List<Int>?> {
        val (num, pre) = v.split('-', limit = 2).let { it[0] to it.getOrNull(1) }
        return num.split('.').map { it.toIntOrNull() ?: 0 } to pre?.let { p -> listOf(p.substringAfter('.', "0").toIntOrNull() ?: 0) }
    }
    fun cmp(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }
    val (an, ap) = parts(latest)
    val (bn, bp) = parts(current)
    val d = cmp(an, bn)
    if (d != 0) return d > 0
    return when {
        ap == null -> bp != null
        bp == null -> false
        else -> cmp(ap, bp) > 0
    }
}

fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)

fun parseNearby(json: JSONObject): List<NearbyStop> = parsing {
    val stops = json.getJSONArray("stops")
    (0 until stops.length()).map { i ->
        val s = stops.getJSONObject(i)
        val board = s.getJSONArray("board")
        NearbyStop(
            code = s.getJSONObject("stop").getString("code"),
            name = s.getJSONObject("stop").getString("name"),
            walkS = if (s.has("walkS") && !s.isNull("walkS")) s.optInt("walkS") else null,
            available = s.optBoolean("available", true),
            opposite = s.optStringOrNull("opposite")?.ifEmpty { null },
            longName = s.getJSONObject("stop").optStringOrNull("longName")?.ifEmpty { null },
            oppositeAcross = (s.getJSONObject("stop").takeIf { it.has("oppositeAcross") } ?: s).optBoolean("oppositeAcross", true),
            oppositeName = (s.getJSONObject("stop").optStringOrNull("oppositeName") ?: s.optStringOrNull("oppositeName"))?.ifEmpty { null },
            distM = if (s.has("distM") && !s.isNull("distM")) s.optInt("distM") else null,
            viaText = s.optStringOrNull("viaText")?.ifEmpty { null },
            board = (0 until board.length()).map { j -> parseBoardRow(board.getJSONObject(j)) },
        )
    }
}
