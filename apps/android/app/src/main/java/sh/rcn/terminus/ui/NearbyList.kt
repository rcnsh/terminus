package sh.rcn.terminus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.parseColor

/**
 * The stops near you as their signs: the name plate with the walk there,
 * then a row per service, its buses coming up a short road towards the
 * stop, nearer the sooner they're due, the next one solid and the rest
 * faded. The nearest stop is drawn larger. A timetable guess is an outline,
 * never a filled bus, so it doesn't pass for live.
 */
@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean, onOpenStop: (String) -> Unit) {
    if (stops == null) {
        Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.nothing_yet))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for ((i, s) in stops.withIndex()) {
            val big = i == 0
            // The sign opens its stop on the map, with its services and what's coming.
            StopSign(
                s.name,
                Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.on_the_map, s.name)) { onOpenStop(s.code) },
                big = big,
                trailing = {
                    Text(if (s.walkS < 60) stringResource(R.string.here) else stringResource(R.string.min_walk, (s.walkS + 30) / 60), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(end = 6.dp))
                },
            ) {
                if (!s.available) Text(stringResource(R.string.no_live_data), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(14.dp))
                for ((j, row) in s.board.withIndex()) {
                    if (j > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    val color = row.color?.let(::parseColor) ?: 0xFF8A939C
                    // One line to a screen reader: "Bus D2, about 6 minutes, timetable",
                    // where the screen has the badge, an outlined bus and "~6 min".
                    val said = listOfNotNull(
                        stringResource(if (row.paid) R.string.a11y_bus_paid else R.string.a11y_bus, row.svc),
                        Spoken.eta(row.etaS, row.quality) ?: Spoken.spell(row.eta ?: eta(row.etaS, row.quality)),
                    ).joinToString(", ")
                    Row(
                        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = said }.padding(horizontal = 14.dp, vertical = if (big) 10.dp else 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        // A fixed column, so every road starts at the same place.
                        Box(Modifier.width(if (row.paid) 52.dp else 34.dp)) { BusBadge(row.svc, color, if (big) 13.sp else 12.sp, paid = row.paid) }
                        Road(row, Color(color), Modifier.weight(1f).height(18.dp))
                        Text(
                            row.eta ?: eta(row.etaS, row.quality),
                            fontSize = if (big) 18.sp else 15.sp,
                            fontWeight = FontWeight.ExtraBold,
                            textAlign = TextAlign.End,
                            maxLines = 1,
                            modifier = Modifier.widthIn(min = 56.dp),
                        )
                    }
                }
            }
        }
    }
}

/** How far up the road a bus is drawn: this many seconds away is the far end. */
private const val ROAD_S = 15 * 60

/** How visible a bus after the next one is: there, but not the one to catch. */
private const val LATER_ALPHA = 0.35f

/**
 * A short road to the stop (the ring at its end), and the buses on it: filled
 * in their colour when the time is live, an outline when it's a timetable
 * guess. The next one is solid and drawn last, on top; the ones after it, faded.
 */
@Composable
private fun Road(row: BoardRow, color: Color, modifier: Modifier) {
    val road = MaterialTheme.colorScheme.outlineVariant
    val stop = MaterialTheme.colorScheme.onSurface
    val paper = MaterialTheme.colorScheme.surface
    Canvas(modifier) {
        val y = size.height / 2
        val ring = 5.dp.toPx()
        val end = size.width - ring - 1.dp.toPx()
        drawLine(road, Offset(0f, y), Offset(end, y), 2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx())))
        drawCircle(paper, ring, Offset(end, y))
        drawCircle(stop, ring, Offset(end, y), style = Stroke(2.5.dp.toPx()))
        val w = 18.dp.toPx()
        val h = 12.dp.toPx()
        fun bus(etaS: Int, live: Boolean, alpha: Float) {
            val far = (etaS.coerceIn(0, ROAD_S).toFloat() / ROAD_S)
            val x = (end - ring - w - 2.dp.toPx()) * (1 - far)
            val at = Offset(x, y - h / 2)
            if (live) drawRoundRect(color, at, Size(w, h), CornerRadius(4.dp.toPx()), alpha = alpha)
            else drawRoundRect(color, at, Size(w, h), CornerRadius(4.dp.toPx()), alpha = alpha, style = Stroke(2.dp.toPx()))
        }
        for (b in row.later.asReversed()) bus(b.etaS, b.quality == "live", LATER_ALPHA)
        row.etaS?.let { bus(it, row.quality == "live", 1f) }
    }
}

/** A row's time worded here, for an older server that doesn't send `eta`. */
/** The local wording, for an older server and the widget's own countdown: a timetable guess keeps its "~", as the server's `eta` does. */
internal fun eta(s: Int?, quality: String) = when {
    s == null -> if (quality == "ended") L.s(R.string.eta_ended) else "–"
    s < 45 -> L.s(R.string.now)
    quality == "scheduled" -> L.s(R.string.approx, L.s(R.string.n_min, (s + 30) / 60))
    else -> L.s(R.string.n_min, (s + 30) / 60)
}
