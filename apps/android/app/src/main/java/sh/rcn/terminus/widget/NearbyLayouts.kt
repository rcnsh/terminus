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
import sh.rcn.terminus.DeviceKind
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NewToNus
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.hour12
import sh.rcn.terminus.ui.Road

internal class NearbyView(
    val paired: Boolean,
    val stops: List<NearbyStop>?,
    val all: List<NearbyStop>?,
    val swap: NearbySwap.Swap?,
    val fetchedAt: Long?,
    val error: String?,
    val page: Int = 0,
) {
    val first: NearbyStop?
        get() = stops?.firstOrNull()

    fun old(now: Long): Boolean = (fetchedAt == null || now - fetchedAt > WidgetModes.NEARBY_OLD_MS) && buses(now).any { !it.first }

    fun buses(now: Long): List<StopBus> = first?.let { busesAt(it, now) }.orEmpty()

    fun busesAt(stop: NearbyStop, now: Long): List<StopBus> = NearbyBoard.buses(stop, fetchedAt ?: 0L, now, ServerClock.skewMs)

    companion object {
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

internal class NearbyControls(
    val refresh: Action?,
    val page: ((Int) -> Action)?,
    val chips: List<Mode> = emptyList(),
    val showing: Mode = Mode.Nearby,
    val chipAction: (Mode) -> Action = { error("no chips") },
)

private val PAD = 14.dp

private const val SKY_DP = 72f
private const val CHIPS_SKY_DP = 94f

@Composable
internal fun NearbyLayout(look: WidgetLook, w: Float, h: Float, v: NearbyView, c: NearbyControls) {
    val now = System.currentTimeMillis()
    val chipsOnTop = c.chips.isNotEmpty()
    val newcomer = NewToNus.on(LocalContext.current)
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

private fun problem(v: NearbyView, buses: List<StopBus>): String? {
    val first = v.first
    return when {
        !v.paired -> L.s(DeviceKind.word(R.string.tap_to_pair))
        checking(v) -> L.s(R.string.checking)
        v.stops == null -> v.error ?: L.s(R.string.nearby_tap_refresh)
        first == null -> v.error ?: L.s(R.string.no_stops_near)
        buses.isEmpty() -> if (first.available) L.s(R.string.no_buses_due) else L.s(R.string.no_live_data)
        else -> null
    }
}

private fun checking(v: NearbyView): Boolean = v.paired && v.error == UPDATING && v.stops.isNullOrEmpty()

@Composable
private fun SkeletonRows(rows: Int, inks: Inks) {
    Column(GlanceModifier.fillMaxWidth().semantics { contentDescription = L.s(R.string.checking) }) {
        for (i in 0 until rows) {
            Row(GlanceModifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                WidgetBar(28.dp, 20.dp, inks)
                Spacer(GlanceModifier.width(10.dp))
                WidgetBar(listOf(120.dp, 96.dp, 108.dp)[i % 3], 12.dp, inks)
                Spacer(GlanceModifier.defaultWeight())
                WidgetBar(44.dp, 14.dp, inks)
            }
        }
    }
}

private fun title(v: NearbyView): String =
    when {
        !v.paired -> "terminus"
        else -> v.first?.let { it.longName ?: it.name } ?: L.s(R.string.chip_nearby)
    }

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
            if (checking(v)) Box(GlanceModifier.padding(top = 4.dp)) { HeadlineBar(L.s(R.string.checking), ink, 16.sp, 90.dp) }
            else Small(problem(v, buses).orEmpty(), ink.ink, 12.sp, lines = 2, modifier = GlanceModifier.padding(top = 2.dp))
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
                if (checking(v)) HeadlineBar(L.s(R.string.checking), ink, 16.sp, 120.dp)
                else Small(problem(v, buses).orEmpty(), ink.ink, 13.sp, lines = 2)
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
    val moon = Offset(110f, 20f).takeIf { w >= 300f && beside == null }
    val bitmap = skyBitmap(ctx, look, w, skyH, 15f / 92f, Road(stop = true, shuttle = false), moon = moon)
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
                        Box(GlanceModifier.defaultWeight()) {
                            Text(title(v), style = TextStyle(color = sky.ink, fontWeight = FontWeight.Bold, fontSize = 17.sp), maxLines = 1)
                        }
                        HeadWords(v, buses, old, sky, walk = false)
                        swap?.invoke()
                    }
                } else if (beside != null) {
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
            if (message != null && checking(v)) {
                Box(GlanceModifier.fillMaxWidth().padding(horizontal = PAD).padding(top = 4.dp)) {
                    SkeletonRows(((area - 12f) / 32f).toInt().coerceIn(1, 3), ground)
                }
            } else if (message != null) {
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
        Column(GlanceModifier.fillMaxWidth()) {
            shown.forEachIndexed { i, b ->
                if (i > 0) Box(GlanceModifier.fillMaxWidth().height(1.dp).background(inks.line)) {}
                if (newcomer) SideRowExplained(b, shown, inks, old) else SideRow(b, inks, old)
            }
        }
    }
}

@Composable
private fun SideRow(b: StopBus, inks: Inks, old: Boolean) {
    val ctx = LocalContext.current
    Row(GlanceModifier.fillMaxWidth().height(NearbyFit.SIDE_ROW_DP.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(GlanceModifier.width(BADGE_DP.dp)) { Badge(b.svc, b.color, b.paid) }
        TimeText(b, inks, old, 15.sp)
        val left = minutes(ctx, b, old)
        if (left != null) {
            Spacer(GlanceModifier.defaultWeight())
            Minutes(b, left, inks, 11f)
        } else
            b.later.firstOrNull()?.let {
                Text("  " + shortClock(ctx, it), style = TextStyle(color = inks.muted, fontSize = 11.sp), maxLines = 1)
            }
    }
}

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

private fun minutes(ctx: Context, b: StopBus, old: Boolean): Int? =
    if (old || b.first || !LeaveAlerts.canBeExact(ctx)) null else NearbyBoard.minutesLeft(b.atMs, System.currentTimeMillis())

@Composable
private fun Minutes(b: StopBus, left: Int, inks: Inks, sizeSp: Float) {
    Box(GlanceModifier.cornerRadius(8.dp).background(inks.chip).padding(horizontal = 6.dp, vertical = 1.dp)) {
        val now = left == 0 && b.live
        Text(
            NearbyBoard.minutesWords(left, b.live),
            style =
                TextStyle(
                    color = if (now) inks.good else inks.ink,
                    fontSize = sizeSp.sp,
                    fontWeight = if (now) FontWeight.Bold else FontWeight.Medium,
                ),
            maxLines = 1,
        )
    }
}

private const val BADGE_DP = 36f

private fun walkWords(stop: NearbyStop): String = stop.walkWords.orEmpty()

private const val TILE_MAX_DP = 128f
private const val STOP_HEAD_DP = 24f
private const val BOTTOM_DP = NearbyFit.BOTTOM_DP

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
    val room = area - BOTTOM_DP
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
    val rules = (rows - 1) + maxOf(nextRows - 1, 0)
    val tileH = minOf((room - foot - rules - (if (next != null) STOP_HEAD_DP else 0f)) / (rows + nextRows), TILE_MAX_DP).dp
    val shown = buses.take(rows * cols)
    Column(GlanceModifier.fillMaxWidth()) {
        for (r in 0 until rows) {
            if (r > 0) HRule(inks)
            TileRow(shown.drop(r * cols).take(cols), shown, cols, inks, old, tileH, laterBeside = cols < 3)
        }
    }
    if (foot > 0f) Footer(rest, inks, old)
    next?.let { (stop, more) ->
        val walk = stop.walkWords?.let { " · $it" }.orEmpty()
        Box(GlanceModifier.fillMaxWidth().height(STOP_HEAD_DP.dp).padding(horizontal = PAD), contentAlignment = Alignment.BottomStart) {
            Small("${stop.longName ?: stop.name}$walk", inks.muted, 12.sp, bold = true)
        }
        Column(GlanceModifier.fillMaxWidth()) {
            for (r in 0 until nextRows) {
                if (r > 0) HRule(inks)
                TileRow(more.drop(r * cols).take(cols), more, cols, inks, old, tileH, laterBeside = cols < 3)
            }
        }
    }
}

@Composable
private fun HeadWords(v: NearbyView, buses: List<StopBus>, old: Boolean, inks: Inks, walk: Boolean) {
    val ctx = LocalContext.current
    val first = v.first
    val walkText = first?.takeIf { walk }?.walkWords
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

@Composable
private fun Pager(page: Int, pages: Int, inks: Inks, action: ((Int) -> Action)?) {
    Row(
        GlanceModifier.fillMaxWidth().height(NearbyFit.PAGER_DP.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Arrow("‹", L.s(R.string.nearby_page_prev), inks, action?.invoke(-1))
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

@Composable
private fun TimeText(b: StopBus, inks: Inks, old: Boolean, size: TextUnit) {
    Text(
        timeText(LocalContext.current, b),
        style = TextStyle(color = if (old) inks.muted else inks.ink, fontWeight = FontWeight.Bold, fontSize = size),
        maxLines = 1,
    )
}

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

private fun subLine(ctx: Context, b: StopBus): String = if (b.first) firstLabel(b) else laterLine(ctx, b)

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

private fun nextLine(b: StopBus, shown: List<StopBus>): String {
    val next = b.next ?: return if (b.endsHere) L.s(R.string.buses_ends_here) else ""
    return NearbyBoard.endIfNeeded(b, shown)?.let { L.s(R.string.nearby_next_to, next, it) } ?: L.s(R.string.nearby_next, next)
}

private fun laterLine(ctx: Context, b: StopBus): String =
    if (b.later.isEmpty()) ""
    else L.s(R.string.nearby_then, b.later.take(2).joinToString(L.s(R.string.nearby_times_sep)) { shortClock(ctx, it) })

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

internal fun shortPattern(ctx: Context): String = if (hour12(ctx)) "h:mm" else "HH:mm"

internal fun shortClock(ctx: Context, deviceMs: Long): String =
    SimpleDateFormat(shortPattern(ctx), Locale.ROOT)
        .apply { timeZone = TimeZone.getTimeZone(CAMPUS_ZONE) }
        .format(Date(ServerClock.fromDevice(deviceMs)))

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

internal val NEARBY_PAGE = intPreferencesKey("nearby-page")

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
