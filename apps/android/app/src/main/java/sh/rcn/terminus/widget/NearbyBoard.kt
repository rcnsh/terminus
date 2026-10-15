package sh.rcn.terminus.widget

import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.parseColor

/**
 * A service's next bus at a stop, as a Nearby widget shows it: worked out once from a fetched board, its times on the phone's clock. Shown
 * as clock times ("9:42"), which stay true between redraws where a countdown would stand still.
 */
internal data class StopBus(
    val svc: String,
    val color: Long,
    val paid: Boolean,
    /** When it's due, epoch ms on the phone's clock. */
    val atMs: Long,
    val live: Boolean,
    /** How full it is ("low", "medium", "high"); only the server's next bus has one. */
    val crowd: String?,
    /** Its next stop (`towards[0]`); null at the end of the line, or from an older server. */
    val next: String?,
    /** Where its line ends, when that isn't the next stop. */
    val end: String?,
    val endsHere: Boolean,
    /** The buses after it, epoch ms on the phone's clock. */
    val later: List<Long>,
    /** The service's first bus when it starts again: none of the stop's services is running now. A timetable's time. */
    val first: Boolean = false,
)

internal object NearbyBoard {
    /** A bus stays shown this long after it's due: it may be at the stop, or a little late. */
    const val GONE_MS = 60_000L

    private const val GREY = 0xFF8A939CL

    /**
     * The services at [stop] with a time, soonest first, from a board fetched at [fetchedAt] (the phone's clock, as [now]). A bus gone by
     * [now] gives way to the service's next one; a service with none left isn't shown. With none running at all, each service's first bus
     * when it starts again ([StopBus.first]), from a board asked for with `stopped=1`; [skewMs] puts the server's times on the phone's
     * clock.
     */
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
                    endsHere = r.endsHere,
                    later = times.drop(1).map { it.second },
                )
            }
            .sortedBy { it.atMs }

    private data class Due(val s: Int, val live: Boolean, val crowd: String?)

    /**
     * Where [bus] ends, when the widget should say so: another bus in [shown] has the same next stop but ends somewhere else, so the next
     * stop alone wouldn't tell them apart (A1, D2 and K all stop next at LT27 from Kent Ridge MRT).
     */
    fun endIfNeeded(bus: StopBus, shown: List<StopBus>): String? {
        val end = bus.end ?: return null
        return end.takeIf { shown.any { it !== bus && it.next == bus.next && it.end != end } }
    }

    /** When the widget next looks different with nothing new: a shown bus going ([GONE_MS] after it's due). */
    fun redrawAt(buses: List<StopBus>, now: Long): Long? =
        buses.flatMap { listOf(it.atMs) + it.later }.map { it + GONE_MS }.filter { it > now }.minOrNull()

    /** Page [page] of [buses], [per] to a page, counting round; with which page it is and how many there are. */
    fun page(buses: List<StopBus>, per: Int, page: Int): Paged {
        val pages = maxOf(1, (buses.size + per - 1) / per)
        val p = Math.floorMod(page, pages)
        return Paged(buses.drop(p * per).take(per), p, pages)
    }

    data class Paged(val buses: List<StopBus>, val page: Int, val pages: Int)
}

/**
 * How a Nearby widget lays itself out by its size: one bus (2×1), two side by side in a bar (4×1), rows with the time at the end (narrow
 * ones, 3×2), or tiles under the sky, two or three across, more rows as it gets taller. One row of tiles pages through the rest ([pager])
 * when there's room for the arrows; more rows list the rest along the bottom ([footer]).
 */
internal data class NearbyFit(
    val kind: Kind,
    val cols: Int = 1,
    val rows: Int = 1,
    val pager: Boolean = false,
    /** Room under the rows for the services that don't fit. */
    val footer: Boolean = false,
) {
    enum class Kind {
        MINI,
        BAR,
        ROWS,
        TILES,
    }

    val shown: Int
        get() = cols * rows

    companion object {
        /**
         * A tile at its smallest: the time, two lines for the next stop, the pills; three across, the later buses have a line of their own
         * too.
         */
        fun tileDp(cols: Int): Float = if (cols >= 3) 112f else 98f

        const val ROW_DP = 36f
        /** Tall enough to tap the pager's arrows. */
        const val PAGER_DP = 20f
        const val FOOTER_DP = 22f
        /** A Glance Column holds at most 10 children: rows and the rules between them. */
        private const val MAX_ROWS = 5

        /** [skyDp]: the sky over the buses, taller with the chips on it. */
        fun of(widthDp: Float, heightDp: Float, skyDp: Float): NearbyFit {
            if (heightDp < 130f) return if (widthDp < 220f) NearbyFit(Kind.MINI) else NearbyFit(Kind.BAR, cols = 2)
            // The home screen's sizes come a fraction short of whole dp: a dp to spare.
            val area = heightDp - skyDp + 1f
            val cols = if (widthDp >= 380f) 3 else 2
            val tile = tileDp(cols)
            // Too narrow for two columns, or too short for a tile: rows.
            if (widthDp < 300f || area < tile) return NearbyFit(Kind.ROWS, rows = (area / ROW_DP).toInt().coerceIn(1, MAX_ROWS))
            // More rows of tiles where they fit, else room for the rest under them.
            val bare = (area / tile).toInt()
            val withFooter = ((area - FOOTER_DP) / tile).toInt()
            if (bare < 2) return NearbyFit(Kind.TILES, cols, 1, pager = area >= tile + PAGER_DP)
            return if (bare > withFooter) NearbyFit(Kind.TILES, cols, bare.coerceAtMost(4))
            else NearbyFit(Kind.TILES, cols, withFooter.coerceAtMost(4), footer = true)
        }
    }
}
