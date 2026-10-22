package sh.rcn.terminus.widget

import android.content.Context
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NewToNus
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.hour12
import sh.rcn.terminus.ui.Road

/** What a Nearby widget draws from: the board as last fetched, in the order shown, and how old it is. */
internal class NearbyView(
    val paired: Boolean,
    /** As shown: the opposite stop first after a swap. Null before any board, or one that can't be read. */
    val stops: List<NearbyStop>?,
    /** In the API's order, for the swap button. */
    val all: List<NearbyStop>?,
    val swap: NearbySwap.Swap?,
    /** When the board was fetched, on the phone's clock. */
    val fetchedAt: Long?,
    /** The last fetch's problem, or [UPDATING]. */
    val error: String?,
    /** Which page of services the pager is on. */
    val page: Int = 0,
) {
    val first: NearbyStop?
        get() = stops?.firstOrNull()

    /**
     * Past [WidgetModes.NEARBY_OLD_MS]: the times are dimmed and the line above says so. First buses ([StopBus.first]) are a timetable's,
     * so they don't go old.
     */
    fun old(now: Long): Boolean = (fetchedAt == null || now - fetchedAt > WidgetModes.NEARBY_OLD_MS) && buses(now).any { !it.first }

    fun buses(now: Long): List<StopBus> = first?.let { busesAt(it, now) }.orEmpty()

    /** [stop]'s buses, as [buses] gives the first's. */
    fun busesAt(stop: NearbyStop, now: Long): List<StopBus> = NearbyBoard.buses(stop, fetchedAt ?: 0L, now, ServerClock.skewMs)

    companion object {
        /** [stopsInApiOrder] ordered for [swap], as it's shown. */
        fun of(
            paired: Boolean,
            stopsInApiOrder: List<NearbyStop>?,
            swap: NearbySwap.Swap?,
            fetchedAt: Long?,
            error: String?,
            page: Int,
            now: Long,
        ) = NearbyView(paired, stopsInApiOrder?.let { NearbySwap.order(it, swap, now) }, stopsInApiOrder, swap, fetchedAt, error, page)
    }
}

/** What a Nearby widget's buttons do; null for one it doesn't have. */
internal class NearbyControls(
    val refresh: Action?,
    /** The pager's arrows, by which way they go (-1, 1). */
    val page: ((Int) -> Action)?,
    val chips: List<Mode> = emptyList(),
    val showing: Mode = Mode.Nearby,
    val chipAction: (Mode) -> Action = { error("no chips") },
)

private val PAD = 14.dp

/** The sky over the buses: the line above (Now, the walk, ↻) and the stop's name; with the chips, their row too. */
private const val SKY_DP = 72f
private const val CHIPS_SKY_DP = 94f

/**
 * Nearby, at any size ([NearbyFit]): the nearest stop's services, each with its badge, the time it's due as a clock time, its next stop,
 * the buses after it, Live and how full. The sky carries the stop's name and "Now 9:41", which ticks by itself, so the times needn't be
 * counted down.
 */
@Composable
internal fun NearbyLayout(look: WidgetLook, w: Float, h: Float, v: NearbyView, c: NearbyControls) {
    val now = System.currentTimeMillis()
    val chipsOnTop = c.chips.isNotEmpty()
    val newcomer = NewToNus.on(LocalContext.current)
    // Both sides of the road where there's a stop beside yours and room for them, under a slimmer sky.
    val beside = v.stops?.let { NearbyBoard.beside(it) { st -> v.busesAt(st, now) } }
    val sidesSky = if (chipsOnTop) CHIPS_SKY_DP else NearbyFit.SIDES_SKY_DP
    val sides = beside?.let { NearbyFit.sides(w, h, sidesSky, newcomer) }
    val skyH = if (sides != null) sidesSky else if (chipsOnTop) CHIPS_SKY_DP else SKY_DP
    val fit = sides ?: NearbyFit.of(w, h, skyH)
    when (fit.kind) {
        NearbyFit.Kind.MINI -> NearbyMini(look, v, now)
        NearbyFit.Kind.BAR -> NearbyBar(look, v, now, c)
        else -> NearbySky(look, w, h, skyH, fit, v, c, now, beside.takeIf { sides != null }, newcomer)
    }
}

/** The words a Nearby widget shows instead of buses; null when there are buses to show. */
private fun problem(v: NearbyView, buses: List<StopBus>): String? {
    val first = v.first
    return when {
        !v.paired -> L.s(R.string.tap_to_pair)
        v.error == UPDATING && (first == null || buses.isEmpty()) -> L.s(R.string.checking)
        v.stops == null -> v.error ?: L.s(R.string.nearby_tap_refresh)
        first == null -> v.error ?: L.s(R.string.no_stops_near)
        buses.isEmpty() -> if (first.available) L.s(R.string.no_buses_due) else L.s(R.string.no_live_data)
        else -> null
    }
}

/** The stop's name, or what to call the widget before there is one. */
private fun title(v: NearbyView): String =
    when {
        !v.paired -> "terminus"
        else -> v.first?.let { it.longName ?: it.name } ?: L.s(R.string.chip_nearby)
    }

/** 2×1: the next bus at the nearest stop and its next stop, under the stop's name and the time now. */
@Composable
private fun NearbyMini(look: WidgetLook, v: NearbyView, now: Long) {
    val ink = look.ground
    val buses = v.buses(now)
    val old = v.old(now)
    Column(GlanceModifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(GlanceModifier.defaultWeight()) { Small(title(v), if (old && buses.isNotEmpty()) ink.late else ink.muted, 11.sp) }
            if (!old && buses.isNotEmpty()) Box(GlanceModifier.padding(start = 6.dp)) { NowClock(ink.muted, ink.muted, 11f, label = false) }
        }
        val b = buses.firstOrNull()
        if (b == null) {
            Small(problem(v, buses).orEmpty(), ink.ink, 12.sp, lines = 2, modifier = GlanceModifier.padding(top = 2.dp))
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Badge(b.svc, b.color, b.paid)
            Spacer(GlanceModifier.width(7.dp))
            TimeText(b, ink, old, 20.sp)
        }
        if (b.first) Small(firstLabel(b), ink.muted, 11.sp) else Small(nextLine(b, buses.take(1)), ink.ink, 11.sp)
    }
}

/** 4×1: the bar split down the middle, the next two services side by side, and ↻. */
@Composable
private fun NearbyBar(look: WidgetLook, v: NearbyView, now: Long, c: NearbyControls) {
    val ink = look.ground
    val buses = v.buses(now)
    val old = v.old(now)
    Row(GlanceModifier.fillMaxSize().padding(start = 4.dp, end = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        val shown = buses.take(2)
        if (shown.isEmpty()) {
            Column(GlanceModifier.defaultWeight().padding(horizontal = 8.dp)) {
                Small(title(v), ink.muted, 11.sp)
                Small(problem(v, buses).orEmpty(), ink.ink, 13.sp, lines = 2)
            }
        } else {
            shown.forEachIndexed { i, b ->
                if (i > 0) VRule(ink, 12.dp)
                Column(GlanceModifier.defaultWeight().padding(horizontal = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Badge(b.svc, b.color, b.paid)
                        Spacer(GlanceModifier.width(7.dp))
                        TimeText(b, ink, old, 20.sp)
                    }
                    Small(nextLine(b, shown), ink.ink, 12.sp, modifier = GlanceModifier.padding(top = 2.dp))
                    Small(subLine(LocalContext.current, b), ink.muted, 11.sp)
                }
            }
            if (shown.size == 1) Spacer(GlanceModifier.defaultWeight())
        }
        c.refresh?.let { RefreshButton(it, ink, 28.dp) }
    }
}

/** The sky with the stop's name and Now, then the buses under it: rows, or tiles. */
@Composable
private fun NearbySky(
    look: WidgetLook,
    w: Float,
    h: Float,
    skyH: Float,
    fit: NearbyFit,
    v: NearbyView,
    c: NearbyControls,
    now: Long,
    beside: NearbyStop?,
    newcomer: Boolean,
) {
    val ctx = LocalContext.current
    val sky = look.sky
    val ground = look.ground
    val buses = v.buses(now)
    val old = v.old(now)
    val besideBuses = beside?.let { v.busesAt(it, now) }.orEmpty()
    // The hills low, under the stop's name; no moon in the slim sky over both sides, where Now is.
    val moon = Offset(110f, 20f).takeIf { w >= 300f && beside == null }
    val bitmap = skyBitmap(ctx, look, w, skyH, 15f / 92f, Road(stop = true, shuttle = false), moon = moon)
    // The opposite stop a tap away, unless it's the one shown already: beside it, or first.
    val other = v.first?.takeIf { beside == null }?.let { NearbySwap.offer(v.all.orEmpty(), v.swap, now, listOf(it.code)) }
    val swap: (@Composable () -> Unit)? = other?.let { o -> { SwapButton(o, v.all!!.first().code, sky) } }
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, skyH.dp)
        Column(GlanceModifier.fillMaxSize()) {
            Column(GlanceModifier.fillMaxWidth().height(skyH.dp).padding(horizontal = PAD).padding(top = 4.dp)) {
                if (c.chips.isNotEmpty()) {
                    Row(GlanceModifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(GlanceModifier.defaultWeight()) { ModeChips(c.chips, c.showing, sky, c.chipAction) }
                        c.refresh?.let { RefreshButton(it, sky, 28.dp) }
                    }
                    Row(GlanceModifier.fillMaxWidth().height(30.dp), verticalAlignment = Alignment.CenterVertically) {
                        // In a Box: beside the clock's RemoteViews, a weighted Text gets no width.
                        Box(GlanceModifier.defaultWeight()) {
                            Text(title(v), style = TextStyle(color = sky.ink, fontWeight = FontWeight.Bold, fontSize = 17.sp), maxLines = 1)
                        }
                        HeadWords(v, buses, old, sky, walk = false)
                        swap?.invoke()
                    }
                } else if (beside != null) {
                    // Slim: the stop's name, Now and ↻ on one line; each side says how far it is.
                    Row(GlanceModifier.fillMaxWidth().height(30.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(GlanceModifier.defaultWeight()) {
                            Text(title(v), style = TextStyle(color = sky.ink, fontWeight = FontWeight.Bold, fontSize = 17.sp), maxLines = 1)
                        }
                        Box(GlanceModifier.padding(start = 6.dp)) { HeadWords(v, buses + besideBuses, old, sky, walk = false) }
                        c.refresh?.let { RefreshButton(it, sky, 24.dp) }
                    }
                } else {
                    Row(GlanceModifier.fillMaxWidth().height(30.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(GlanceModifier.defaultWeight()) { HeadWords(v, buses, old, sky, walk = true) }
                        swap?.invoke()
                        c.refresh?.let { RefreshButton(it, sky, 24.dp) }
                    }
                    Text(title(v), style = TextStyle(color = sky.ink, fontWeight = FontWeight.Bold, fontSize = 18.sp), maxLines = 1)
                }
            }
            val area = h - skyH
            val message = problem(v, buses + besideBuses)
            if (message != null) {
                Box(GlanceModifier.fillMaxWidth().height((area - 8f).dp).padding(horizontal = PAD), contentAlignment = Alignment.Center) {
                    Text(
                        message,
                        style =
                            TextStyle(color = ground.muted, fontSize = 15.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center),
                        maxLines = 3,
                    )
                }
            } else if (beside != null) {
                Sides(v, beside, buses, besideBuses, fit.rows, ground, old, newcomer)
            } else if (fit.kind == NearbyFit.Kind.ROWS) {
                BusRows(buses.take(fit.rows), ground, old, area)
            } else {
                Tiles(v, buses, fit, ground, old, area, c, now)
            }
        }
    }
}

/**
 * Both sides of the road, a column each: your stop (or this side) and the one [beside] it (across the road, or the next stop), each service
 * a row with the time it's due, up to [rows]. Which side a bus is on says which way it goes. New to NUS ([newcomer]) heads each side with
 * the places its buses go and gives each bus the places it passes, Live or Scheduled in words, and Packed; otherwise each row is the badge,
 * the time and the bus after, for more buses at a glance.
 */
@Composable
private fun Sides(
    v: NearbyView,
    beside: NearbyStop,
    buses: List<StopBus>,
    besideBuses: List<StopBus>,
    rows: Int,
    inks: Inks,
    old: Boolean,
    newcomer: Boolean,
) {
    val first = v.first ?: return
    // Under the sky's full name, each side goes by its short one ("PGP Foyer", "PGP").
    val across = first.opposite == beside.code && first.oppositeAcross
    Row(GlanceModifier.fillMaxWidth().padding(top = 2.dp)) {
        Box(GlanceModifier.defaultWeight()) {
            Side(
                if (across) L.s(R.string.buses_this_side) else first.name,
                if (across) first.name else walkWords(first),
                first,
                buses.take(rows),
                inks,
                old,
                newcomer,
            )
        }
        VRule(inks, 4.dp)
        Box(GlanceModifier.defaultWeight()) {
            Side(
                if (across) L.s(R.string.buses_across) else beside.name,
                walkWords(beside),
                beside,
                besideBuses.take(rows),
                inks,
                old,
                newcomer,
            )
        }
    }
}

/** One side: its heading ("Across the road · 1 min walk"), where its buses go with New to NUS, then a row a bus. */
@Composable
private fun Side(head: String, sub: String, stop: NearbyStop, shown: List<StopBus>, inks: Inks, old: Boolean, newcomer: Boolean) {
    Column(GlanceModifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        Row(GlanceModifier.fillMaxWidth().height(18.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(head, style = TextStyle(color = inks.ink, fontWeight = FontWeight.Bold, fontSize = 11.sp), maxLines = 1)
            Text(" · $sub", style = TextStyle(color = inks.muted, fontSize = 10.sp), maxLines = 1)
        }
        if (newcomer) Small(stop.viaText.orEmpty(), inks.muted, 10.sp, modifier = GlanceModifier.height(14.dp))
        if (shown.isEmpty()) {
            Small(
                if (stop.available) L.s(R.string.no_buses_due) else L.s(R.string.no_live_data),
                inks.muted,
                12.sp,
                modifier = GlanceModifier.padding(top = 6.dp),
            )
            return@Column
        }
        // In a Column of its own: a Glance Column holds at most 10 children.
        Column(GlanceModifier.fillMaxWidth()) {
            shown.forEachIndexed { i, b ->
                if (i > 0) Box(GlanceModifier.fillMaxWidth().height(1.dp).background(inks.line)) {}
                if (newcomer) SideRowExplained(b, shown, inks, old) else SideRow(b, inks, old)
            }
        }
    }
}

/** A bus on its side of the road: its badge, the time it's due, and the one after, muted. */
@Composable
private fun SideRow(b: StopBus, inks: Inks, old: Boolean) {
    val ctx = LocalContext.current
    Row(GlanceModifier.fillMaxWidth().height(NearbyFit.SIDE_ROW_DP.dp), verticalAlignment = Alignment.CenterVertically) {
        // A column for the badges, so the times line up whatever the service's name.
        Box(GlanceModifier.width(BADGE_DP.dp)) { Badge(b.svc, b.color, b.paid) }
        TimeText(b, inks, old, 15.sp)
        val left = minutes(ctx, b, old)
        if (left != null) {
            // The bus after makes way for how long until this one.
            Spacer(GlanceModifier.defaultWeight())
            Minutes(b, left, inks, 11f)
        } else
            b.later.firstOrNull()?.let {
                Text("  " + shortClock(ctx, it), style = TextStyle(color = inks.muted, fontSize = 11.sp), maxLines = 1)
            }
    }
}

/**
 * New to NUS: a bus, its time and how long until it; under them, the places it passes (where it stops next when it passes none), then Live
 * or Scheduled, or Packed (only a live bus says how full it is).
 */
@Composable
private fun SideRowExplained(b: StopBus, shown: List<StopBus>, inks: Inks, old: Boolean) {
    val left = minutes(LocalContext.current, b, old)
    Column(GlanceModifier.fillMaxWidth().height(NearbyFit.SIDE_ROW_NEW_DP.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(GlanceModifier.width(BADGE_DP.dp)) { Badge(b.svc, b.color, b.paid) }
            TimeText(b, inks, old, 13.sp)
            if (left != null) {
                Spacer(GlanceModifier.width(6.dp))
                Minutes(b, left, inks, 10f)
            }
        }
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(GlanceModifier.defaultWeight()) {
                Small(b.via.joinToString(" · ").ifEmpty { nextLine(b, shown) }, inks.ink, 10.sp, bold = true)
            }
            when {
                b.first -> Small(" " + firstLabel(b), inks.muted, 10.sp)
                b.crowd == "high" -> Small(" " + L.s(R.string.buses_packed), inks.late, 10.sp, bold = true)
                b.live -> Small(" ● " + L.s(R.string.journey_live), inks.good, 10.sp)
                else -> Small(" " + L.s(R.string.buses_scheduled), inks.muted, 10.sp)
            }
        }
    }
}

/**
 * Whole minutes until [b] ([NearbyBoard.minutesLeft]), when it shows them: with exact alarms only, which redraw the widget as each minute
 * goes (without them a count could stand a minute or more behind, where a clock time can't); not while the times may be old (a count would
 * claim more than an old guess knows), and not for a first bus, which is a timetable's. Null: the clock time alone.
 */
private fun minutes(ctx: Context, b: StopBus, old: Boolean): Int? =
    if (old || b.first || !LeaveAlerts.canBeExact(ctx)) null else NearbyBoard.minutesLeft(b.atMs, System.currentTimeMillis())

/** How long until a bus, [left] whole minutes: "6 min", "~6 min" for a timetable's time, "now" in its last minute. */
@Composable
private fun Minutes(b: StopBus, left: Int, inks: Inks, sizeSp: Float) {
    Box(GlanceModifier.cornerRadius(8.dp).background(inks.chip).padding(horizontal = 6.dp, vertical = 1.dp)) {
        if (left == 0) {
            Text(
                L.s(R.string.now),
                style = TextStyle(color = inks.good, fontSize = sizeSp.sp, fontWeight = FontWeight.Bold),
                maxLines = 1,
            )
        } else {
            Text(
                L.s(if (b.live) R.string.nearby_min else R.string.nearby_min_approx, left),
                style = TextStyle(color = inks.ink, fontSize = sizeSp.sp, fontWeight = FontWeight.Medium),
                maxLines = 1,
            )
        }
    }
}

/** Wide enough for a badge and the gap after it ("R1"; a public bus's "95 $" a little over). */
private const val BADGE_DP = 36f

/** "2 min walk", or "here" under a minute. */
private fun walkWords(stop: NearbyStop): String =
    if (stop.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (stop.walkS + 30) / 60)

/** The biggest a tile grows: past this, the room is better spent on the next stop's buses. */
private const val TILE_MAX_DP = 128f
private const val STOP_HEAD_DP = 24f
/** Clear of the widget's rounded corners, so the last row's pills aren't cut. */
private const val BOTTOM_DP = NearbyFit.BOTTOM_DP

/**
 * The stop's services as tiles, [NearbyFit.cols] across: one row and the pager, or rows and the rest along the bottom. Rows a stop with few
 * services leaves empty go to the next stop's, under its name.
 */
@Composable
private fun Tiles(
    v: NearbyView,
    buses: List<StopBus>,
    fit: NearbyFit,
    inks: Inks,
    old: Boolean,
    area: Float,
    c: NearbyControls,
    now: Long,
) {
    val cols = fit.cols
    if (fit.pager) {
        val paged = NearbyBoard.page(buses, cols, v.page)
        val tileH = minOf(area - NearbyFit.PAGER_DP, TILE_MAX_DP)
        TileRow(paged.buses, paged.buses, cols, inks, old, tileH.dp, laterBeside = cols < 3)
        if (paged.pages > 1) Pager(paged.page, paged.pages, inks, c.page)
        return
    }
    val rows = minOf(fit.rows, (buses.size + cols - 1) / cols)
    val rest = buses.drop(rows * cols)
    val foot = if (fit.footer && rest.isNotEmpty()) NearbyFit.FOOTER_DP else 0f
    // Spare rows: the next stop with buses, as the Buses tab lists it, as
    // many as fit under its name without squeezing a tile below its smallest.
    val room = area - BOTTOM_DP
    // A few dp under a tile's smallest is fine: it leaves room for a later line seldom used.
    val spare = minOf(fit.rows - rows, ((room - STOP_HEAD_DP) / (NearbyFit.tileDp(cols) - 4f)).toInt() - rows)
    val next =
        if (spare > 0 && rest.isEmpty())
            v.stops.orEmpty().drop(1).firstNotNullOfOrNull { st ->
                NearbyBoard.buses(st, v.fetchedAt ?: 0L, now, ServerClock.skewMs)
                    .takeIf { it.isNotEmpty() }
                    ?.let { st to it.take(spare * cols) }
            }
        else null
    val nextRows = next?.let { (it.second.size + cols - 1) / cols } ?: 0
    // The 1 dp rules between rows count too.
    val rules = (rows - 1) + maxOf(nextRows - 1, 0)
    val tileH = minOf((room - foot - rules - (if (next != null) STOP_HEAD_DP else 0f)) / (rows + nextRows), TILE_MAX_DP).dp
    val shown = buses.take(rows * cols)
    // In a Column of its own: a Glance Column holds at most 10 children.
    Column(GlanceModifier.fillMaxWidth()) {
        for (r in 0 until rows) {
            if (r > 0) HRule(inks)
            TileRow(shown.drop(r * cols).take(cols), shown, cols, inks, old, tileH, laterBeside = cols < 3)
        }
    }
    if (foot > 0f) Footer(rest, inks, old)
    next?.let { (stop, more) ->
        val walk = if (stop.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (stop.walkS + 30) / 60)
        Box(GlanceModifier.fillMaxWidth().height(STOP_HEAD_DP.dp).padding(horizontal = PAD), contentAlignment = Alignment.BottomStart) {
            Small("${stop.longName ?: stop.name} · $walk", inks.muted, 12.sp, bold = true)
        }
        Column(GlanceModifier.fillMaxWidth()) {
            for (r in 0 until nextRows) {
                if (r > 0) HRule(inks)
                TileRow(more.drop(r * cols).take(cols), more, cols, inks, old, tileH, laterBeside = cols < 3)
            }
        }
    }
}

/**
 * The line above the stop's name: "Now 9:41 · 2 min walk"; "Times may be old · 9:39" once they are; "Updating…" or the last fetch's
 * problem.
 */
@Composable
private fun HeadWords(v: NearbyView, buses: List<StopBus>, old: Boolean, inks: Inks, walk: Boolean) {
    val ctx = LocalContext.current
    val first = v.first
    val walkText = first?.takeIf { walk }?.let { if (it.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (it.walkS + 30) / 60) }
    when {
        v.error == UPDATING -> Small(L.s(R.string.updating), inks.muted, 12.sp)
        v.error != null && buses.isNotEmpty() -> Small(v.error, inks.late, 12.sp)
        old && buses.isNotEmpty() -> Small(L.s(R.string.nearby_old, shortClock(ctx, v.fetchedAt!!)), inks.late, 12.sp)
        first == null -> Small(L.s(R.string.chip_nearby), inks.muted, 12.sp)
        else ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                NowClock(inks.muted, inks.ink, 12f)
                walkText?.let { Small(" · $it", inks.muted, 12.sp) }
            }
    }
}

/** A row of tiles, [cols] across, the rule between them; an empty cell where there's no bus. */
@Composable
private fun TileRow(row: List<StopBus>, shown: List<StopBus>, cols: Int, inks: Inks, old: Boolean, height: Dp, laterBeside: Boolean) {
    Row(GlanceModifier.fillMaxWidth().height(height)) {
        for (i in 0 until cols) {
            if (i > 0) VRule(inks, 8.dp)
            val b = row.getOrNull(i)
            Box(GlanceModifier.defaultWeight().fillMaxHeight()) {
                if (b != null) Tile(b, shown, inks, old, laterBeside, big = cols < 3)
            }
        }
    }
}

/**
 * One service: its badge and the time it's due, the next ones beside it where there's room ("then 9:50"), its next stop over up to two
 * lines, the next ones under it where there isn't, and Live and how full.
 */
@Composable
private fun Tile(b: StopBus, shown: List<StopBus>, inks: Inks, old: Boolean, laterBeside: Boolean, big: Boolean) {
    val ctx = LocalContext.current
    Column(GlanceModifier.fillMaxSize().padding(horizontal = 10.dp).padding(top = 6.dp, bottom = 3.dp)) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Badge(b.svc, b.color, b.paid, big = true)
            Spacer(GlanceModifier.width(8.dp))
            TimeText(b, inks, old, if (big) 24.sp else 21.sp)
            if (laterBeside && b.later.isNotEmpty()) {
                Spacer(GlanceModifier.defaultWeight())
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        L.s(R.string.nearby_then_label),
                        style = TextStyle(color = inks.muted, fontSize = 10.sp, textAlign = TextAlign.End),
                        maxLines = 1,
                    )
                    Text(
                        shortClock(ctx, b.later.first()),
                        style = TextStyle(color = inks.muted, fontSize = 10.sp, textAlign = TextAlign.End),
                        maxLines = 1,
                    )
                }
            }
        }
        Text(
            nextLine(b, shown),
            style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Medium),
            maxLines = 2,
            modifier = GlanceModifier.padding(top = 2.dp),
        )
        if (!laterBeside && b.later.isNotEmpty()) Small(laterLine(ctx, b), inks.muted, 11.sp)
        Spacer(GlanceModifier.defaultWeight())
        Pills(b, inks)
    }
}

/** Narrow widgets: a service a row, its next stop over the buses after it, its time at the end. */
@Composable
private fun BusRows(buses: List<StopBus>, inks: Inks, old: Boolean, area: Float) {
    val ctx = LocalContext.current
    val rowH = minOf(area / maxOf(buses.size, 1), 48f).dp
    Column(GlanceModifier.fillMaxWidth().padding(horizontal = PAD)) {
        buses.forEachIndexed { i, b ->
            if (i > 0) Box(GlanceModifier.fillMaxWidth().height(1.dp).background(inks.line)) {}
            Row(GlanceModifier.fillMaxWidth().height(rowH), verticalAlignment = Alignment.CenterVertically) {
                Box(GlanceModifier.width(44.dp)) { Badge(b.svc, b.color, b.paid, big = true) }
                Column(GlanceModifier.defaultWeight()) {
                    Small(nextLine(b, buses), inks.ink, 13.sp, bold = true)
                    if (b.later.isNotEmpty() || b.first) Small(subLine(ctx, b), inks.muted, 11.sp)
                }
                TimeText(b, inks, old, 19.sp)
            }
        }
    }
}

/** ‹ the dots › under a row of tiles: the other services, a page of them at a time. */
@Composable
private fun Pager(page: Int, pages: Int, inks: Inks, action: ((Int) -> Action)?) {
    Row(
        GlanceModifier.fillMaxWidth().height(NearbyFit.PAGER_DP.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Arrow("‹", L.s(R.string.nearby_page_prev), inks, action?.invoke(-1))
        // A Row holds at most 10 children: the arrows and up to 8 dots.
        for (i in 0 until minOf(pages, 8)) {
            Box(GlanceModifier.padding(horizontal = 2.dp)) {
                Box(GlanceModifier.size(5.dp).cornerRadius(3.dp).background(if (i == page) inks.muted else inks.line)) {}
            }
        }
        Arrow("›", L.s(R.string.nearby_page_next), inks, action?.invoke(1))
    }
}

@Composable
private fun Arrow(text: String, spoken: String, inks: Inks, action: Action?) {
    var m = GlanceModifier.width(48.dp).fillMaxHeight().semantics { contentDescription = spoken }
    if (action != null) m = m.clickable(action)
    Box(m, contentAlignment = Alignment.Center) {
        Text(text, style = TextStyle(color = inks.muted, fontSize = 15.sp, fontWeight = FontWeight.Bold), maxLines = 1)
    }
}

/** Under a grid: the services that didn't fit, each with its time. */
@Composable
private fun Footer(rest: List<StopBus>, inks: Inks, old: Boolean) {
    val ctx = LocalContext.current
    Row(
        GlanceModifier.fillMaxWidth().height(NearbyFit.FOOTER_DP.dp).padding(horizontal = PAD),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        rest.take(4).forEach { b ->
            Row(GlanceModifier.padding(end = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Badge(b.svc, b.color, b.paid)
                Text(" " + timeText(ctx, b), style = TextStyle(color = if (old) inks.muted else inks.ink, fontSize = 12.sp), maxLines = 1)
            }
        }
    }
}

/**
 * The nearest stop's services two by two under a heading, [rows] of them: the big widget's next buses, under its trip. The heading says
 * when the times may be old, as Nearby's line above does.
 */
@Composable
internal fun NearbyPair(v: NearbyView, inks: Inks, now: Long, rows: Int = 1) {
    val ctx = LocalContext.current
    val first = v.first ?: return
    val buses = v.buses(now).take(2 * rows)
    if (buses.isEmpty()) return
    val old = v.old(now)
    val head =
        if (old) L.s(R.string.nearby_old, shortClock(ctx, v.fetchedAt!!)) else L.s(R.string.nearby_next_buses, first.longName ?: first.name)
    Small(head, if (old) inks.late else inks.muted, 11.sp, bold = true, modifier = GlanceModifier.padding(top = 6.dp))
    Column(GlanceModifier.fillMaxWidth()) {
        for (r in 0 until (buses.size + 1) / 2) {
            if (r > 0) HRule(inks)
            TileRow(buses.drop(r * 2).take(2), buses, 2, inks, old, NEARBY_PAIR_DP.dp, laterBeside = true)
        }
    }
}

/** The big widget's next buses: a heading, and a row of tiles with room for a next stop over two lines. */
internal const val NEARBY_PAIR_DP = 106f
internal const val NEARBY_PAIR_HEAD_DP = 22f

@Composable
private fun Pills(b: StopBus, inks: Inks) {
    if (b.first) return PillText(firstLabel(b), inks.muted, inks)
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (b.live) PillText("● " + L.s(R.string.journey_live), inks.good, inks)
        else PillText(L.s(R.string.buses_scheduled), inks.muted, inks)
        val crowd =
            when (b.crowd) {
                "low" -> L.s(R.string.buses_seats) to inks.good
                "medium" -> L.s(R.string.buses_busy) to inks.muted
                "high" -> L.s(R.string.buses_packed) to inks.late
                else -> null
            }
        crowd?.let { (word, color) ->
            Spacer(GlanceModifier.width(4.dp))
            PillText(word, color, inks)
        }
    }
}

/** The time a bus is due, big: "9:42", "~9:48" for a timetable's guess; muted once the times may be old. */
@Composable
private fun TimeText(b: StopBus, inks: Inks, old: Boolean, size: TextUnit) {
    Text(
        timeText(LocalContext.current, b),
        style = TextStyle(color = if (old) inks.muted else inks.ink, fontWeight = FontWeight.Bold, fontSize = size),
        maxLines = 1,
    )
}

/** A rule between two columns, [inset] short of each end. */
@Composable
private fun VRule(inks: Inks, inset: Dp) {
    Box(GlanceModifier.width(1.dp).fillMaxHeight().padding(vertical = inset)) {
        Box(GlanceModifier.fillMaxSize().background(inks.line)) {}
    }
}

@Composable
private fun HRule(inks: Inks) {
    Box(GlanceModifier.fillMaxWidth().height(1.dp).padding(horizontal = 12.dp)) {
        Box(GlanceModifier.fillMaxSize().background(inks.line)) {}
    }
}

private fun timeText(ctx: Context, b: StopBus): String = (if (b.live || b.first) "" else "~") + shortClock(ctx, b.atMs)

/** Under the next stop where there are no pills: the buses after it, or which first bus it is. */
private fun subLine(ctx: Context, b: StopBus): String = if (b.first) firstLabel(b) else laterLine(ctx, b)

/** "First bus"; "First bus tomorrow", "First bus Monday" when it isn't today, on campus. */
private fun firstLabel(b: StopBus): String {
    val zone = java.time.ZoneId.of(CAMPUS_ZONE)
    fun day(ms: Long) = java.time.Instant.ofEpochMilli(ServerClock.fromDevice(ms)).atZone(zone).toLocalDate()
    val on = day(b.atMs)
    val days = java.time.temporal.ChronoUnit.DAYS.between(day(System.currentTimeMillis()), on)
    return when {
        days <= 0L -> L.s(R.string.nearby_first)
        days == 1L -> L.s(R.string.nearby_first_tomorrow)
        else -> L.s(R.string.nearby_first_on, sh.rcn.terminus.dayName(on.dayOfWeek.value % 7))
    }
}

/** "Next Yusof Ishak House"; with where it ends when another bus shown stops there next too; "Ends here". */
private fun nextLine(b: StopBus, shown: List<StopBus>): String {
    val next = b.next ?: return if (b.endsHere) L.s(R.string.buses_ends_here) else ""
    return NearbyBoard.endIfNeeded(b, shown)?.let { L.s(R.string.nearby_next_to, next, it) } ?: L.s(R.string.nearby_next, next)
}

/** "then 9:50, 9:58"; empty with none after it. */
private fun laterLine(ctx: Context, b: StopBus): String =
    if (b.later.isEmpty()) ""
    else L.s(R.string.nearby_then, b.later.take(2).joinToString(L.s(R.string.nearby_times_sep)) { shortClock(ctx, it) })

/** Shows the stop across the road first, or the nearest one again. */
@Composable
internal fun SwapButton(other: NearbyStop, nearest: String, inks: Inks, side: Dp = 26.dp) {
    Box(
        GlanceModifier.size(side + 8.dp)
            .semantics { contentDescription = L.s(R.string.nearby_swap, other.name) }
            .clickable(actionRunCallback<SwapAction>(actionParametersOf(SwapAction.FROM to nearest, SwapAction.TO to other.code))),
        contentAlignment = Alignment.Center,
    ) {
        Box(GlanceModifier.size(side).cornerRadius(side / 2).background(inks.chip), contentAlignment = Alignment.Center) {
            Image(
                ImageProvider(R.drawable.ic_swap),
                contentDescription = null,
                colorFilter = ColorFilter.tint(inks.ink),
                modifier = GlanceModifier.size(side / 2),
            )
        }
    }
}

/**
 * "Now 9:41", the time a [TextClock][android.widget.TextClock] keeps by itself, in campus time and the account's 12/24-hour style, as the
 * bus times beside it ([shortClock]). [label]: with "Now" before it.
 */
@Composable
internal fun NowClock(labelColor: ColorProvider, timeColor: ColorProvider, sizeSp: Float, label: Boolean = true) {
    val ctx = LocalContext.current
    val rv = RemoteViews(ctx.packageName, R.layout.widget_now_clock)
    rv.setViewVisibility(R.id.now_label, if (label) View.VISIBLE else View.GONE)
    rv.setTextViewText(R.id.now_label, L.s(R.string.widget_now))
    rv.setTextColor(R.id.now_label, labelColor.getColor(ctx).toArgb())
    rv.setTextColor(R.id.now_clock, timeColor.getColor(ctx).toArgb())
    rv.setTextViewTextSize(R.id.now_label, TypedValue.COMPLEX_UNIT_SP, sizeSp)
    rv.setTextViewTextSize(R.id.now_clock, TypedValue.COMPLEX_UNIT_SP, sizeSp)
    val pattern = shortPattern(ctx)
    rv.setCharSequence(R.id.now_clock, "setFormat12Hour", pattern)
    rv.setCharSequence(R.id.now_clock, "setFormat24Hour", pattern)
    rv.setString(R.id.now_clock, "setTimeZone", CAMPUS_ZONE)
    AndroidRemoteViews(rv)
}

private const val CAMPUS_ZONE = "Asia/Singapore"

/**
 * Hours and minutes in the account's 12/24-hour style, without AM or PM: a bus is due within the hour, and "9:42 AM" doesn't fit a tile.
 */
internal fun shortPattern(ctx: Context): String = if (hour12(ctx)) "h:mm" else "HH:mm"

/** [deviceMs] (the phone's clock) as campus time, short ([shortPattern]), beside "Now" ([NowClock]). */
internal fun shortClock(ctx: Context, deviceMs: Long): String =
    SimpleDateFormat(shortPattern(ctx), Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone(CAMPUS_ZONE) }
        .format(Date(ServerClock.fromDevice(deviceMs)))

/** Nearby, as a sentence for screen readers. */
internal fun nearbySpoken(ctx: Context, stops: List<NearbyStop>?, fetchedAt: Long?, error: String?): String {
    val first = stops?.firstOrNull() ?: return L.s(R.string.a11y_nearby_none, error ?: L.s(R.string.a11y_checking))
    val age = fetchedAt?.let { (System.currentTimeMillis() - it) / 1000 } ?: 0L
    val firsts = { NearbyBoard.buses(first, fetchedAt ?: 0L, System.currentTimeMillis(), ServerClock.skewMs).filter { it.first }.take(3) }
    val due =
        BaseWidget.departures(first, age, 3).replace(" · ", L.s(R.string.clause_sep)).ifEmpty {
            firsts()
                .takeIf { it.isNotEmpty() }
                ?.let { f ->
                    L.s(R.string.nearby_first_spoken, f.joinToString(L.s(R.string.clause_sep)) { "${it.svc} ${shortClock(ctx, it.atMs)}" })
                } ?: L.s(R.string.a11y_no_buses)
        }
    return L.s(R.string.a11y_nearby, first.name, Spoken.spell(due))
}

/** The pager's page, per widget: which of a stop's services a row of tiles shows. */
internal val NEARBY_PAGE = intPreferencesKey("nearby-page")

/** The pager's arrows: the next page of services, or the one before, counting round. */
class PageAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val dir = parameters[DIR] ?: return
        updateAppWidgetState(context, glanceId) { it[NEARBY_PAGE] = (it[NEARBY_PAGE] ?: 0) + dir }
        redrawWidgets(context)
    }

    companion object {
        val DIR = ActionParameters.Key<Int>("dir")

        fun of(dir: Int): Action = actionRunCallback<PageAction>(actionParametersOf(DIR to dir))
    }
}
