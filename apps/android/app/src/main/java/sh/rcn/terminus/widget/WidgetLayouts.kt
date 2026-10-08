package sh.rcn.terminus.widget

import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.action.Action
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
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
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.L
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.OfflineDay
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.parseColor
import sh.rcn.terminus.ui.Road
import sh.rcn.terminus.ui.eta

/**
 * The widget's layout by its size on the home screen: a bar one row tall,
 * a small square counting to the time to leave, the trip with the sky over
 * it, and, tall enough, your day: the trip's steps and what's left of today.
 */
internal enum class WidgetShape {
    BAR, SQUARE, TRIP, DAY;

    /** Room for the chips that switch what it shows. */
    val roomy: Boolean get() = this == TRIP || this == DAY

    companion object {
        fun of(widthDp: Float, heightDp: Float): WidgetShape = when {
            heightDp < 130f -> BAR
            widthDp < 220f -> SQUARE
            heightDp >= 290f && widthDp >= 250f -> DAY
            else -> TRIP
        }
    }
}

/** Everything a layout needs, worked out once in [BaseWidget]. */
internal class Scene(
    val look: WidgetLook,
    val face: Face,
    val answer: NextAnswer?,
    /** ↻, or null when the widget has none ([BaseWidget.Frame.refreshButton]). */
    val refresh: Action?,
    val chips: List<Mode>,
    val showing: Mode,
    val chipAction: (Mode) -> Action,
    /** The day plan, read only when shown. */
    val day: () -> DayPlan?,
    /** The card style chosen in Settings. */
    val style: String,
)

private val PAD = 14.dp

/** The bottom of the widget's sky, where a layout's words above the hills must end. */
private fun strip(skyH: Float, textH: Float, min: Float, max: Float): Float = (skyH - textH + 10f).coerceIn(min, max)

/** The line above the headline with ↻ at its end. */
@Composable
private fun HeadRow(text: String?, s: Scene, inks: Inks, side: Dp = 32.dp) {
    Row(GlanceModifier.fillMaxWidth().height(side + 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Small(text.orEmpty(), inks.muted, 12.sp, modifier = GlanceModifier.defaultWeight())
        s.refresh?.let { RefreshButton(it, inks, side) }
    }
}

/**
 * The trip, two rows or so: the line above, the headline and how it gets
 * you there in the sky, the hills with your stop and your bus, then the leg
 * along the ground and, on the favourites widget, the chips.
 */
@Composable
internal fun TripLayout(s: Scene, w: Float, h: Float) {
    val ctx = LocalContext.current
    val face = s.face
    val sky = s.look.sky
    val chipsH = if (s.chips.isNotEmpty()) 44f else 0f
    // As much as fits, the leg first to go, then the line under the headline.
    val textFull = 6f + 36f + 32f
    var leg = face.leg != null
    var sub = face.sub != null || face.pill != null
    val tileH = if (face.tile != null) 54f else 0f
    fun need() = textFull + (if (sub) 22f else 0f) + tileH + 28f + (if (leg) 28f else 0f) + chipsH + 8f
    if (need() > h) leg = false
    if (need() > h) sub = false
    val groundH = (if (leg) 28f else 0f) + chipsH + 8f
    val skyH = h - groundH
    val textH = textFull + (if (sub) 22f else 0f) + tileH
    val stripDp = strip(skyH, textH, 26f, 52f)
    // The moon at the end of the headline's line, under ↻.
    val bitmap = skyBitmap(ctx, s.look, w, skyH, stripDp / 92f, face.road, moon = Offset(34f, 58f))
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, skyH.dp)
        Column(GlanceModifier.fillMaxSize().padding(horizontal = PAD)) {
            Column(GlanceModifier.fillMaxWidth().height(skyH.dp).padding(top = 6.dp)) {
                HeadRow(face.heading, s, sky, side = 28.dp)
                Headline(face, sky, 26.sp)
                if (sub) SubLine(face, sky)
                face.tile?.let { Spacer(GlanceModifier.height(8.dp)); TileBox(it, sky) }
            }
            if (leg) Box(GlanceModifier.fillMaxWidth().height(28.dp), contentAlignment = Alignment.CenterStart) { face.leg?.let { LegRow(it, s.look.ground) } }
            if (s.chips.isNotEmpty()) ModeChips(s.chips, s.showing, s.look.ground, s.chipAction)
        }
    }
}

/**
 * The big widget: the chips across the sky's top, the headline, then on the
 * ground the trip's steps in the card style chosen in Settings and what's
 * left of today's timetable.
 */
@Composable
internal fun DayLayout(s: Scene, w: Float, h: Float) {
    val ctx = LocalContext.current
    val face = s.face
    val sky = s.look.sky
    val ground = s.look.ground
    val sub = face.sub != null || face.pill != null
    val textH = 10f + 40f + (if (face.heading != null) 18f else 0f) + 36f + (if (sub) 24f else 0f) + (if (face.tile != null) 58f else 0f)
    val skyH = textH + 40f
    val bitmap = skyBitmap(ctx, s.look, w, skyH, 50f / 92f, face.road, moon = Offset(34f, 80f))
    val journey = face.journey?.takeIf { s.answer?.card?.phase != "riding" }
    val bodyH = journey?.let { journeyHeight(it, s.style).value } ?: if (face.leg != null) 30f else 0f
    val left = h - skyH - bodyH - 12f
    // Today's timetable: what's still to come, a line each, as many as fit under a heading.
    val now = ServerClock.now()
    val rows = ((left - 30f) / 30f).toInt().coerceIn(0, 6)
    val today = if (rows > 0) s.day()?.takeIf { it.date == null || it.date == OfflineDay.sgtDate(now) }?.items?.filter { it.status in UPCOMING }?.take(rows).orEmpty() else emptyList()
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, skyH.dp)
        Column(GlanceModifier.fillMaxSize().padding(horizontal = PAD)) {
            Column(GlanceModifier.fillMaxWidth().height(skyH.dp).padding(top = 10.dp)) {
                Row(GlanceModifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(GlanceModifier.defaultWeight()) {
                        if (s.chips.isNotEmpty()) ModeChips(s.chips, s.showing, sky, s.chipAction) else Small("terminus", sky.ink, 15.sp, bold = true)
                    }
                    s.refresh?.let { RefreshButton(it, sky) }
                }
                face.heading?.let { Small(it, sky.muted, 12.sp, modifier = GlanceModifier.padding(top = 2.dp)) }
                Headline(face, sky, 28.sp)
                if (sub) SubLine(face, sky)
                face.tile?.let { Spacer(GlanceModifier.height(8.dp)); TileBox(it, sky) }
            }
            Spacer(GlanceModifier.height(6.dp))
            when {
                journey != null -> WidgetJourney(s.answer!!, journey, s.style, ground, s.look.pageColor)
                face.leg != null -> LegRow(face.leg, ground)
            }
            if (today.isNotEmpty()) Today(today, ground)
        }
    }
}

/** What's left of today, from the day plan: done and skipped ones aren't. */
private val UPCOMING = setOf("now", "next", "later")

@Composable
private fun Today(items: List<DayItem>, inks: Inks) {
    val ctx = LocalContext.current
    Column(GlanceModifier.fillMaxWidth().padding(top = 8.dp)) {
        Text(L.s(R.string.today_heading).uppercase(), style = TextStyle(color = inks.muted, fontSize = 11.sp, fontWeight = FontWeight.Medium), maxLines = 1)
        items.forEach { item ->
            Box(GlanceModifier.fillMaxWidth().height(1.dp).background(inks.line)) {}
            Row(GlanceModifier.fillMaxWidth().height(29.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(clock(ctx, item.startsAtMs), style = TextStyle(color = inks.ink, fontSize = 13.sp, fontWeight = FontWeight.Bold), maxLines = 1, modifier = GlanceModifier.width(58.dp))
                Text(item.title ?: item.label, style = TextStyle(color = inks.ink, fontSize = 13.sp), maxLines = 1)
                item.line?.let { Text("  $it", style = TextStyle(color = inks.muted, fontSize = 12.sp), maxLines = 1) }
            }
        }
    }
}

/**
 * The small square: the time to leave, big, under what it is ("Leave by"),
 * the hills under it, and the bus and its stop along the ground.
 */
@Composable
internal fun SquareLayout(s: Scene, w: Float, h: Float) {
    val ctx = LocalContext.current
    val face = s.face
    val sky = s.look.sky
    val footH = 30f
    val skyH = h - footH - 4f
    val big = face.big
    val stripDp = (skyH * 0.32f).coerceIn(24f, 44f)
    val bitmap = skyBitmap(ctx, s.look, w, skyH, stripDp / 92f, face.road, moon = Offset(30f, 100f))
    val color = when {
        face.dim -> sky.muted
        face.late -> sky.late
        else -> sky.ink
    }
    // The bus and where to catch it; else the leg's words, or the next class.
    val foot = face.journey?.bus?.let { Leg(it.svc, it.color, it.paid, "${it.stop} ${it.board}") } ?: face.leg ?: face.tile?.let { Leg(null, 0, false, it.title) }
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, skyH.dp)
        Column(GlanceModifier.fillMaxSize().padding(horizontal = 12.dp)) {
            Column(GlanceModifier.fillMaxWidth().height(skyH.dp).padding(top = 6.dp)) {
                // Narrow: where you're going, short ("GEA1000"), when the headline has no label of its own to show.
                val head = face.tile?.label ?: face.journey?.place ?: face.heading
                HeadRow(if (big != null && !face.bigFirst) face.bigLabel else head, s, sky, side = 28.dp)
                if (big != null) {
                    Text(big, style = TextStyle(color = color, fontWeight = FontWeight.Bold, fontSize = if (big.length > 6) 30.sp else 38.sp), maxLines = 1)
                    if (face.bigFirst) face.bigLabel?.let { Small(it, sky.muted, 12.sp) }
                } else {
                    // No time in it ("Leave now", "No classes today"): the headline itself, as big as fits.
                    Text(face.headline, style = TextStyle(color = color, fontWeight = FontWeight.Bold, fontSize = if (face.headline.length <= 12) 28.sp else 20.sp), maxLines = 2)
                }
                // Nothing for the ground: the line under the headline goes up here, with room to wrap.
                if (foot == null) face.sub?.let { Small(it, sky.muted, 12.sp, lines = 2, modifier = GlanceModifier.padding(top = 4.dp)) }
            }
            Box(GlanceModifier.fillMaxWidth().height(footH.dp), contentAlignment = Alignment.CenterStart) {
                foot?.let { LegRow(it, s.look.ground, 12.sp) }
            }
        }
    }
}

/** One row tall: the bus's badge, the headline and one line, across the hour's sky. */
@Composable
internal fun BarLayout(s: Scene, w: Float, h: Float) {
    val ctx = LocalContext.current
    val face = s.face
    val sky = s.look.sky
    val bitmap = barBitmap(ctx, s.look, w, h, minOf(110f, w * 0.3f))
    val leg = face.leg
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, h.dp)
        Row(GlanceModifier.fillMaxSize().padding(start = 12.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            leg?.svc?.let {
                Badge(it, leg.color, leg.paid, big = true)
                Spacer(GlanceModifier.width(10.dp))
            }
            Column(GlanceModifier.defaultWeight()) {
                Headline(face, sky, if (h < 70f) 18.sp else 20.sp)
                (if (face.journey?.bus != null || face.sub == null) leg?.text else face.sub)?.let { Small(it, sky.muted, 12.sp) }
            }
            s.refresh?.let { RefreshButton(it, sky) }
        }
    }
}

/**
 * Nearby, as the Buses tab's board: the nearest stop's name big on the sky
 * (the one across the road a tap away), then each service with its badge,
 * where it goes, Live and how full it is, and its minutes big at the end.
 */
@Composable
internal fun BoardLayout(s: Scene, w: Float, h: Float, stops: List<NearbyStop>?, all: List<NearbyStop>?, swap: NearbySwap.Swap?, fetchedAt: Long?, error: String?, json: String?) {
    val ctx = LocalContext.current
    val sky = s.look.sky
    val ground = s.look.ground
    val now = System.currentTimeMillis()
    val age = fetchedAt?.let { (now - it) / 1000 } ?: 0L
    val old = age * 1000 > WidgetModes.NEARBY_OLD_MS
    val first = stops?.firstOrNull()
    val day = h >= 290f
    val chipsH = if (s.chips.isNotEmpty() && !day) 46f else 0f
    val textH = 10f + (if (day) 40f else 0f) + 40f + (if (day) 30f else 24f)
    val skyH = textH + 26f
    val bitmap = skyBitmap(ctx, s.look, w, skyH, 34f / 92f, Road(stop = true, shuttle = false), moon = Offset(if (day) 90f else 110f, if (day) 70f else 28f))
    val rows = ((h - skyH - chipsH - 8f) / 52f).toInt().coerceAtLeast(0)
    Box(GlanceModifier.fillMaxSize()) {
        SkyImage(bitmap, skyH.dp)
        Column(GlanceModifier.fillMaxSize().padding(horizontal = PAD)) {
            Column(GlanceModifier.fillMaxWidth().height(skyH.dp).padding(top = 10.dp)) {
                if (day) {
                    Row(GlanceModifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(GlanceModifier.defaultWeight()) { ModeChips(s.chips, s.showing, sky, s.chipAction) }
                        s.refresh?.let { RefreshButton(it, sky) }
                    }
                }
                val walk = first?.let { if (it.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (it.walkS + 30) / 60) }
                val other = first?.let { NearbySwap.offer(all.orEmpty(), swap, now, listOf(it.code)) }
                Row(GlanceModifier.fillMaxWidth().height(40.dp), verticalAlignment = Alignment.CenterVertically) {
                    Small(listOfNotNull(L.s(R.string.chip_nearby), walk).joinToString(" · "), sky.muted, 12.sp, modifier = GlanceModifier.defaultWeight())
                    if (other != null) SwapButton(other, all!!.first().code, sky)
                    if (!day) s.refresh?.let { RefreshButton(it, sky) }
                }
                val name = when {
                    first != null -> first.longName ?: first.name
                    error == UPDATING || json == null -> L.s(R.string.checking)
                    else -> error ?: L.s(R.string.no_stops_near)
                }
                Text(name, style = TextStyle(color = sky.ink, fontWeight = FontWeight.Bold, fontSize = if (day) 22.sp else 19.sp), maxLines = 1)
            }
            if (first != null) {
                val board = first.board.filter { it.etaS != null }
                when {
                    error == UPDATING -> Small(L.s(R.string.updating), ground.muted, modifier = GlanceModifier.padding(top = 8.dp))
                    old -> Small(L.s(R.string.old_times), ground.muted, modifier = GlanceModifier.padding(top = 8.dp))
                    board.isEmpty() -> Small(if (first.available) L.s(R.string.no_buses_due) else L.s(R.string.no_live_data), ground.muted, modifier = GlanceModifier.padding(top = 8.dp))
                }
                if (!old && error != UPDATING) {
                    val shown = board.take(rows)
                    Column(GlanceModifier.fillMaxWidth()) {
                        shown.forEachIndexed { i, r -> BoardLine(r, age, i > 0, ground) }
                    }
                    // Room left: the next stop's buses under its name, as the Buses tab lists them.
                    val more = ((rows * 52f - shown.size * 52f - 30f) / 52f).toInt()
                    val next = stops.drop(1).firstOrNull { st -> st.board.any { it.etaS != null } }
                    if (more > 0 && next != null) {
                        val nextWalk = if (next.walkS < 60) L.s(R.string.here) else L.s(R.string.min_walk, (next.walkS + 30) / 60)
                        Box(GlanceModifier.fillMaxWidth().height(30.dp).padding(top = 8.dp)) {
                            Small("${next.longName ?: next.name} · $nextWalk", ground.muted, 12.sp, bold = true)
                        }
                        Column(GlanceModifier.fillMaxWidth()) {
                            next.board.filter { it.etaS != null }.take(more).forEachIndexed { i, r -> BoardLine(r, age, i > 0, ground) }
                        }
                    }
                }
            }
            if (chipsH > 0f) {
                Spacer(GlanceModifier.defaultWeight())
                ModeChips(s.chips, s.showing, ground, s.chipAction)
                Spacer(GlanceModifier.height(8.dp))
            }
        }
    }
}

/** The server's words for a time are kept while they're this fresh; then the widget counts down itself. */
private const val SERVER_ETA_S = 30L

/** One service at the stop: its badge, where it goes with Live and how full, and its minutes. */
@Composable
private fun BoardLine(r: BoardRow, ageS: Long, rule: Boolean, inks: Inks) {
    val left = (r.etaS!! - ageS).toInt()
    val eta = r.eta?.takeIf { ageS < SERVER_ETA_S } ?: eta(left.coerceAtLeast(0), r.quality)
    val crowd = when (r.crowd) {
        "low" -> L.s(R.string.buses_seats) to inks.good
        "medium" -> L.s(R.string.buses_busy) to inks.muted
        "high" -> L.s(R.string.buses_packed) to inks.late
        else -> null
    }
    if (rule) Box(GlanceModifier.fillMaxWidth().height(1.dp).background(inks.line)) {}
    Row(GlanceModifier.fillMaxWidth().height(51.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(GlanceModifier.width(46.dp)) { Badge(r.svc, r.color?.let(::parseColor) ?: 0xFF8A939C, r.paid, big = true) }
        Column(GlanceModifier.defaultWeight()) {
            Small(r.toText ?: r.towards.joinToString(", ").ifEmpty { if (r.endsHere) L.s(R.string.buses_ends_here) else r.svc }, inks.ink, 13.sp)
            Row(GlanceModifier.padding(top = 3.dp)) {
                if (r.quality == "live") PillText("● " + L.s(R.string.journey_live), inks.good, inks) else PillText(L.s(R.string.buses_scheduled), inks.muted, inks)
                crowd?.let { (word, color) -> Spacer(GlanceModifier.width(5.dp)); PillText(word, color, inks) }
            }
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(eta, style = TextStyle(color = inks.ink, fontWeight = FontWeight.Bold, fontSize = 20.sp, textAlign = TextAlign.End), maxLines = 1)
            r.laterText?.let { Text(it, style = TextStyle(color = inks.muted, fontSize = 11.sp, textAlign = TextAlign.End), maxLines = 1) }
        }
    }
}

/** Shows the stop across the road first, or the nearest one again. */
@Composable
private fun SwapButton(other: NearbyStop, nearest: String, inks: Inks) {
    Box(
        GlanceModifier
            .size(40.dp)
            .semantics { contentDescription = L.s(R.string.nearby_swap, other.name) }
            .clickable(actionRunCallback<SwapAction>(actionParametersOf(SwapAction.FROM to nearest, SwapAction.TO to other.code))),
        contentAlignment = Alignment.Center,
    ) {
        Box(GlanceModifier.size(32.dp).cornerRadius(16.dp).background(inks.chip), contentAlignment = Alignment.Center) {
            Image(ImageProvider(R.drawable.ic_swap), contentDescription = null, colorFilter = ColorFilter.tint(inks.ink), modifier = GlanceModifier.size(16.dp))
        }
    }
}
