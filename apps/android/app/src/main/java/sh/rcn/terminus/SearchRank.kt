package sh.rcn.terminus

/**
 * The destination search's ranking, as every client ranks it: the web's
 * (apps/web/public/account/search.js) is the reference, and the rules and
 * the cases all three are held to are in apps/api/test/fixtures/search.json
 * (SearchTest). Exact, then starts with, then a word starts with, then
 * contains; then by kind, by label length, and in the index's order.
 */
object SearchRank {
    /** At most this many results. */
    const val MAX = 8

    /** A service before a stop that matches as well; a kind this version doesn't know comes after every known one. */
    private val KINDS = listOf("timetable", "place", "class", "service", "stop", "landmark", "building", "room")

    /** JavaScript's `\s`, which the reference uses: Java's own leaves out the Unicode spaces. */
    private const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val GAPS = Regex("[$WS\\-_]+")
    private val WORDS = Regex("[$WS()·,/&-]+")

    /** What one entry is searched by. */
    data class Key(val kind: String, val code: String, val label: String, val aliases: List<String> = emptyList())

    private fun kindRank(kind: String): Int = KINDS.indexOf(kind).let { if (it < 0) KINDS.size else it }

    /** A code as typed any way: lower case, without spaces, hyphens or underscores ("COM1-0203" is "com10203"). */
    private fun norm(s: String) = s.lowercase().replace(GAPS, "")

    /** JavaScript's trim(): its whitespace, and the line terminators. */
    private fun trim(s: String) = s.trim { it.isWhitespace() || it == '\uFEFF' }

    /** 0 exact, 1 starts with, 2 a word starts with, 3 contains; -1 no match. */
    fun score(key: Key, query: String): Int {
        val q = trim(query).lowercase()
        if (q.isEmpty()) return -1
        val names = listOf(key.code.lowercase(), key.label.lowercase()) + key.aliases.map { it.lowercase() }
        // Only hyphens or underscores typed: nothing to match a code by.
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

    /** The best [max] of [items] for [query], most useful first. Rooms only once the query is two characters. */
    fun <T> rank(items: List<T>, query: String, max: Int = MAX, key: (T) -> Key): List<T> {
        val q = trim(query)
        return items.asSequence()
            .map { it to key(it) }
            .filter { (_, k) -> k.kind != "room" || q.length >= 2 }
            .map { (item, k) -> Triple(item, k, score(k, q)) }
            .filter { it.third >= 0 }
            .toList()
            // A stable sort: ties keep the index's order.
            .sortedWith(compareBy({ it.third }, { kindRank(it.second.kind) }, { it.second.label.length }))
            .take(max)
            .map { it.first }
    }
}
