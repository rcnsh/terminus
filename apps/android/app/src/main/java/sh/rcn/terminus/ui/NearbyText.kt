package sh.rcn.terminus.ui

import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken

internal object NearbyText {
    data class Bus(val etaS: Int?, val quality: String, val eta: String?)

    data class Cell(
        val figure: String,
        val mark: String = "",
        val after: String = "",
        val next: Boolean = false,
        val said: String? = null,
    ) {
        val text: String
            get() = mark + figure + after
    }

    data class Dest(val text: String, val place: IntRange? = null) {
        fun whole(): Dest = place?.let { copy(text = text.replaceRange(it, text.substring(it).replace(' ', '\u00a0'))) } ?: this

        fun loose(): Dest = copy(text = text.replace('\u00a0', ' '))
    }

    private val NONE = Cell("–")
    private val DIGITS = Regex("\\d+")

    fun dest(row: BoardRow): Dest {
        val words =
            row.dest
                ?: return Dest(row.towards.lastOrNull()?.let { L.s(R.string.nearby_to, it) } ?: row.toText ?: L.s(R.string.buses_ends_here))
        val at = row.destPlace?.let { words.indexOf(it) } ?: -1
        return if (at < 0) Dest(words) else Dest(words, at until at + row.destPlace!!.length)
    }

    fun buses(row: BoardRow): List<Bus?> =
        listOf(Bus(row.etaS, row.quality, row.eta)) + (0..1).map { k -> row.later.getOrNull(k)?.let { Bus(it.etaS, it.quality, it.eta) } }

    fun cells(row: BoardRow): List<Cell> = buses(row).mapIndexed { i, bus -> cell(bus, first = i == 0) }

    fun cell(bus: Bus?, first: Boolean): Cell {
        if (bus?.etaS == null) return NONE
        val guess = bus.quality == "scheduled" || bus.quality == "stale"
        val words = bus.eta?.takeUnless { guess && DIGITS.find(it) == null } ?: eta(bus.etaS, bus.quality)
        val said = Spoken.eta(bus.etaS, bus.quality, withQuality = first) ?: Spoken.spell(words)
        val n = DIGITS.find(words) ?: return Cell(words, next = first, said = said)
        return Cell(
            n.value,
            if (guess) "~" else "",
            after = if (first) words.substring(n.range.last + 1) else "",
            next = first,
            said = said,
        )
    }

    fun said(row: BoardRow, cells: List<Cell>): String =
        (listOf(L.s(if (row.paid) R.string.a11y_bus_paid else R.string.a11y_bus, row.svc), dest(row).text) +
                cells.mapIndexedNotNull { i, c -> c.said?.let { if (i > 0) L.s(R.string.nearby_then, it) else it } })
            .joinToString(L.s(R.string.clause_sep))

    fun foot(cells: List<Cell>): String? = L.s(R.string.nearby_guess).takeIf { cells.any { it.mark.isNotEmpty() } }
}

internal object NearbyTight {
    const val MIN_SCALE = 0.85f

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

    data class Plan(val gap: Float, val scale: Float, val cols: List<Int>, val room: Float, val stacked: Boolean = false)

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
        var scale = 1f
        while (scale > MIN_SCALE) {
            scale = (scale - 0.03f).coerceAtLeast(MIN_SCALE)
            val cols = widths(scale)
            if (fits(left(tight, cols))) return Plan(tight, scale, cols, left(tight, cols))
        }
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
