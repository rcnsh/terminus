package sh.rcn.terminus

import kotlin.math.pow
import org.json.JSONArray
import org.json.JSONObject

object Destinations {
    private const val HALF_LIFE_DAYS = 14.0
    private const val MAX_KEPT = 30
    const val MAX_ADDED = 5

    data class Dest(val id: String, val label: String)

    data class Use(val label: String, val count: Double, val lastMs: Long)

    fun placeId(key: String) = "place:$key"

    fun stopId(code: String) = "stop:$code"

    fun rank(places: List<Place>, added: List<Dest>, used: Map<String, Use>, now: Long): List<Dest> {
        val saved =
            places
                .mapIndexed { i, p -> Triple(Dest(placeId(p.key), p.label), i, used[placeId(p.key)]) }
                .sortedWith(
                    compareByDescending<Triple<Dest, Int, Use?>> { (_, _, u) -> u?.let { weight(it, now) } ?: 0.0 }.thenBy { it.second }
                )
                .map { it.first }
        return (saved + added).distinctBy { it.label.lowercase() }
    }

    fun add(added: List<Dest>, dest: Dest, places: List<Place>): List<Dest> {
        if (added.any { it.id == dest.id } || places.any { it.label.equals(dest.label, ignoreCase = true) }) return added
        return (listOf(dest) + added).take(MAX_ADDED)
    }

    fun parseAdded(raw: String?): List<Dest> = runCatching {
        val a = JSONArray(raw ?: return emptyList())
        (0 until a.length()).map { a.getJSONObject(it).let { o -> Dest(o.getString("id"), o.getString("l")) } }
    }
        .getOrDefault(emptyList())

    fun serialiseAdded(added: List<Dest>): String = JSONArray(added.map { JSONObject().put("id", it.id).put("l", it.label) }).toString()

    fun weight(u: Use, now: Long): Double {
        val days = (now - u.lastMs).coerceAtLeast(0) / 86_400_000.0
        return u.count * 0.5.pow(days / HALF_LIFE_DAYS)
    }

    fun note(used: Map<String, Use>, dest: Dest, now: Long): Map<String, Use> {
        val before = used[dest.id]
        val next = used + (dest.id to Use(dest.label, (before?.let { weight(it, now) } ?: 0.0) + 1, now))
        return if (next.size <= MAX_KEPT) next
        else next.entries.sortedByDescending { weight(it.value, now) }.take(MAX_KEPT).associate { it.toPair() }
    }

    fun parse(raw: String?): Map<String, Use> {
        if (raw.isNullOrEmpty()) return emptyMap()
        return runCatching {
                val o = JSONObject(raw)
                o.keys().asSequence().associateWith { k ->
                    val u = o.getJSONObject(k)
                    Use(u.getString("l"), u.getDouble("n"), u.getLong("t"))
                }
            }
            .getOrDefault(emptyMap())
    }

    fun serialise(used: Map<String, Use>): String {
        val o = JSONObject()
        for ((k, u) in used) o.put(k, JSONObject().put("l", u.label).put("n", u.count).put("t", u.lastMs))
        return o.toString()
    }
}
