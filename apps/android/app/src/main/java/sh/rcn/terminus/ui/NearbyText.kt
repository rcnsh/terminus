package sh.rcn.terminus.ui

import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken

/**
 * What Nearby's rows show and say, worded here so the JVM tests can check it: where each bus is going, and its three buses (Next, Then,
 * After) read like a stop's board, the next one large.
 */
internal object NearbyText {
    /** One of a row's three buses, the row's own or one of its `later`. */
    data class Bus(val etaS: Int?, val quality: String, val eta: String?)

    /**
     * A bus in its column, in minutes. [figure] is drawn large and [after] small beside it ("4" " min"), after [mark] ("~" for a guess, in
     * both languages). [next]: the Next column's bus, drawn large and in ink. [said] is how a screen reader says it; null with no bus.
     */
    data class Cell(
        val figure: String,
        val mark: String = "",
        val after: String = "",
        val next: Boolean = false,
        val said: String? = null,
    ) {
        /** As one string. */
        val text: String
            get() = mark + figure + after
    }

    /** Where a row's bus is going, "via UTown", with [place] the part set apart ("UTown"); null to show it all alike. */
    data class Dest(val text: String, val place: IntRange? = null) {
        /** With the place's spaces made no-break, so a line wraps before it rather than inside it: for a place that fits on a line. */
        fun whole(): Dest = place?.let { copy(text = text.replaceRange(it, text.substring(it).replace(' ', '\u00a0'))) } ?: this

        /**
         * With every space a plain one, the server's no-break spaces in a short place ("KR Bus Ter") included, so a line can break inside
         * the place: for one that doesn't fit whole. The same length, so [place] still marks it.
         */
        fun loose(): Dest = copy(text = text.replace('\u00a0', ' '))
    }

    private val NONE = Cell("–")
    private val DIGITS = Regex("\\d+")

    /** The server's words ("to PGP Foyer", "via UTown", "Ends here"), its place set apart; an older server's end of the line otherwise. */
    fun dest(row: BoardRow): Dest {
        val words =
            row.dest
                ?: return Dest(row.towards.lastOrNull()?.let { L.s(R.string.nearby_to, it) } ?: row.toText ?: L.s(R.string.buses_ends_here))
        val at = row.destPlace?.let { words.indexOf(it) } ?: -1
        return if (at < 0) Dest(words) else Dest(words, at until at + row.destPlace!!.length)
    }

    /** The row's three buses in order, Next, Then, After; null where there's none. */
    fun buses(row: BoardRow): List<Bus?> =
        listOf(Bus(row.etaS, row.quality, row.eta)) + (0..1).map { k -> row.later.getOrNull(k)?.let { Bus(it.etaS, it.quality, it.eta) } }

    /** A row's three cells, Next, Then, After. */
    fun cells(row: BoardRow): List<Cell> = buses(row).mapIndexed { i, bus -> cell(bus, first = i == 0) }

    /** One bus. Only the Next column ([first]), drawn large, carries a unit ("4 min"; Then and After are bare figures, "16", "~28"). */
    fun cell(bus: Bus?, first: Boolean): Cell {
        if (bus?.etaS == null) return NONE
        val guess = bus.quality == "scheduled" || bus.quality == "stale"
        // An older server's "now" for a guess: worded here instead, "~1 min", as the server words it now.
        val words = bus.eta?.takeUnless { guess && DIGITS.find(it) == null } ?: eta(bus.etaS, bus.quality)
        val said = Spoken.eta(bus.etaS, bus.quality, withQuality = first) ?: Spoken.spell(words)
        // "now": no figure to set large; shown as it is.
        val n = DIGITS.find(words) ?: return Cell(words, next = first, said = said)
        return Cell(
            n.value,
            if (guess) "~" else "",
            after = if (first) words.substring(n.range.last + 1) else "",
            next = first,
            said = said,
        )
    }

    /**
     * The whole row as one line: the line, where it's going, then each bus in order: "Bus D2, via PGP, 2 minutes, live, then 14 minutes,
     * then about 26 minutes".
     */
    fun said(row: BoardRow, cells: List<Cell>): String =
        (listOf(L.s(if (row.paid) R.string.a11y_bus_paid else R.string.a11y_bus, row.svc), dest(row).text) +
                cells.mapIndexedNotNull { i, c -> c.said?.let { if (i > 0) L.s(R.string.nearby_then, it) else it } })
            .joinToString(L.s(R.string.clause_sep))

    /** The line under the signs: what a "~" means, only while one is showing. */
    fun foot(cells: List<Cell>): List<String> = listOfNotNull(L.s(R.string.nearby_guess).takeIf { cells.any { it.mark.isNotEmpty() } })
}

/**
 * What gives way on Nearby when the rows are tight, decided by measuring: the gaps between the time columns close up, then the times are
 * drawn a little smaller, to [MIN_SCALE] at most, and failing that every row on screen takes its times, full size, to a second line, so a
 * card never mixes the two. In pixels throughout.
 */
internal object NearbyTight {
    const val MIN_SCALE = 0.85f

    /**
     * Whether every one of [dests] fits [room] beside the times: on two lines at most ([twoLines]), breaking inside a place where it must
     * (its no-break spaces are only a first choice, [NearbyText.Dest.loose]), and never inside a word ([width]). So where it's going alone
     * never stacks the rows.
     */
    fun fits(
        dests: List<NearbyText.Dest>,
        room: Float,
        width: (String) -> Int,
        twoLines: (NearbyText.Dest, Float) -> Boolean,
    ): Boolean =
        room >= 1 &&
            dests.all { d ->
                val loose = d.loose()
                loose.text.split(' ').all { width(it) <= room } && twoLines(loose, room)
            }

    /**
     * [gap] between the time columns, the times at [scale] in columns [cols], and the [room] that leaves each row's destination: beside the
     * times, or with [stacked], the whole line after the badge.
     */
    data class Plan(val gap: Float, val scale: Float, val cols: List<Int>, val room: Float, val stacked: Boolean = false)

    /**
     * [line] is a row's width after its badge, [whole] its width with it (a stacked row's second line); [fits], whether every row's
     * destination fits in a width; [widths], the three columns' widths at a scale; [slack], what the columns take beyond their widths.
     */
    fun plan(
        line: Float,
        whole: Float,
        wide: Float,
        tight: Float,
        slack: Float,
        fits: (Float) -> Boolean,
        widths: (Float) -> List<Int>,
    ): Plan {
        fun left(gap: Float, cols: List<Int>) = line - gap * 3 - slack - cols.sum()
        val full = widths(1f)
        for (gap in listOf(wide, tight)) if (fits(left(gap, full))) return Plan(gap, 1f, full, left(gap, full))
        // Text doesn't shrink quite in proportion (rounding, the unit's own size), so each step is measured again.
        var scale = 1f
        while (scale > MIN_SCALE) {
            scale = (scale - 0.03f).coerceAtLeast(MIN_SCALE)
            val cols = widths(scale)
            if (fits(left(tight, cols))) return Plan(tight, scale, cols, left(tight, cols))
        }
        // Every row stacks, its times at full size on a line of their own, with the wide gaps where that line holds them: smaller only when
        // even the tight gaps leave it too narrow (the largest text sizes on a narrow phone).
        fun over(gap: Float, cols: List<Int>) = whole - gap * 3 - slack - cols.sum() < 0
        if (!over(wide, full)) return Plan(wide, 1f, full, line, stacked = true)
        var stacked = 1f
        var cols = full
        while (over(tight, cols) && stacked > 0.5f) {
            stacked -= 0.03f
            cols = widths(stacked)
        }
        return Plan(tight, stacked, cols, line, stacked = true)
    }
}
