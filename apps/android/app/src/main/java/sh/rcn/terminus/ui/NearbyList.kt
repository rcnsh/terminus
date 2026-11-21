package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
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

internal class NearbyActions(
    val pins: List<String>,
    val pinsKnown: Boolean,
    val pinLimit: Int,
    val onPin: (String) -> Unit,
    val openStop: (String) -> Unit,
    val openLine: (svc: String, stop: String) -> Unit,
)

@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean, act: NearbyActions) {
    if (stops == null) {
        if (loading) NearbySkeleton() else Text(stringResource(R.string.nothing_yet))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BoxWithConstraints {
            val signs = nearbySigns(stops, maxWidth)
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) { for (i in stops.indices) NearbySign(signs, i, act) }
        }
        NearbyText.foot(stops.flatMap { s -> s.board.flatMap(NearbyText::cells) })?.let {
            Text(
                it,
                Modifier.padding(horizontal = 6.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 13.sp,
                lineHeight = 18.sp,
            )
        }
    }
}

internal class NearbySigns(val stops: List<NearbyStop>, val cells: List<List<List<NearbyText.Cell>>>, val grid: NearbyGrid)

@Composable
internal fun NearbySign(
    signs: NearbySigns,
    i: Int,
    act: NearbyActions,
    saysNone: Boolean = false,
    stopped: List<BoardRow> = emptyList(),
    modifier: Modifier = Modifier,
) {
    val s = signs.stops[i]
    val grid = signs.grid
    StopSign(
        s.name,
        modifier,
        plate = Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { act.openStop(s.code) },
        opens = true,
        trailing = {
            s.walkWords?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
            if (act.pinsKnown) PinStar(s.code, act.pins, act.pinLimit, act.onPin, name = s.longName ?: s.name)
        },
    ) {
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        if (!s.available) Text(stringResource(R.string.no_live_data), color = muted, modifier = Modifier.padding(14.dp))
        else if (saysNone && s.board.isEmpty()) {
            Text(stringResource(R.string.buses_none_here), color = muted, modifier = Modifier.padding(14.dp))
            BoardRows(stopped, emptyMap(), dividerFirst = true) { act.openLine(it.svc, s.code) }
        }
        if (s.board.isNotEmpty()) Heads(grid)
        for ((j, row) in s.board.withIndex()) {
            if (j > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            key(row.svc, row.dest ?: row.toText) {
                BoardLine(row, signs.cells[i][j], grid, grid.wholePlace[i][j]) { act.openLine(row.svc, s.code) }
            }
        }
    }
}

@Composable
internal fun nearbySigns(stops: List<NearbyStop>, width: Dp): NearbySigns {
    val cells = remember(stops) { stops.map { s -> s.board.map(NearbyText::cells) } }
    return NearbySigns(stops, cells, nearbyGrid(stops, cells, width))
}

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
        fun widths(scale: Float) =
            (0..2).map { k ->
                maxOf(all.maxOfOrNull { px(timeText(it[k], scale), TIME) } ?: 0, px(AnnotatedString(heads[k]), HEAD))
            }
        with(density) {
            val boards = stops.map { it.board }
            val badge =
                widestBadge(boards.flatten().map { badgeText(it.svc, it.paid) }) { px(AnnotatedString(it), BADGE) }.toDp() + BADGE_PAD
            val inside = (width - 2.dp - 28.dp).toPx()
            val line = inside - (badge + DEST_GAP).toPx()
            val dests = boards.map { b -> b.map { NearbyText.dest(it) } }
            fun lines(text: AnnotatedString, room: Float) =
                measurer.measure(text, DEST, maxLines = 2, constraints = Constraints(maxWidth = room.toInt())).hasVisualOverflow.not()
            fun place(d: NearbyText.Dest) = d.place?.let { px(AnnotatedString(d.text.substring(it), PLACE), DEST) } ?: 0
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
                dests.map { b -> b.map { d -> place(d) <= plan.room && lines(placeText(d.whole()), plan.room) } },
            )
        }
    }
}

@Composable
private fun heads() = listOf(R.string.chip_next, R.string.nearby_then_bus, R.string.nearby_after_bus).map { stringResource(it).uppercase() }

@Composable
private fun Heads(grid: NearbyGrid) {
    Row(Modifier.fillMaxWidth().clearAndSetSemantics {}.padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 2.dp)) {
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

@Composable
internal fun ServiceBadge(label: String, color: Color, width: Dp) {
    Box(Modifier.width(width).heightIn(min = 28.dp).background(color, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
        Text(label, style = BADGE, color = inkOn(color), maxLines = 1, softWrap = false)
    }
}

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

private fun widestBadge(labels: List<String>, px: (String) -> Int): Int = (labels + "D2").maxOf(px)

private fun placeText(d: NearbyText.Dest, ink: Color = Color.Unspecified): AnnotatedString = buildAnnotatedString {
    append(d.text)
    d.place?.let { addStyle(PLACE.copy(color = ink), it.first, it.last + 1) }
}

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

internal fun eta(s: Int?, quality: String) =
    when {
        s == null -> if (quality == "ended") L.s(R.string.eta_ended) else "–"
        quality != "live" -> L.s(R.string.approx, L.s(R.string.n_min, maxOf(1, (s + 30) / 60)))
        s < 45 -> L.s(R.string.now)
        else -> L.s(R.string.n_min, (s + 30) / 60)
    }

@Composable
private fun NearbySkeleton() {
    Skeleton(stringResource(R.string.checking), Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (sign in 0 until 2) {
            val shape = RoundedCornerShape(14.dp)
            Column(
                Modifier.fillMaxWidth()
                    .clip(shape)
                    .background(MaterialTheme.colorScheme.surface)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            ) {
                PlateSkeleton(barFraction(sign + 2))
                SkeletonBoardLines(List(3) { null }, first = sign * 3)
            }
        }
    }
}

@Composable
internal fun PlateSkeleton(name: Float) {
    val c = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(c.secondaryContainer)
            .drawBehind {
                drawLine(c.outlineVariant, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx())
            }
            .padding(start = 14.dp, end = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(R.drawable.ic_bus), contentDescription = null, tint = c.primary, modifier = Modifier.size(16.dp))
        TextBar(TextStyle(fontSize = 15.sp), Modifier.weight(1f), fraction = name)
    }
}

@Composable
internal fun SkeletonBoardLines(services: List<Pair<String, Color>?>, first: Int = 0) {
    val labels = services.mapNotNull { it?.first }
    val badge = if (labels.isEmpty()) 32.dp else badgeWidth(labels)
    Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 2.dp)) {
        Spacer(Modifier.weight(1f))
        for (head in heads()) {
            Spacer(Modifier.width(SKELETON_GAP))
            Text(
                head,
                style = HEAD,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                softWrap = false,
                modifier = Modifier.width(SKELETON_COL),
            )
        }
    }
    for ((j, svc) in services.withIndex()) {
        if (j > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        Row(
            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 14.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (svc != null) ServiceBadge(svc.first, svc.second, badge) else Bar(Modifier.size(badge, 28.dp), RoundedCornerShape(8.dp))
            Spacer(Modifier.width(DEST_GAP))
            TextBar(DEST, Modifier.weight(1f), fraction = barFraction(first + j, 1) + 0.2f)
            for (w in listOf(34.dp, 26.dp, 26.dp)) {
                Spacer(Modifier.width(SKELETON_GAP))
                Box(Modifier.width(SKELETON_COL), contentAlignment = Alignment.CenterEnd) {
                    TextBar(TextStyle(fontSize = 16.sp, lineHeight = 20.sp), width = w)
                }
            }
        }
    }
}

private val SKELETON_COL = 48.dp
private val SKELETON_GAP = 8.dp
