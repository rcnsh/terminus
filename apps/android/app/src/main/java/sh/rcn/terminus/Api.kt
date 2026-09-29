package sh.rcn.terminus

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class Place(val key: String, val label: String)

/** `/me/next`. label and detail are display-ready; show them verbatim. */
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
    /** When the bus leaves, epoch ms. Clients count down from this. */
    val departsAtMs: Long?,
    /** For a class: "on-time" | "tight" | "late", and its display text. */
    val timingStatus: String?,
    val timingText: String?,
    /** Crowd on the next bus: "low" | "medium" | "high". */
    val crowd: String?,
    /** Planned answers: when the plan changes by itself (a class starts, the day ends). */
    val refreshAtMs: Long? = null,
    /** Already at the destination: no bus, no countdown. */
    val arrived: Boolean = false,
    /** The latest time to set off, epoch ms; for a class, the latest that's still on time. */
    val leaveAtMs: Long? = null,
    /** Rests on a headway, not a live time: shown with a "~". */
    val leaveEstimated: Boolean = false,
    /** The bus the leave time is for, and its stop. Null when walking. */
    val leaveSvc: String? = null,
    val leaveStop: String? = null,
    /** When that bus leaves the stop, epoch ms. */
    val leaveBoardMs: Long? = null,
    /** When you get there by leaving at leaveAtMs: the venue for a class. */
    val leaveArriveMs: Long? = null,
    /** When you'd reach the class on the headline bus. */
    val reachMs: Long? = null,
    /** Why leave-by is earlier than it could be ("D2 is often packed…"). Shown verbatim. */
    val leaveNote: String? = null,
    /** For a class, when it starts, epoch ms. */
    val classAtMs: Long? = null,
) {
    private val tilde get() = if (leaveEstimated) "~" else ""

    /**
     * A class with a leave-by time: the card leads with when to leave, and
     * the next bus becomes the "or go now" option.
     */
    val isClassPlan: Boolean get() = why == "class" && leaveAtMs != null && classAtMs != null && !arrived && mode == "trip"

    /** "Leave by ~09:38", or "Leave now" once it has passed. */
    fun leaveHeadline(now: Long, format: (Long) -> String): String? {
        val at = leaveAtMs ?: return null
        return if (now >= at) "Leave now" else "Leave by $tilde${format(at)}"
    }

    /** "Catch the ~09:41 D2 at PGP · arrive ~09:55, 3 min early", or on foot. */
    fun catchLine(format: (Long) -> String): String? {
        leaveAtMs ?: return null
        val how = when {
            leaveSvc == null -> "Walk there"
            leaveBoardMs != null -> "Catch the $tilde${format(leaveBoardMs)} $leaveSvc at $leaveStop"
            else -> "Catch the $leaveSvc at $leaveStop"
        }
        val arrive = leaveArriveMs ?: return how
        return "$how · arrive $tilde${format(arrive)}${classAtMs?.let { ", ${slack(arrive, it)}" }.orEmpty()}"
    }

    /** Whether the leave-by trip gets there in time. */
    val leaveLate: Boolean get() = leaveArriveMs != null && classAtMs != null && leaveArriveMs > classAtMs

    /** The headline bus, when it's not the one to wait for: "Or go now: R2 at 15:31 · arrive 15:38". */
    fun goNowLine(format: (Long) -> String): String? {
        val departs = departsAtMs ?: return null
        if (quality == "unknown" || quality == "ended") return null
        val board = leaveBoardMs
        if (board != null && kotlin.math.abs(board - departs) < 60_000) return null
        val svc = label.substringBefore(" · ")
        val est = if (quality == "scheduled") "~" else ""
        return "Or go now: $svc at $est${format(departs)}${reachMs?.let { " · arrive ${format(it)}" }.orEmpty()}"
    }

    /** For other trips and notifications: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
    fun leaveText(now: Long, format: (Long) -> String): String? {
        val head = leaveHeadline(now, format) ?: return null
        val bus = leaveSvc?.let { svc -> " · catch the ${leaveBoardMs?.let { "$tilde${format(it)} " }.orEmpty()}$svc at $leaveStop" }.orEmpty()
        return head + bus
    }

    private fun slack(arrive: Long, classAt: Long): String {
        val min = Math.round((classAt - arrive) / 60_000.0).toInt()
        return when {
            min > 0 -> "$min min early"
            min == 0 -> "just in time"
            else -> "~${-min} min late"
        }
    }

    /** "D2 · 09:42" when there's a departure time; otherwise the label as sent.
     *  A timetable estimate gets a "~": it is not a live time. */
    fun clockLabel(format: (Long) -> String): String {
        val at = departsAtMs ?: return label
        if (quality == "unknown" || quality == "ended") return label
        return "${label.substringBefore(" · ")} · ${if (quality == "scheduled") "~" else ""}${format(at)}"
    }

    companion object {
        fun parse(o: JSONObject): NextAnswer {
            val dest = o.optJSONObject("dest")
            val places = o.optJSONArray("places") ?: JSONArray()
            return NextAnswer(
                label = o.getString("label"),
                detail = o.optString("detail"),
                alt = o.optStringOrNull("alt"),
                stopName = o.optJSONObject("stop")?.optString("name").orEmpty(),
                quality = o.optString("quality", "unknown"),
                asOf = o.optString("asOf"),
                mode = o.optString("mode", "trip"),
                destLabel = dest?.optStringOrNull("label"),
                why = dest?.optStringOrNull("why"),
                places = (0 until places.length()).map {
                    val p = places.getJSONObject(it)
                    Place(p.getString("key"), p.getString("label"))
                },
                departsAtMs = o.optStringOrNull("departsAt")?.let(::parseInstant),
                refreshAtMs = o.optStringOrNull("refreshAt")?.let(::parseInstant),
                arrived = o.optBoolean("arrived", false),
                leaveAtMs = o.optJSONObject("leave")?.optStringOrNull("at")?.let(::parseInstant),
                leaveEstimated = o.optJSONObject("leave")?.optBoolean("estimated", false) ?: false,
                leaveSvc = o.optJSONObject("leave")?.optStringOrNull("svc"),
                leaveStop = o.optJSONObject("leave")?.optStringOrNull("stop"),
                leaveBoardMs = o.optJSONObject("leave")?.optStringOrNull("board")?.let(::parseInstant),
                leaveArriveMs = o.optJSONObject("leave")?.optStringOrNull("arrive")?.let(::parseInstant),
                reachMs = o.optJSONObject("timing")?.optStringOrNull("reachAt")?.let(::parseInstant),
                leaveNote = o.optJSONObject("leave")?.optStringOrNull("note"),
                classAtMs = o.optJSONObject("timing")?.optStringOrNull("classAt")?.let(::parseInstant),
                timingStatus = o.optJSONObject("timing")?.optStringOrNull("status"),
                timingText = o.optJSONObject("timing")?.optStringOrNull("text"),
                // The recommended bus's crowd, not whichever bus is first in the list.
                crowd = o.optJSONArray("arrivals")?.let { arr ->
                    val svc = o.getString("label").substringBefore(" · ")
                    (0 until arr.length()).map { arr.getJSONObject(it) }
                        .firstOrNull { it.optString("svc") == svc }?.optStringOrNull("crowd")
                },
            )
        }
    }
}

data class BoardRow(val svc: String, val etaS: Int?, val quality: String)

data class NearbyStop(
    val code: String,
    val name: String,
    val walkS: Int,
    val available: Boolean,
    val board: List<BoardRow>,
)

data class Destination(
    val code: String,
    val label: String,
    val stopCode: String,
    val kind: String,
    /** Metres on foot from the stop; null for a stop. */
    val walkM: Int? = null,
    /** Other names people search for, lower case ("soc", "mrt"). */
    val aliases: List<String> = emptyList(),
    /** A landmark's every stop; the router takes the quicker. */
    val stops: List<String> = emptyList(),
    /** What a landmark is ("Food court"). */
    val detail: String? = null,
)

/**
 * The destination search, same rules as the account page: exact, then starts
 * with, then a word starts with, then contains; stops before buildings before
 * rooms, and rooms only once two characters say which.
 */
fun rankDestinations(all: List<Destination>, query: String, max: Int = 8): List<Destination> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val norm = { s: String -> s.lowercase().replace(Regex("[\\s\\-_]+"), "") }
    val nq = norm(q)
    val kinds = listOf("stop", "landmark", "building", "room")
    fun score(d: Destination): Int {
        val names = listOf(d.code.lowercase(), d.label.lowercase()) + d.aliases
        return when {
            names.any { it == q } || norm(d.code) == nq -> 0
            names.any { it.startsWith(q) } || norm(d.code).startsWith(nq) -> 1
            names.any { n -> n.split(Regex("[\\s()·,/&-]+")).any { it.isNotEmpty() && it.startsWith(q) } } -> 2
            names.any { it.contains(q) } -> 3
            else -> -1
        }
    }
    return all.asSequence()
        .filter { it.kind != "room" || q.length >= 2 }
        .map { it to score(it) }
        .filter { it.second >= 0 }
        .sortedWith(compareBy({ it.second }, { kinds.indexOf(it.first.kind) }, { it.first.label.length }))
        .take(max)
        .map { it.first }
        .toList()
}

/** What the user asked for: the planned trip, a saved place, or any stop/venue. */
sealed interface Target {
    data object Plan : Target
    data class SavedPlace(val key: String) : Target
    data class Code(val code: String, val label: String) : Target
}

class ApiError(val status: Int, message: String) : IOException(message)

/** `fast` is for the widget: a tap runs inside a broadcast, which can be killed. */
class Api(private val token: String?, private val fast: Boolean = false) {

    suspend fun pair(code: String, name: String): String {
        val body = JSONObject().put("code", code).put("name", name)
        return request("POST", "/pair", body).getString("token")
    }

    suspend fun next(target: Target, lat: Double?, lon: Double?): NextAnswer =
        NextAnswer.parse(nextJson(target, lat, lon))

    /** Raw form, for the widget cache. */
    suspend fun nextJson(target: Target, lat: Double?, lon: Double?): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
            }
            when (target) {
                Target.Plan -> {}
                is Target.SavedPlace -> add("place=${enc(target.key)}")
                is Target.Code -> add("to=${enc(target.code)}")
            }
        }
        return request("GET", "/me/next" + query(q))
    }

    suspend fun nearby(lat: Double?, lon: Double?): List<NearbyStop> {
        val q = if (lat != null && lon != null) listOf("lat=${coord(lat)}", "lon=${coord(lon)}") else emptyList()
        val stops = request("GET", "/me/nearby" + query(q)).getJSONArray("stops")
        return (0 until stops.length()).map { i ->
            val s = stops.getJSONObject(i)
            val board = s.getJSONArray("board")
            NearbyStop(
                code = s.getJSONObject("stop").getString("code"),
                name = s.getJSONObject("stop").getString("name"),
                walkS = s.optInt("walkS"),
                available = s.optBoolean("available", true),
                board = (0 until board.length()).map { j ->
                    val r = board.getJSONObject(j)
                    BoardRow(r.getString("svc"), if (r.isNull("etaS")) null else r.getInt("etaS"), r.optString("quality"))
                },
            )
        }
    }

    suspend fun destinations(): List<Destination> {
        val list = request("GET", "/campus").getJSONArray("destinations")
        return (0 until list.length()).map {
            val d = list.getJSONObject(it)
            Destination(
                d.getString("code"), d.getString("label"), d.getString("stopCode"), d.optString("kind"),
                walkM = if (d.has("walkM")) d.optInt("walkM") else null,
                aliases = d.optJSONArray("aliases")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
                stops = d.optJSONArray("stops")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
                detail = d.optStringOrNull("detail"),
            )
        }
    }

    /** Whose account a pairing code belongs to (masked), without spending it. */
    suspend fun pairCheck(code: String): String =
        request("POST", "/pair/check", JSONObject().put("code", code)).getString("account")

    /** The released version, from /download/latest.json. */
    suspend fun latestVersion(): String = request("GET", "/download/latest.json").getString("version")

    /** Ends this device's session on the server. */
    suspend fun logout() {
        request("POST", "/auth/logout", JSONObject())
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val conn = URL(BuildConfig.API_BASE + path).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = method
                conn.connectTimeout = if (fast) 4_000 else 8_000
                conn.readTimeout = if (fast) 5_000 else 10_000
                conn.setRequestProperty("accept", "application/json")
                token?.let { conn.setRequestProperty("authorization", "Bearer $it") }
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("content-type", "application/json")
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val status = conn.responseCode
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                if (status !in 200..299) throw ApiError(status, json.optString("error", "HTTP $status"))
                json
            } finally {
                conn.disconnect()
            }
        }

    private fun query(parts: List<String>) = if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/**
 * Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and no
 * more precise than that in URLs that pass through logs.
 */
private fun coord(v: Double) = "%.4f".format(java.util.Locale.ROOT, v)

private fun parseInstant(s: String): Long? = runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()

/** "1.0.10" > "1.0.9". */
fun isNewer(latest: String, current: String): Boolean {
    val a = latest.split('.').map { it.toIntOrNull() ?: 0 }
    val b = current.split('.').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(a.size, b.size)) {
        val d = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
        if (d != 0) return d > 0
    }
    return false
}

fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)
