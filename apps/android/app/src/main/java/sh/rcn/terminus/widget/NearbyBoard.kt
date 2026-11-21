package sh.rcn.terminus.widget

import sh.rcn.terminus.L
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.R
import sh.rcn.terminus.parseColor

internal data class StopBus(
    val svc: String,
    val color: Long,
    val paid: Boolean,
    val atMs: Long,
    val live: Boolean,
    val crowd: String?,
    val next: String?,
    val end: String?,
    val endsHere: Boolean,
    val later: List<Long>,
    val first: Boolean = false,
    val via: List<String> = emptyList(),
)

internal object NearbyBoard {
    const val GONE_MS = 60_000L

    private const val GREY = 0xFF8A939CL

    fun buses(stop: NearbyStop, fetchedAt: Long, now: Long, skewMs: Long = 0L): List<StopBus> =
        running(stop, fetchedAt, now).ifEmpty { firsts(stop, now, skewMs) }

    private fun firsts(stop: NearbyStop, now: Long, skewMs: Long): List<StopBus> =
        stop.board
            .mapNotNull { r ->
                val at = (r.resumesAtMs ?: return@mapNotNull null) - skewMs
                if (r.running || at <= now) return@mapNotNull null
                StopBus(
                    svc = r.svc,
                    color = r.color?.let(::parseColor) ?: GREY,
                    paid = r.paid,
                    atMs = at,
                    live = false,
                    crowd = null,
                    next = r.towards.firstOrNull(),
                    end = r.towards.drop(1).lastOrNull(),
                    via = r.via,
                    endsHere = r.endsHere,
                    later = emptyList(),
                    first = true,
                )
            }
            .sortedBy { it.atMs }

    private fun running(stop: NearbyStop, fetchedAt: Long, now: Long): List<StopBus> =
        stop.board
            .mapNotNull { r ->
                val first = r.etaS ?: return@mapNotNull null
                val times =
                    (listOf(Due(first, r.quality == "live", r.crowd)) + r.later.map { Due(it.etaS, it.quality == "live", null) })
                        .map { it to fetchedAt + it.s * 1000L }
                        .filter { (_, at) -> at > now - GONE_MS }
                val (due, at) = times.firstOrNull() ?: return@mapNotNull null
                StopBus(
                    svc = r.svc,
                    color = r.color?.let(::parseColor) ?: GREY,
                    paid = r.paid,
                    atMs = at,
                    live = due.live,
                    crowd = due.crowd,
                    next = r.towards.firstOrNull(),
                    end = r.towards.drop(1).lastOrNull(),
                    via = r.via,
                    endsHere = r.endsHere,
                    later = times.drop(1).map { it.second },
                )
            }
            .sortedBy { it.atMs }

    private data class Due(val s: Int, val live: Boolean, val crowd: String?)

    fun endIfNeeded(bus: StopBus, shown: List<StopBus>): String? {
        val end = bus.end ?: return null
        return end.takeIf { shown.any { it !== bus && it.next == bus.next && it.end != end } }
    }

    const val MINUTES_MS = 15 * 60_000L

    fun minutesLeft(atMs: Long, now: Long): Int? = (atMs - now).takeIf { it < MINUTES_MS }?.let { maxOf(0L, it / 60_000L).toInt() }

    fun minutesWords(left: Int, live: Boolean): String =
        when {
            !live -> L.s(R.string.nearby_min_approx, maxOf(1, left))
            left == 0 -> L.s(R.string.now)
            else -> L.s(R.string.nearby_min, left)
        }

    fun redrawAt(buses: List<StopBus>, now: Long, minutesUntil: Long? = null): Long? {
        val gone = buses.flatMap { listOf(it.atMs) + it.later }.map { it + GONE_MS }
        val ticks = minutesUntil?.let { until ->
            buses.filter { !it.first }.flatMap { b -> (1..MINUTES_MS / 60_000L).map { b.atMs - it * 60_000L } }.filter { it < until }
        }
        return (gone + ticks.orEmpty()).filter { it > now }.minOrNull()
    }

    fun boardRedrawAt(stops: List<NearbyStop>, fetchedAt: Long, now: Long, exact: Boolean, skewMs: Long = 0L): Long? {
        val old = fetchedAt + WidgetModes.NEARBY_OLD_MS
        val buses = stops.take(2).flatMap { buses(it, fetchedAt, now, skewMs) }
        return listOfNotNull(old, redrawAt(buses, now, old.takeIf { exact })).filter { it > now }.minOrNull()
    }

    fun boardRefetchAt(stops: List<NearbyStop>, fetchedAt: Long, skewMs: Long = 0L): Long =
        boardRedrawAt(stops, fetchedAt, fetchedAt, exact = false, skewMs) ?: (fetchedAt + WidgetModes.NEARBY_OLD_MS)

    fun page(buses: List<StopBus>, per: Int, page: Int): Paged {
        val pages = maxOf(1, (buses.size + per - 1) / per)
        val p = Math.floorMod(page, pages)
        return Paged(buses.drop(p * per).take(per), p, pages)
    }

    data class Paged(val buses: List<StopBus>, val page: Int, val pages: Int)

    fun beside(stops: List<NearbyStop>, buses: (NearbyStop) -> List<StopBus>): NearbyStop? {
        val first = stops.firstOrNull() ?: return null
        return stops.drop(1).firstOrNull { it.code == first.opposite } ?: stops.drop(1).firstOrNull { buses(it).isNotEmpty() }
    }
}

internal data class NearbyFit(
    val kind: Kind,
    val cols: Int = 1,
    val rows: Int = 1,
    val pager: Boolean = false,
    val footer: Boolean = false,
) {
    enum class Kind {
        MINI,
        BAR,
        ROWS,
        TILES,
        SIDES,
    }

    val shown: Int
        get() = cols * rows

    companion object {
        fun tileDp(cols: Int): Float = if (cols >= 3) 112f else 98f

        const val ROW_DP = 36f
        const val PAGER_DP = 20f
        const val FOOTER_DP = 22f
        private const val MAX_ROWS = 5

        const val SIDE_ROW_DP = 30f
        const val SIDE_ROW_NEW_DP = 34f
        const val SIDE_HEAD_DP = 20f
        const val SIDE_HEAD_NEW_DP = 34f
        const val SIDES_SKY_DP = 42f

        fun sides(widthDp: Float, heightDp: Float, skyDp: Float, newcomer: Boolean): NearbyFit? {
            if (widthDp < 300f || heightDp < 130f) return null
            val head = if (newcomer) SIDE_HEAD_NEW_DP else SIDE_HEAD_DP
            val row = if (newcomer) SIDE_ROW_NEW_DP else SIDE_ROW_DP
            val rows = ((heightDp - skyDp + 1f - head - BOTTOM_DP) / (row + 1f)).toInt()
            return if (rows < 2) null else NearbyFit(Kind.SIDES, cols = 2, rows = rows.coerceAtMost(MAX_ROWS))
        }

        const val BOTTOM_DP = 6f

        fun of(widthDp: Float, heightDp: Float, skyDp: Float): NearbyFit {
            if (heightDp < 130f) return if (widthDp < 220f) NearbyFit(Kind.MINI) else NearbyFit(Kind.BAR, cols = 2)
            val area = heightDp - skyDp + 1f
            val cols = if (widthDp >= 380f) 3 else 2
            val tile = tileDp(cols)
            if (widthDp < 300f || area < tile) return NearbyFit(Kind.ROWS, rows = (area / ROW_DP).toInt().coerceIn(1, MAX_ROWS))
            val bare = (area / tile).toInt()
            val withFooter = ((area - FOOTER_DP) / tile).toInt()
            if (bare < 2) return NearbyFit(Kind.TILES, cols, 1, pager = area >= tile + PAGER_DP)
            return if (bare > withFooter) NearbyFit(Kind.TILES, cols, bare.coerceAtMost(4))
            else NearbyFit(Kind.TILES, cols, withFooter.coerceAtMost(4), footer = true)
        }
    }
}
