package sh.rcn.terminus

object SearchRank {
    const val MAX = 8

    private val KINDS = listOf("timetable", "place", "class", "service", "stop", "landmark", "building", "room")

    private const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val GAPS = Regex("[$WS\\-_]+")
    private val WORDS = Regex("[$WS()·,/&-]+")

    data class Key(val kind: String, val code: String, val label: String, val aliases: List<String> = emptyList())

    private fun kindRank(kind: String): Int = KINDS.indexOf(kind).let { if (it < 0) KINDS.size else it }

    private fun norm(s: String) = s.lowercase().replace(GAPS, "")

    private fun trim(s: String) = s.trim { it.isWhitespace() || it == '\uFEFF' }

    fun score(key: Key, query: String): Int {
        val q = trim(query).lowercase()
        if (q.isEmpty()) return -1
        val names = listOf(key.code.lowercase(), key.label.lowercase()) + key.aliases.map { it.lowercase() }
        val nq = norm(q)
        val code = if (nq.isNotEmpty()) norm(key.code) else null
        return when {
            names.any { it == q } || code == nq -> 0
            names.any { it.startsWith(q) } || (code != null && code.startsWith(nq)) -> 1
            names.any { n -> n.split(WORDS).any { it.isNotEmpty() && it.startsWith(q) } } -> 2
            names.any { it.contains(q) } -> 3
            else -> -1
        }
    }

    fun <T> rank(items: List<T>, query: String, max: Int = MAX, key: (T) -> Key): List<T> {
        val q = trim(query)
        return items
            .asSequence()
            .map { it to key(it) }
            .filter { (_, k) -> k.kind != "room" || q.length >= 2 }
            .map { (item, k) -> Triple(item, k, score(k, q)) }
            .filter { it.third >= 0 }
            .toList()
            .sortedWith(compareBy({ it.third }, { kindRank(it.second.kind) }, { it.second.label.length }))
            .take(max)
            .map { it.first }
    }

    fun <T, K> grouped(ranked: List<T>, kind: (T) -> K): List<T> = ranked.groupBy(kind).values.flatten()
}
