package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.L
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NearbyTimes
import sh.rcn.terminus.R
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.parseColor
import sh.rcn.terminus.widget.clock

/**
 * What Nearby's taps do: a stop's name opens its board and a row its line, on the Stops tab, where the last row goes too; the star pins the
 * stop there, up to [pinLimit].
 */
internal class NearbyActions(
    val pins: List<String>,
    /** The profile has come, so [pins] are what's pinned: until then, no stars. */
    val pinsKnown: Boolean,
    val pinLimit: Int,
    val onPin: (String) -> Unit,
    val openStop: (String) -> Unit,
    val openLine: (svc: String, stop: String) -> Unit,
    val openStops: () -> Unit,
)

/**
 * The stops near you as their signs: the name plate with the walk there and the star, then a row per service read like a stop's board:
 * where it's going, its next bus and the one after, in minutes or as clock times (the switch above them, kept on this phone). A bus due
 * before you could walk there is struck through. The nearest stop is drawn larger. Under them, the way to the Stops tab, for any other
 * stop.
 */
@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean, act: NearbyActions) {
    if (stops == null) {
        Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.nothing_yet))
        return
    }
    val ctx = LocalContext.current
    val asClock = NearbyTimes.clock(ctx)
    val toClock = { ms: Long -> clock(ctx, ms) }
    // The same columns on every sign and its heads (in sp, so they grow with the text), so the times line up down the page. Clock times
    // ("12:05 PM") need wider ones than minutes.
    val cols =
        with(LocalDensity.current) {
            NearbyCols(54.sp.toDp(), (if (asClock) 78.sp else 70.sp).toDp(), (if (asClock) 70.sp else 61.sp).toDp())
        }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Segmented(
            listOf(stringResource(R.string.nearby_in_minutes), stringResource(R.string.nearby_clock_time)),
            if (asClock) 1 else 0,
            label = stringResource(R.string.nearby_show_times),
        ) {
            NearbyTimes.set(ctx, it == 1)
        }
        for ((i, s) in stops.withIndex()) {
            val big = i == 0
            // The plate opens the stop's whole board, as the Stops tab has it; each row its service's line from here.
            StopSign(
                s.name,
                big = big,
                plate =
                    Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { act.openStop(s.code) },
                trailing = {
                    Text(
                        if (s.walkS < 60) stringResource(R.string.here) else stringResource(R.string.min_walk, (s.walkS + 30) / 60),
                        style = MaterialTheme.typography.labelLarge,
                    )
                    if (act.pinsKnown) PinStar(s.code, act.pins, act.pinLimit, act.onPin, name = s.longName ?: s.name)
                },
            ) {
                if (!s.available)
                    Text(
                        stringResource(R.string.no_live_data),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(14.dp),
                    )
                if (s.board.isNotEmpty()) Heads(cols)
                for ((j, row) in s.board.withIndex()) {
                    if (j > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    BoardLine(row, big, asClock, toClock, cols) { act.openLine(row.svc, s.code) }
                }
            }
        }
        ToStops(act.openStops)
    }
}

/** The widths of Nearby's columns: the service, then its next bus and the one after; where it's going takes the rest. */
private class NearbyCols(val svc: Dp, val next: Dp, val then: Dp)

/** Over a sign's rows: "Next bus" and "Then" over their columns. The rows say it all to a screen reader. */
@Composable
private fun Heads(cols: NearbyCols) {
    val style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.06.em, textAlign = TextAlign.End)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth().clearAndSetSemantics {}.padding(start = 14.dp, end = 14.dp, top = 7.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Spacer(Modifier.width(cols.svc))
        Spacer(Modifier.weight(1f))
        Text(
            stringResource(R.string.nearby_next_bus).uppercase(),
            style = style,
            color = muted,
            maxLines = 1,
            modifier = Modifier.width(cols.next),
        )
        Text(
            stringResource(R.string.nearby_then_bus).uppercase(),
            style = style,
            color = muted,
            maxLines = 1,
            modifier = Modifier.width(cols.then),
        )
    }
}

/**
 * A service's row: its badge, where it's going, its next bus and the one after. A public bus has no line page: /api/line is the shuttles'.
 */
@Composable
private fun BoardLine(row: BoardRow, big: Boolean, asClock: Boolean, clock: (Long) -> String, cols: NearbyCols, onOpen: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val color = row.color?.let(::parseColor) ?: 0xFF8A939C
    val next = NearbyText.next(row, asClock, clock)
    val then = NearbyText.then(row, asClock, clock)
    // One line to a screen reader: "Bus D2, to COM 3, 4 minutes, live, then 14 minutes".
    val said = NearbyText.said(row, next, then)
    val open =
        if (row.paid) Modifier
        else Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_line, row.svc), onClick = onOpen)
    Row(
        Modifier.fillMaxWidth()
            .then(open)
            .clearAndSetSemantics { contentDescription = said }
            .padding(horizontal = 14.dp, vertical = if (big) 10.dp else 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.width(cols.svc)) { BusBadge(row.svc, color, if (big) 13.sp else 12.sp, paid = row.paid) }
        // Two lines at most, so a long name (Prince George's Park) is read whole, not cut.
        Text(
            NearbyText.to(row),
            color = c.onSurfaceVariant,
            fontSize = 13.sp,
            lineHeight = 16.sp,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Time(next, if (big) 18.sp else 15.sp, FontWeight.ExtraBold, c.onSurface, Modifier.width(cols.next))
        Time(then, 14.sp, FontWeight.SemiBold, c.onSurfaceVariant, Modifier.width(cols.then))
    }
}

/** A bus's time in its column, shrunk to fit rather than cut. Too soon to catch: shown, so the board is whole, but struck through. */
@Composable
private fun Time(t: NearbyText.Time, size: TextUnit, weight: FontWeight, color: Color, modifier: Modifier) {
    Text(
        t.text,
        color = if (t.tooSoon) MaterialTheme.colorScheme.outline else color,
        fontWeight = weight,
        textAlign = TextAlign.End,
        textDecoration = if (t.tooSoon) TextDecoration.LineThrough else null,
        maxLines = 1,
        softWrap = false,
        autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = size, stepSize = 0.5.sp),
        modifier = modifier,
    )
}

/** What Nearby's rows show and say, worded here so the JVM tests can check it. */
internal object NearbyText {
    /** A bus in a column: [text] as shown, [said] as a screen reader says it (null with no bus), and whether it's [tooSoon] to catch. */
    data class Time(val text: String, val said: String?, val tooSoon: Boolean = false)

    private val none = Time("–", null)

    /** Where the bus is going, "to Kent Ridge MRT", or the server's "Ends here" when this is the end of its line. */
    fun to(row: BoardRow): String =
        row.towards.lastOrNull()?.let { L.s(R.string.nearby_to, it) } ?: row.toText ?: L.s(R.string.buses_ends_here)

    /** The next bus: the server's "4 min", or with [asClock] its clock time ("~" for a guess); "–" with none. */
    fun next(row: BoardRow, asClock: Boolean, clock: (Long) -> String): Time =
        time(row.etaS, row.quality, row.eta, row.atMs, row.tooSoon, asClock, clock, withQuality = true)

    /** The bus after it, worded the same; "–" with none. */
    fun then(row: BoardRow, asClock: Boolean, clock: (Long) -> String): Time =
        row.later.firstOrNull()?.let { time(it.etaS, it.quality, it.eta, it.atMs, it.tooSoon, asClock, clock, withQuality = false) } ?: none

    /** The whole row as one line: "Bus D2, to COM 3, 4 minutes, live, then 14 minutes". */
    fun said(row: BoardRow, next: Time, then: Time): String =
        listOfNotNull(
                L.s(if (row.paid) R.string.a11y_bus_paid else R.string.a11y_bus, row.svc),
                to(row),
                next.said,
                then.said?.let { L.s(R.string.nearby_then, it) },
            )
            .joinToString(L.s(R.string.clause_sep))

    private fun time(
        etaS: Int?,
        quality: String,
        words: String?,
        atMs: Long?,
        tooSoon: Boolean,
        asClock: Boolean,
        clock: (Long) -> String,
        withQuality: Boolean,
    ): Time {
        if (etaS == null) return none
        val text =
            if (asClock && atMs != null)
                clock(atMs).let { if (quality == "scheduled" || quality == "stale") L.s(R.string.approx, it) else it }
            else words ?: eta(etaS, quality)
        val said =
            (if (asClock && atMs != null) Spoken.spell(text) else Spoken.eta(etaS, quality, withQuality) ?: Spoken.spell(text)) +
                if (tooSoon) L.s(R.string.nearby_too_soon) else ""
        return Time(text, said, tooSoon)
    }
}

/** Under the last sign: any other stop, or a service's whole line, is on the Stops tab. */
@Composable
private fun ToStops(onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(16.dp)
    Row(
        Modifier.fillMaxWidth()
            .clip(shape)
            .background(c.surface)
            .border(1.dp, c.outlineVariant, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(painterResource(R.drawable.ic_tab_buses), contentDescription = null, tint = c.primary, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.nearby_more_title), fontWeight = FontWeight.SemiBold)
            Text(stringResource(R.string.nearby_more_text), style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
        }
        Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = c.onSurfaceVariant, modifier = Modifier.size(20.dp))
    }
}

/**
 * The local wording, for the widget's own countdown: anything but a live time keeps its "~", as the server's `eta` does; worked out here
 * for an older server.
 */
internal fun eta(s: Int?, quality: String) =
    when {
        s == null -> if (quality == "ended") L.s(R.string.eta_ended) else "–"
        s < 45 -> L.s(R.string.now)
        quality != "live" -> L.s(R.string.approx, L.s(R.string.n_min, (s + 30) / 60))
        else -> L.s(R.string.n_min, (s + 30) / 60)
    }
