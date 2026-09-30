package sh.rcn.terminus

import org.json.JSONObject
import kotlin.math.pow

/**
 * Where you usually go (phase 8.3), for the widget's buttons: saved places
 * and stops you look up, ranked by how often you've asked for them lately.
 * Counted on the phone only, never sent anywhere.
 */
object Destinations {
    /** A count halves over this many days, so last month's routine gives way to this month's. */
    private const val HALF_LIFE_DAYS = 14.0
    /** A looked-up stop becomes a button once asked for this often (a saved place always is one). */
    private const val MIN_STOP_USES = 2
    /** Kept at most this many, dropping the least used. */
    private const val MAX_KEPT = 30

    /** A place to go: `place:<key>` for a saved place, `stop:<code>` for a stop or place looked up. */
    data class Dest(val id: String, val label: String)

    data class Use(val label: String, val count: Double, val lastMs: Long)

    fun placeId(key: String) = "place:$key"
    fun stopId(code: String) = "stop:$code"

    /** Saved places first when nothing has been used, then the most used, weighted to recent use. */
    fun rank(places: List<Place>, used: Map<String, Use>, now: Long): List<Dest> {
        val saved = places.mapIndexed { i, p -> Triple(Dest(placeId(p.key), p.label), i, used[placeId(p.key)]) }
        val looked = used.filter { (id, u) -> id.startsWith("stop:") && u.count >= MIN_STOP_USES }
            .map { (id, u) -> Triple(Dest(id, u.label), places.size, u) }
        return (saved + looked)
            .sortedWith(
                compareByDescending<Triple<Dest, Int, Use?>> { (_, _, u) -> u?.let { weight(it, now) } ?: 0.0 }
                    .thenBy { it.second },
            )
            .map { it.first }
            // A stop that is also a saved place shows once, as the place.
            .distinctBy { it.label.lowercase() }
    }

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
