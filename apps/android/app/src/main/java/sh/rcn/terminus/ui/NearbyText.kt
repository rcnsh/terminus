package sh.rcn.terminus.ui

import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken

/**
 * What Nearby's rows show and say, worded here so the JVM tests can check it: where each bus is going, and its three buses (Next, Then,
 * After) read like a stop's board, the first you can catch picked out.
 */
internal object NearbyText {
    /** One of a row's three buses, the row's own or one of its `later`. */
    data class Bus(val etaS: Int?, val quality: String, val eta: String?, val atMs: Long?, val tooSoon: Boolean)

    /**
     * A bus in its column. [figure] is drawn large and [before]/[after] small around it ("4" " min", "下午 " "6:02", "12:04" " PM"), after
     * [mark] ("~" for a guess, in both languages). [pick]: the first bus you can catch, the one drawn largest. [tooSoon]: due before you
     * could walk there, shown whole at one size and struck through. [said] is how a screen reader says it; null with no bus.
     */
    data class Cell(
        val figure: String,
        val mark: String = "",
        val before: String = "",
        val after: String = "",
        val pick: Boolean = false,
        val tooSoon: Boolean = false,
        val said: String? = null,
    ) {
        /** As one string, as a struck-out cell shows it. */
        val text: String
            get() = mark + before + figure + after
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
    // The figures of a clock time in the phone's own style: "18:02", "18.02" (Indonesian, Finnish), any script's digits.
    private val CLOCK_FIGURE = Regex("\\p{Nd}+(?:[:.]\\p{Nd}+)*")

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
        listOf(Bus(row.etaS, row.quality, row.eta, row.atMs, row.tooSoon)) +
            (0..1).map { k -> row.later.getOrNull(k)?.let { Bus(it.etaS, it.quality, it.eta, it.atMs, it.tooSoon) } }

    /** Which of [buses] is the first you can catch: the first with a time that isn't too soon; -1 with none. */
    fun pick(buses: List<Bus?>): Int = buses.indexOfFirst { it?.etaS != null && !it.tooSoon }

    /** A row's three cells, Next, Then, After. [clock] writes a time in the app's 12- or 24-hour style, in Singapore. */
    fun cells(row: BoardRow, asClock: Boolean, clock: (Long) -> String): List<Cell> {
        val buses = buses(row)
        val pick = pick(buses)
        return buses.mapIndexed { i, bus -> cell(bus, buses.getOrNull(i - 1), first = i == 0, pick = i == pick, asClock, clock) }
    }

    /**
     * One bus. Only the Next column ([first]) carries a unit ("4 min"; Then and After are bare figures, "16", "~28"), and in clock time
     * always its AM/PM, which Then and After show only where the day's half changes from the cell before, as a printed timetable does.
     */
    fun cell(bus: Bus?, prev: Bus?, first: Boolean, pick: Boolean, asClock: Boolean, clock: (Long) -> String): Cell {
        if (bus?.etaS == null) return NONE
        val guess = bus.quality == "scheduled" || bus.quality == "stale"
        val mark = if (guess) "~" else ""
        val soon = if (bus.tooSoon) L.s(R.string.nearby_too_soon) else ""
        if (asClock && bus.atMs != null) {
            val whole = clock(bus.atMs).trim()
            val figure = CLOCK_FIGURE.find(whole)?.value ?: whole
            val half = meridiem(whole)
            val sayHalf = half.isNotEmpty() && (first || prev?.atMs == null || meridiem(clock(prev.atMs)) != half)
            // Chinese writes 下午 before the time, English PM after it.
            val before = sayHalf && whole.startsWith(half)
            return Cell(
                figure,
                mark,
                before = if (sayHalf && before) "$half " else "",
                after = if (sayHalf && !before) " $half" else "",
                pick = pick,
                tooSoon = bus.tooSoon,
                // The one to catch says how long it is too, as minutes mode shows it: "12:09 PM, in about 13 minutes".
                said = Spoken.spell(mark + whole).let { if (pick) L.s(R.string.nearby_wait, it, wait(bus)) else it } + soon,
            )
        }
        // An older server's "now" for a guess: worded here instead, "~1 min", as the server words it now.
        val words = bus.eta?.takeUnless { guess && DIGITS.find(it) == null } ?: eta(bus.etaS, bus.quality)
        val said = (Spoken.eta(bus.etaS, bus.quality, withQuality = first) ?: Spoken.spell(words)) + soon
        // "now": no figure to set large; shown as it is.
        val n = DIGITS.find(words) ?: return Cell(words, pick = pick, tooSoon = bus.tooSoon, said = said)
        return Cell(
            n.value,
            mark,
            after = if (first) words.substring(n.range.last + 1) else "",
            pick = pick,
            tooSoon = bus.tooSoon,
            said = said,
        )
    }

    /** How long until [bus], said: "13 minutes", "about 13 minutes" for a guess, never under a minute for one. */
    private fun wait(bus: Bus): String {
        val s = bus.etaS?.toLong() ?: 0
        return if (bus.quality == "live") Spoken.minutes(s) else L.s(R.string.a11y_eta_about, Spoken.minutes(maxOf(s, 60)))
    }

    /** A clock time's words round its figures ("PM", "下午"): none in 24-hour time. */
    private fun meridiem(time: String) = time.replaceFirst(CLOCK_FIGURE, "").trim()

    /**
     * The whole row as one line: the line, where it's going, then each bus in order, the first you can catch said so: "Bus D2, via Kent
     * Ridge MRT, 4 minutes, live, too soon to catch, next you can catch, 14 minutes, then about 26 minutes".
     */
    fun said(row: BoardRow, cells: List<Cell>): String =
        (listOf(L.s(if (row.paid) R.string.a11y_bus_paid else R.string.a11y_bus, row.svc), dest(row).text) +
                cells.mapIndexedNotNull { i, c ->
                    c.said?.let {
                        when {
                            c.pick -> L.s(R.string.nearby_catch, it)
                            i > 0 -> L.s(R.string.nearby_then, it)
                            else -> it
                        }
                    }
                })
            .joinToString(L.s(R.string.clause_sep))

    /**
     * The lines under the signs, as under a stop's board: what a struck-out time and a "~" mean, each only while one is showing, then that
     * a row opens its line.
     */
    fun foot(cells: List<Cell>): List<String> =
        listOfNotNull(
            L.s(R.string.nearby_crossed_out).takeIf { cells.any { it.tooSoon } },
            L.s(R.string.nearby_guess).takeIf { cells.any { it.mark.isNotEmpty() } },
            L.s(R.string.buses_tap_hint),
        )
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
