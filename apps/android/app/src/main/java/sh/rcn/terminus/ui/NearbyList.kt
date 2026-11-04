package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.R
import sh.rcn.terminus.parseColor

/**
 * What Nearby's taps do: a stop's name opens its board and a row its line, on the Stops tab; the star pins the stop there, up to
 * [pinLimit].
 */
internal class NearbyActions(
    val pins: List<String>,
    /** The profile has come, so [pins] are what's pinned: until then, no stars. */
    val pinsKnown: Boolean,
    val pinLimit: Int,
    val onPin: (String) -> Unit,
    val openStop: (String) -> Unit,
    val openLine: (svc: String, stop: String) -> Unit,
)

/**
 * The stops near you as their signs: the name plate with the walk there and the star, then a row per service read like a stop's board:
 * where it's going and its next three buses (Next, Then, After), in minutes. The next bus is drawn large. Under them, what a "~" means.
 */
@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean, act: NearbyActions) {
    if (stops == null) {
        Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.nothing_yet))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BoxWithConstraints {
            val signs = nearbySigns(stops, maxWidth)
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { for (i in stops.indices) NearbySign(signs, i, act) }
        }
        Column(Modifier.padding(horizontal = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            for (line in NearbyText.foot(stops.flatMap { s -> s.board.flatMap(NearbyText::cells) })) Text(
                line,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
        }
    }
}

/**
 * Stops drawn as Nearby's signs, one at a time where they're laid out ([NearbySign]), in the same columns ([NearbyGrid]): Nearby's list,
 * and the Stops tab's pinned stops, a page each.
 */
internal class NearbySigns(val stops: List<NearbyStop>, val cells: List<List<List<NearbyText.Cell>>>, val grid: NearbyGrid)

/**
 * Stop [i] of [signs] as its sign: the plate with the walk there and the star, then its rows. [saysNone]: with no rows, says no buses are
 * running there (a pinned stop's page, which is there whatever the hour); Nearby's own signs leave it bare.
 */
@Composable
internal fun NearbySign(signs: NearbySigns, i: Int, act: NearbyActions, saysNone: Boolean = false) {
    val s = signs.stops[i]
    val grid = signs.grid
    // The plate opens the stop's whole board, as the Stops tab has it; each row its service's line from here.
    StopSign(
        s.name,
        plate = Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { act.openStop(s.code) },
        opens = true,
        trailing = {
            // Without a location (a pinned stop), no walk.
            s.walkWords?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
            if (act.pinsKnown) PinStar(s.code, act.pins, act.pinLimit, act.onPin, name = s.longName ?: s.name)
        },
    ) {
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        if (!s.available) Text(stringResource(R.string.no_live_data), color = muted, modifier = Modifier.padding(14.dp))
        else if (saysNone && s.board.isEmpty())
            Text(stringResource(R.string.buses_none_here), color = muted, modifier = Modifier.padding(14.dp))
        if (s.board.isNotEmpty()) Heads(grid)
        for ((j, row) in s.board.withIndex()) {
            if (j > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            // Keyed by its service, so a screen reader's focus stays on the D1 as the rows reorder on a refresh,
            // rather than on whichever service moves into its place.
            key(row.svc, row.dest ?: row.toText) {
                BoardLine(row, signs.cells[i][j], grid, grid.wholePlace[i][j]) { act.openLine(row.svc, s.code) }
            }
        }
    }
}

/** [stops] as signs [width] wide, their columns measured together. */
@Composable
internal fun nearbySigns(stops: List<NearbyStop>, width: Dp): NearbySigns {
    val cells = remember(stops) { stops.map { s -> s.board.map(NearbyText::cells) } }
    return NearbySigns(stops, cells, nearbyGrid(stops, cells, width))
}

/**
 * Nearby's columns, the same on every sign and its heads so the figures line up down the page: every badge as wide as the widest on screen
 * ("188e \$"), each time column as wide as its widest time or its head. Where a row would leave where-it's-going too little room for two
 * lines (a small screen, large text), the columns close up ([gap]), then the times are drawn a little smaller ([scale], to 0.85), and
 * failing that every row's times go full size on a second line under its badge ([stacked]), in the same columns (smaller only when that
 * line is too narrow for them). [wholePlace]: each row's place kept on one line, where it fits there.
 */
internal class NearbyGrid(
    val badge: Dp,
    val cols: List<Dp>,
    val gap: Dp,
    val scale: Float,
    val stacked: Boolean,
    val wholePlace: List<List<Boolean>>,
)

private val BADGE = TextStyle(fontSize = 14.5.sp, lineHeight = 18.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center)
private val HEAD = TextStyle(fontSize = 10.5.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.06.em, textAlign = TextAlign.End)
private val TIME = TextStyle(fontFeatureSettings = "tnum", textAlign = TextAlign.End)
private val DEST = TextStyle(fontSize = 14.5.sp, lineHeight = 18.sp)
private val PLACE = SpanStyle(fontWeight = FontWeight.SemiBold)
private val BADGE_PAD = 12.dp
private val DEST_GAP = 8.dp
private val COL_GAP = 14.dp
private val COL_GAP_TIGHT = 8.dp

@Composable
private fun nearbyGrid(stops: List<NearbyStop>, cells: List<List<List<NearbyText.Cell>>>, width: Dp): NearbyGrid {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val heads = heads()
    return remember(stops, cells, width, density, heads) {
        fun px(text: AnnotatedString, style: TextStyle) = measurer.measure(text, style, softWrap = false, maxLines = 1).size.width
        val all = cells.flatten()
        // Each column as wide as its widest time at [scale], or its head, which keeps its size.
        fun widths(scale: Float) =
            (0..2).map { k ->
                maxOf(all.maxOfOrNull { px(timeText(it[k], scale), TIME) } ?: 0, px(AnnotatedString(heads[k]), HEAD))
            }
        with(density) {
            val boards = stops.map { it.board }
            val badge =
                widestBadge(boards.flatten().map { badgeText(it.svc, it.paid) }) { px(AnnotatedString(it), BADGE) }.toDp() + BADGE_PAD
            // Inside the sign's hairline and the row's padding; where it's going has what the badge and the times leave.
            val inside = (width - 2.dp - 28.dp).toPx()
            val line = inside - (badge + DEST_GAP).toPx()
            // Where it's going takes two lines at most beside the times, breaking inside a place only when it must, and never inside a
            // word.
            val dests = boards.map { b -> b.map { NearbyText.dest(it) } }
            fun lines(text: AnnotatedString, room: Float) =
                measurer.measure(text, DEST, maxLines = 2, constraints = Constraints(maxWidth = room.toInt())).hasVisualOverflow.not()
            fun place(d: NearbyText.Dest) = d.place?.let { px(AnnotatedString(d.text.substring(it), PLACE), DEST) } ?: 0
            // A word at the place's weight, the wider, so a place's word is never under-measured.
            val words = HashMap<String, Int>()
            fun word(w: String) = words.getOrPut(w) { px(AnnotatedString(w, PLACE), DEST) }
            fun fits(room: Float) = NearbyTight.fits(dests.flatten(), room, ::word) { d, r -> lines(placeText(d), r) }
            val plan = NearbyTight.plan(line, inside, COL_GAP.toPx(), COL_GAP_TIGHT.toPx(), slack = 3.dp.toPx(), ::fits, ::widths)
            NearbyGrid(
                badge,
                plan.cols.map { it.toDp() + 1.dp },
                plan.gap.toDp(),
                plan.scale,
                plan.stacked,
                // The place kept whole on a line of its own where it fits there and the whole still takes two lines.
                dests.map { b -> b.map { d -> place(d) <= plan.room && lines(placeText(d.whole()), plan.room) } },
            )
        }
    }
}

@Composable
private fun heads() = listOf(R.string.chip_next, R.string.nearby_then_bus, R.string.nearby_after_bus).map { stringResource(it).uppercase() }

/** Over a sign's rows: Next, Then and After over their columns. The rows say it all to a screen reader. */
@Composable
private fun Heads(grid: NearbyGrid) {
    Row(Modifier.fillMaxWidth().clearAndSetSemantics {}.padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 2.dp)) {
        // Over the badge and where it's going.
        Spacer(Modifier.weight(1f))
        for ((k, head) in heads().withIndex()) {
            Spacer(Modifier.width(grid.gap))
            Text(
                head,
                style = HEAD,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.width(grid.cols[k]),
            )
        }
    }
}

/**
 * A service's row: its badge, where it's going, its next three buses; with the grid stacked, the buses on a second line in the same
 * columns. One element to a screen reader either way. A public bus has no line page: /api/line is the shuttles'.
 */
@Composable
private fun BoardLine(
    row: BoardRow,
    cells: List<NearbyText.Cell>,
    grid: NearbyGrid,
    wholePlace: Boolean,
    onOpen: () -> Unit,
) {
    val c = MaterialTheme.colorScheme
    val color = Color(row.color?.let(::parseColor) ?: 0xFF8A939C)
    val said = NearbyText.said(row, cells)
    val open =
        if (row.paid) Modifier
        else Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_line, row.svc), onClick = onOpen)
    val badge: @Composable () -> Unit = {
        ServiceBadge(badgeText(row.svc, row.paid), color, grid.badge)
        Spacer(Modifier.width(DEST_GAP))
    }
    // Two lines at most, the place whole on the second when it fits there, so "to" or "via" wraps alone; otherwise free to break inside it.
    val dest: @Composable RowScope.() -> Unit = {
        Text(
            placeText(NearbyText.dest(row).let { if (wholePlace) it.whole() else it.loose() }, ink = c.onSurface),
            style = DEST,
            color = c.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
    val times: @Composable RowScope.() -> Unit = {
        for ((k, cell) in cells.withIndex()) {
            Spacer(Modifier.width(grid.gap))
            Text(
                timeText(cell, grid.scale, ink = c.onSurface, muted = c.onSurfaceVariant),
                style = TIME,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.width(grid.cols[k]),
            )
        }
    }
    val whole = Modifier.fillMaxWidth().then(open).clearAndSetSemantics { contentDescription = said }
    if (grid.stacked)
        Column(whole.padding(horizontal = 14.dp, vertical = 6.dp)) {
            Row(Modifier.heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                badge()
                dest()
            }
            Row(Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Spacer(Modifier.weight(1f))
                times()
            }
        }
    else
        Row(whole.heightIn(min = 52.dp).padding(horizontal = 14.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            badge()
            dest()
            times()
        }
}

/** A service's badge, [width] wide (every badge in a list as wide as the widest, [badgeWidth]), in its colour. */
@Composable
internal fun ServiceBadge(label: String, color: Color, width: Dp) {
    Box(Modifier.width(width).heightIn(min = 28.dp).background(color, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        Text(label, style = BADGE, color = inkOn(color), maxLines = 1, softWrap = false)
    }
}

/** The width a list's badges share: the widest of [labels], with its padding. */
@Composable
internal fun badgeWidth(labels: List<String>): Dp {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    return remember(labels, density) {
        with(density) {
            widestBadge(labels) { measurer.measure(AnnotatedString(it), BADGE, softWrap = false, maxLines = 1).size.width }.toDp() +
                BADGE_PAD
        }
    }
}

/** The widest of [labels] in pixels ([px]), and a two-character line's ("D2") at least, so a one-letter K isn't a dot. */
private fun widestBadge(labels: List<String>, px: (String) -> Int): Int = (labels + "D2").maxOf(px)

/** Where a row's bus is going, its place in ink and semibold, the words round it ("to", "via") left in the text's own colour. */
private fun placeText(d: NearbyText.Dest, ink: Color = Color.Unspecified): AnnotatedString = buildAnnotatedString {
    append(d.text)
    d.place?.let { addStyle(PLACE.copy(color = ink), it.first, it.last + 1) }
}

/** A bus's time as its column draws it: the figure in the board's weight, its unit small, the next large and in ink. */
private fun timeText(
    cell: NearbyText.Cell,
    scale: Float,
    ink: Color = Color.Unspecified,
    muted: Color = Color.Unspecified,
): AnnotatedString {
    fun size(sp: Float) = (sp * scale).sp
    val big = size(if (cell.next) 21.5f else 16f)
    val small = SpanStyle(fontSize = size(11f), fontWeight = FontWeight.Medium, letterSpacing = 0.sp)
    return buildAnnotatedString {
        val figures =
            SpanStyle(
                color = if (cell.next) ink else muted,
                fontSize = big,
                fontWeight = if (cell.next) FontWeight.Bold else FontWeight.SemiBold,
                letterSpacing = if (cell.next) (-0.02).em else (-0.01).em,
            )
        withStyle(figures) {
            append(cell.mark)
            append(cell.figure)
            if (cell.after.isNotEmpty()) withStyle(small) { append(cell.after) }
        }
    }
}

/**
 * The local wording, for the widget's own countdown and Nearby with an older server: anything but a live time keeps its "~", as the
 * server's `eta` does, and is never "now", which would pass for a bus at the stop: under a minute it's "~1 min".
 */
internal fun eta(s: Int?, quality: String) =
    when {
        s == null -> if (quality == "ended") L.s(R.string.eta_ended) else "–"
        quality != "live" -> L.s(R.string.approx, L.s(R.string.n_min, maxOf(1, (s + 30) / 60)))
        s < 45 -> L.s(R.string.now)
        else -> L.s(R.string.n_min, (s + 30) / 60)
    }
