package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.pow

/**
 * Where you go, for the app's tabs and the widget's buttons:
 * favourites, ranked by how often you've asked for them lately, then the
 * places added from "Go somewhere else", newest first. Both the counts and
 * the added places stay on the phone, never sent anywhere.
 */
object Destinations {
    /** A count halves over this many days, so last month's routine gives way to this month's. */
    private const val HALF_LIFE_DAYS = 14.0
    /** Kept at most this many, dropping the least used. */
    private const val MAX_KEPT = 30
    /** Added places kept: a new one past this drops the oldest. */
    const val MAX_ADDED = 5

    /** A place to go: `place:<key>` for a saved place, `stop:<code>` for a stop or place looked up. */
    data class Dest(val id: String, val label: String)

    data class Use(val label: String, val count: Double, val lastMs: Long)

    fun placeId(key: String) = "place:$key"
    fun stopId(code: String) = "stop:$code"

    /**
     * The widget's buttons after Timetable and Nearby: favourites, the most
     * used first (in their own order when nothing has been used), then the
     * added places.
     */
    fun rank(places: List<Place>, added: List<Dest>, used: Map<String, Use>, now: Long): List<Dest> {
        val saved = places.mapIndexed { i, p -> Triple(Dest(placeId(p.key), p.label), i, used[placeId(p.key)]) }
            .sortedWith(
                compareByDescending<Triple<Dest, Int, Use?>> { (_, _, u) -> u?.let { weight(it, now) } ?: 0.0 }
                    .thenBy { it.second },
            )
            .map { it.first }
        // A place that is also a favourite shows once, as the favourite.
        return (saved + added).distinctBy { it.label.lowercase() }
    }

    /** `dest` added at the front, unless it's there already or is a favourite; at most [MAX_ADDED]. */
    fun add(added: List<Dest>, dest: Dest, places: List<Place>): List<Dest> {
        if (added.any { it.id == dest.id } || places.any { it.label.equals(dest.label, ignoreCase = true) }) return added
        return (listOf(dest) + added).take(MAX_ADDED)
    }

    fun parseAdded(raw: String?): List<Dest> = runCatching {
        val a = JSONArray(raw ?: return emptyList())
        (0 until a.length()).map { a.getJSONObject(it).let { o -> Dest(o.getString("id"), o.getString("l")) } }
    }.getOrDefault(emptyList())

    fun serialiseAdded(added: List<Dest>): String =
        JSONArray(added.map { JSONObject().put("id", it.id).put("l", it.label) }).toString()

    fun weight(u: Use, now: Long): Double {
        val days = (now - u.lastMs).coerceAtLeast(0) / 86_400_000.0
        return u.count * 0.5.pow(days / HALF_LIFE_DAYS)
    }

    /** One more use of `dest`: the old count decayed to now, plus one. */
    fun note(used: Map<String, Use>, dest: Dest, now: Long): Map<String, Use> {
        val before = used[dest.id]
        val next = used + (dest.id to Use(dest.label, (before?.let { weight(it, now) } ?: 0.0) + 1, now))
        return if (next.size <= MAX_KEPT) next else next.entries.sortedByDescending { weight(it.value, now) }.take(MAX_KEPT).associate { it.toPair() }
    }

    fun parse(raw: String?): Map<String, Use> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return runCatching {
            val o = JSONObject(raw)
            o.keys().asSequence().associateWith { k ->
                val u = o.getJSONObject(k)
                Use(u.getString("l"), u.getDouble("n"), u.getLong("t"))
            }
        }.getOrDefault(emptyMap())
    }

    fun serialise(used: Map<String, Use>): String {
        val o = JSONObject()
        for ((k, u) in used) o.put(k, JSONObject().put("l", u.label).put("n", u.count).put("t", u.lastMs))
        return o.toString()
    }
}
