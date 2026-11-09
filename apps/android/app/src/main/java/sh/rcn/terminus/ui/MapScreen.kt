package sh.rcn.terminus.ui

import android.animation.ValueAnimator
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedIconButton
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.LongState
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameMillis
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.painter.ColorPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.collapse
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.expand
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sqrt
import kotlin.math.tan
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.maplibre.compose.camera.CameraAnimation
import org.maplibre.compose.camera.CameraFit
import org.maplibre.compose.camera.CameraMoveReason
import org.maplibre.compose.camera.CameraPosition
import org.maplibre.compose.camera.CameraUpdate
import org.maplibre.compose.expressions.ast.Expression
import org.maplibre.compose.expressions.dsl.asDpOffset
import org.maplibre.compose.expressions.dsl.asNumber
import org.maplibre.compose.expressions.dsl.asString
import org.maplibre.compose.expressions.dsl.condition
import org.maplibre.compose.expressions.dsl.const
import org.maplibre.compose.expressions.dsl.contains
import org.maplibre.compose.expressions.dsl.convertToColor
import org.maplibre.compose.expressions.dsl.eq
import org.maplibre.compose.expressions.dsl.feature
import org.maplibre.compose.expressions.dsl.image
import org.maplibre.compose.expressions.dsl.interpolate
import org.maplibre.compose.expressions.dsl.linear
import org.maplibre.compose.expressions.dsl.switch
import org.maplibre.compose.expressions.dsl.zoom
import org.maplibre.compose.expressions.value.IconRotationAlignment
import org.maplibre.compose.expressions.value.LineCap
import org.maplibre.compose.expressions.value.LineJoin
import org.maplibre.compose.expressions.value.NumberValue
import org.maplibre.compose.expressions.value.SymbolAnchor
import org.maplibre.compose.interaction.ClickResult
import org.maplibre.compose.interaction.MapInteractions
import org.maplibre.compose.layers.CircleLayer
import org.maplibre.compose.layers.FeaturesClickHandler
import org.maplibre.compose.layers.LineLayer
import org.maplibre.compose.layers.SymbolLayer
import org.maplibre.compose.map.AndroidRenderMode
import org.maplibre.compose.map.CameraConstraints
import org.maplibre.compose.map.MapState
import org.maplibre.compose.map.MapUiOptions
import org.maplibre.compose.map.MaplibreMap
import org.maplibre.compose.map.rememberMapState
import org.maplibre.compose.overlay.LocalViewportInsets
import org.maplibre.compose.overlay.MapOverlay
import org.maplibre.compose.overlay.include
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.style.BaseStyle
import org.maplibre.compose.util.DpPadding
import org.maplibre.compose.util.MaplibreComposable
import org.maplibre.spatialk.geojson.BoundingBox
import org.maplibre.spatialk.geojson.Position
import sh.rcn.terminus.BusStrip
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.Ink
import sh.rcn.terminus.Lang
import sh.rcn.terminus.LiveBus
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapGeoJson
import sh.rcn.terminus.MapStop
import sh.rcn.terminus.PanLimit
import sh.rcn.terminus.Quiet
import sh.rcn.terminus.R
import sh.rcn.terminus.Slides
import sh.rcn.terminus.runningFirst

/** Further than this from campus (in degrees, about 3 km), the map opens on campus, not on you. */
private const val NEAR_CAMPUS_DEG = 0.027

/**
 * Room round the campus's core when the map frames it: [top] is what the pills and any status line under them cover ([MapCover.top], 72 dp
 * before they're measured); [left] is a floating sheet's ([MapCover.left]) and [bottom] the system's gesture bar under a map that runs to
 * the window's foot ([MapCover.inset]).
 */
private fun corePadding(top: Dp = 0.dp, left: Dp = 0.dp, bottom: Dp = 0.dp) =
    DpPadding(left = MARGIN + left, top = MARGIN + topCover(top), right = MARGIN, bottom = MARGIN + bottom)

/** What the pills and any status line under them cover ([MapCover.top]), 72 dp before they're measured. */
private fun topCover(top: Dp) = if (top > 0.dp) top else 72.dp

/** The gap between the campus and whatever's at the map's edge. */
private val MARGIN = 24.dp

/** The gap round a chosen service's line, wider than the campus's so a bus at its end isn't cut off. */
private val LINE_MARGIN = 40.dp

/** The corner the "back to campus" button takes over the map's foot: its 40 dp, the 40 dp under it and a gap. */
private val CORNER = 88.dp

/** [MapCover.framing] for the whole campus (a service's code for its line). */
private const val CAMPUS = "*"

private fun Long.color() = Color(this.toInt())

/** West, south, east, north (MapData's bounds) as a box for the camera. */
private fun box(b: DoubleArray) = BoundingBox(west = b[0], south = b[1], east = b[2], north = b[3])

/**
 * How much of the map is covered, in px from its top and bottom edges: by the pills (and the status lines under them) and by the open sheet
 * across the bottom; or from its left edge, by a sheet floating in the corner ([Widths.floatingSheet]). Plain state read only when the map
 * moves, so a sheet growing redraws nothing.
 */
private class MapCover(framing: MutableState<String?>) {
    var top by mutableIntStateOf(0)
    var sheet by mutableIntStateOf(0)
    var left by mutableIntStateOf(0)

    /** How far up a sheet floating in the corner reaches, in px from the map's foot (0 without one). */
    var floatTop by mutableIntStateOf(0)

    /** The system's bar at the foot, under the map beside a rail (none over the bottom bar, which the map stops at). */
    var inset by mutableIntStateOf(0)

    /**
     * What's framed, with nothing else having moved the map since: the whole campus ([CAMPUS]) or a chosen service's line (its code),
     * framed again when the map's size or what covers it changes ([refitFrame]); null once a finger or a stop has moved it. Saved with the
     * tab, so a map moved before leaving it stays moved.
     */
    var framing by framing

    /** The whole campus is framed ([framing]). */
    var campusOnly: Boolean
        get() = framing == CAMPUS
        set(v) {
            framing = if (v) CAMPUS else null
        }

    /** The first view has been set ([CampusMapView]); till then the pan limits are loose, as the camera starts far out. */
    var started by mutableStateOf(false)

    /** Moves the code is making ([loosened]), during which the pan limits are loose. */
    var moving by mutableIntStateOf(0)

    /**
     * The pan limits are worked out for the zoom the map is at ([PanLimit.centre]), and the map holds every move's centre to them: from
     * further out than where a move ends (the campus from the first view, a stop at 17), on a window wider than a phone, they'd hold it to
     * the middle of the street map, away from campus. So they're loose for [move], from the frame after they're loosened, and worked out
     * again where it ends.
     */
    suspend fun loosened(move: suspend () -> Unit) {
        moving++
        try {
            withFrameNanos {}
            withFrameNanos {}
            move()
            withFrameNanos {}
        } finally {
            moving--
        }
    }

    val loose: Boolean
        get() = !started || moving > 0

    /** [corePadding], clear of the pills and status lines, a floating sheet and the bar at the foot. */
    fun padding(density: Density) = with(density) { corePadding(top.toDp(), left.toDp(), inset.toDp()) }

    /**
     * Room round a chosen service's line, whose [bounds] it is, on a map [size] big: clear of the pills and status lines, an open sheet and
     * the corner button. A sheet floating in the corner leaves two places, beside it and above it; the line goes in whichever shows it
     * bigger, as beside it on a tall window it would have to be smaller than the street map lets the map zoom out.
     */
    fun linePadding(density: Density, size: DpSize?, bounds: DoubleArray): DpPadding =
        with(density) {
            val top = LINE_MARGIN + topCover(top.toDp())
            val foot = LINE_MARGIN + inset.toDp()
            if (left == 0) {
                // A sheet across the foot that leaves under a third of the map (a stop's, on a phone) leaves too little to fit a line
                // in at any zoom the street map allows: the line takes the whole map, all of it in view once the sheet is closed.
                val clear = foot + sheet.toDp()
                val roomy = size == null || size.height - top - clear >= size.height / 3
                return DpPadding(LINE_MARGIN, top, LINE_MARGIN, if (sheet > 0 && roomy) clear else foot + CORNER)
            }
            val beside = DpPadding(LINE_MARGIN + left.toDp(), top, LINE_MARGIN, foot + CORNER)
            val above = DpPadding(LINE_MARGIN, top, LINE_MARGIN, foot + floatTop.toDp())
            if (size == null) return beside
            val wide = bounds[2] - bounds[0]
            val tall = mercator(bounds[3]) - mercator(bounds[1])
            fun scale(p: DpPadding) = minOf((size.width - p.left - p.right).value / wide, (size.height - p.top - p.bottom).value / tall)
            if (scale(above) > scale(beside)) above else beside
        }
}

/** The bar at the foot under a sheet across the bottom, which the sheet's rows keep clear of. */
private val LocalSheetInset = compositionLocalOf { 0.dp }

/** How tall a floating sheet may be: the room under the pills. Null for a sheet across the bottom. */
private val LocalSheetRoom = compositionLocalOf<Dp?> { null }

/**
 * The Map tab: the campus's streets, every service's line in its colour, the stops, a pill per service along the top (one at a time: its
 * line and live buses), and a sheet for a tapped stop or bus.
 */
@Composable
internal fun MapScreen(
    map: MapViewModel,
    onGoThere: (code: String, name: String) -> Unit,
    places: PlacesForMap,
    onShowList: (svc: String?, stop: String?) -> Unit = { _, _ -> },
    bottomInset: Dp = 0.dp,
) {
    val ui by map.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val dark = isSystemInDarkTheme()
    // Read again only when the language changes (it does in place, on Android 13 and later).
    val locales = LocalConfiguration.current.locales
    val zh = remember(locales) { Lang.current(ctx) == Lang.ZH }
    LaunchedEffect(dark, zh) { map.open(dark, zh) }

    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // Live buses every 5 s while a pill is on and the app is in front (the API caches 5 s).
    LaunchedEffect(ui.selected) {
        if (ui.selected == null) return@LaunchedEffect
        lifecycle.every(5_000) { map.refreshBuses() }
    }
    val openStop = (ui.sheet as? MapSheet.Stop)?.code
    // The open stop's arrivals every 15 s (cached 15 s).
    LaunchedEffect(openStop) {
        if (openStop == null) return@LaunchedEffect
        lifecycle.every(15_000) { map.refreshBoard() }
    }
    // Your dot, every 20 s, only with location already allowed.
    LaunchedEffect(Unit) { lifecycle.every(20_000) { map.locate() } }
    BackHandler(enabled = ui.sheet != null) { map.back() }
    MapLayout(
        ui,
        dark,
        MapActions(map::choose, map::openStop, map::openBus, map::closeSheet, onGoThere, places, onShowList, map::showStop),
        home = map.homeTaps,
        bottomInset = bottomInset,
    )
}

/**
 * Close in on [lat], [lon] (zoom 17, or nearer if already), in the middle of what the pills and the sheet leave uncovered ([cover]),
 * gliding there.
 *
 * The sheet is measured a frame after it opens, and grows when its rows arrive: for a moment after, the map follows it, so the place isn't
 * left under it, unless a finger has moved the map since.
 */
@OptIn(FlowPreview::class)
private suspend fun MapState.centreOn(lat: Double, lon: Double, cover: MapCover, density: Density) {
    withFrameNanos {}
    var moved = false
    withTimeoutOrNull(CENTRE_FOLLOW_MS) {
        snapshotFlow { Triple(cover.top, cover.sheet, cover.left) }
            .debounce { if (moved) 200L else 0L }
            .takeWhile { !moved || cameraMoveReason != CameraMoveReason.Gesture }
            .collectLatest { (top, sheet, left) ->
                moved = true
                val view = viewport ?: awaitViewport()
                val h = view.size.height.value.toDouble()
                val (topDp, sheetDp) = with(density) { top.toDp().value.toDouble() to (sheet + cover.inset).toDp().value.toDouble() }
                val zoom = max(view.cameraPosition.zoom, 17.0)
                // How far above the map's middle the uncovered part's middle is,
                // in dp, then in degrees of latitude at that zoom (the world is
                // 512 dp round at zoom 0, its north-south scale cos(lat) of that).
                val up = h / 2 - (topDp + h - sheetDp) / 2
                // And how far right of it, beside a floating sheet, in degrees of longitude.
                val right = with(density) { left.toDp().value.toDouble() } / 2
                val target =
                    Position(
                        longitude = lon - right * 360 / (512 * 2.0.pow(zoom)),
                        latitude = lat - up * 360 / (512 * 2.0.pow(zoom)) * cos(Math.toRadians(lat)),
                    )
                // With animations off in the phone's settings, it jumps there (the library reads the setting).
                animateCamera(CameraUpdate(center = target, zoom = zoom), CameraAnimation.Ease.Standard)
            }
    }
}

/** A floating sheet's margin from the map's edges, and from the pills above it. */
private val FLOAT_GAP = 16.dp

/** How long after moving to a stop the map keeps it clear of its sheet as that grows. */
private const val CENTRE_FOLLOW_MS = 2_500L

/** [block], then again every [ms] (longer while the server asked for a wait), while the app is in front. */
private suspend fun Lifecycle.every(ms: Long, block: suspend () -> Unit) =
    repeatOnLifecycle(Lifecycle.State.RESUMED) {
        while (true) {
            block()
            delay(maxOf(ms, Quiet.waitMs()))
        }
    }

/** What the map's taps do. */
internal class MapActions(
    val choose: (String?) -> Unit,
    val openStop: (String) -> Unit,
    val openBus: (String) -> Unit,
    val closeSheet: () -> Unit,
    val goThere: (code: String, name: String) -> Unit,
    val places: PlacesForMap,
    /** The Stops tab, on the open stop or the chosen service's line: the map as a list, for a screen reader. */
    val showList: (svc: String?, stop: String?) -> Unit = { _, _ -> },
    /** A stop's sheet with the map moved to it, from a bus's sheet ([from]), which back returns to. */
    val showStop: (code: String, from: MapSheet.Bus?) -> Unit = { code, _ -> openStop(code) },
)

/** The map and everything over it, from [ui] alone. */
@Composable
internal fun MapLayout(ui: MapUi, dark: Boolean, actions: MapActions, home: Flow<Unit> = emptyFlow(), bottomInset: Dp = 0.dp) {
    val campus = ui.campus
    val style = ui.style
    // "Back to campus": bumped by the button and by the Map tab tapped again
    // ([home]), watched by the map.
    var recentre by remember { mutableIntStateOf(0) }
    LaunchedEffect(home) { home.collect { recentre++ } }
    val framing = rememberSaveable { mutableStateOf<String?>(CAMPUS) }
    val cover = remember { MapCover(framing) }
    // From 700 wide the sheet floats in the bottom-left corner, beside the map rather than over its foot.
    val floats = Widths.floatingSheet(LocalWindowDp.current)
    val density = LocalDensity.current
    var height by remember { mutableIntStateOf(0) }
    cover.inset = with(density) { bottomInset.roundToPx() }
    LaunchedEffect(ui.sheet == null, floats) {
        if (ui.sheet == null || floats) cover.sheet = 0
        if (ui.sheet == null || !floats) {
            cover.left = 0
            cover.floatTop = 0
        }
    }
    Box(Modifier.fillMaxSize().onSizeChanged { height = it.height }) {
        when {
            campus != null && style != null -> CampusMapView(ui, campus, style, dark, actions, recentre, cover)
            ui.failed ->
                Text(
                    stringResource(R.string.map_needs_connection),
                    modifier = Modifier.align(Alignment.Center).padding(32.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            else -> CircularProgressIndicator(Modifier.align(Alignment.Center))
        }
        if (campus != null) {
            // The pills' bar and the status lines under it, centred over the map.
            Column(
                Modifier.fillMaxWidth()
                    .onSizeChanged { cover.top = it.height }
                    .statusBarsPadding()
                    .padding(start = 8.dp, top = 8.dp, end = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Pills(campus, ui.selected, actions.choose)
                ui.busStatus?.let { BusStatusLine(it, ui.selected.orEmpty()) }
                // The feed is down: these are where the buses were last seen.
                if (ui.busesStale) StatusChip(stringResource(R.string.map_buses_stale))
                when {
                    ui.downloading -> StatusChip(stringResource(R.string.map_downloading), busy = true)
                    ui.downloadFailed -> StatusChip(stringResource(R.string.map_download_failed))
                }
            }
            // Under a sheet across the bottom it would be covered; beside a floating one it stays.
            if (ui.sheet == null || floats) {
                // Lost after a pinch or a fling: one tap back to the whole campus.
                SmallFloatingActionButton(
                    onClick = { recentre++ },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 40.dp + bottomInset),
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Icon(painterResource(R.drawable.ic_recentre), contentDescription = stringResource(R.string.map_recentre))
                }
            }
            ui.sheet?.let { sheet ->
                val gap = with(density) { FLOAT_GAP.roundToPx() }
                Box(
                    if (floats)
                        Modifier.align(Alignment.BottomStart)
                            .padding(start = FLOAT_GAP, top = FLOAT_GAP, end = FLOAT_GAP, bottom = FLOAT_GAP + bottomInset)
                            .width(Widths.PANE.dp)
                            .onSizeChanged {
                                cover.left = it.width + gap
                                cover.floatTop = it.height + gap * 2
                            }
                    else Modifier.align(Alignment.BottomCenter).fillMaxWidth().onSizeChanged { cover.sheet = it.height }
                ) {
                    val room = with(density) { (height - cover.top).toDp() } - FLOAT_GAP * 2 - bottomInset
                    CompositionLocalProvider(
                        LocalSheetRoom provides if (floats) room.coerceAtLeast(120.dp) else null,
                        LocalSheetInset provides if (floats) 0.dp else bottomInset,
                    ) {
                        when (sheet) {
                            is MapSheet.Stop -> campus.stop(sheet.code)?.let { StopSheet(it, ui, campus, actions) }
                            is MapSheet.Bus ->
                                ui.buses
                                    .firstOrNull { it.id == sheet.id }
                                    ?.let { bus ->
                                        val svc = ui.selected.orEmpty()
                                        BusSheet(bus, svc, campus.routes[svc]?.color?.color() ?: Color.Gray, campus, actions, sheet)
                                    }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CampusMapView(ui: MapUi, campus: CampusMap, style: String, dark: Boolean, actions: MapActions, recentre: Int, cover: MapCover) {
    val ctx = LocalContext.current
    val density = LocalDensity.current
    val ink = if (dark) Color(0xFFF2EFEB) else Color(0xFF1C1917)
    val paper = if (dark) Color(0xFF1A1816) else Color.White
    // What edges the lines and buses. On the light street map a service's own
    // colour (A2's yellow, K's blue) is faint against the white roads: edged
    // in the ink there, so it stands out. In the dark, the paper does that.
    val edge = if (dark) paper else ink
    val edgeAlpha = if (dark) 1f else 0.6f
    // Made with the campus, off the main thread (MapViewModel).
    val routes = ui.routesJson
    val stops = ui.stopsJson

    // Buses slide to each new place along their line (see Slides): a plain
    // holder, not state, redrawn by the frame clock while one moves. With
    // animations off in the phone's settings, they jump.
    // Every answer is planned again, the same list or not, so a bus that
    // hasn't moved for a while still slides when it does. The clock keeps
    // counting while the phone sleeps, so a map left that long is seen as stale.
    // The clock is read only in BusLayers, so a frame redraws the buses and
    // not every layer of the map.
    val slides = remember(ui.selected) { Slides() }
    val now = remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    val path = ui.selected?.let { campus.routes[it]?.path }
    LaunchedEffect(ui.busAnswers, ui.buses, slides) {
        slides.update(ui.buses, path, SystemClock.elapsedRealtime(), still = !ValueAnimator.areAnimatorsEnabled())
        do {
            withFrameMillis { now.longValue = SystemClock.elapsedRealtime() }
        } while (slides.moving(now.longValue))
    }
    val color = ui.selected?.let { campus.routes[it]?.color } ?: 0xFF8A939CL
    val me = remember(ui.me) { ui.me?.let { (lat, lon) -> MapGeoJson.me(lat, lon) } ?: MapGeoJson.EMPTY }
    // A tapped bus between stops: its stretch, the part of the route it's
    // somewhere on (its midpoint can be a long way from the bus).
    val openBus = (ui.sheet as? MapSheet.Bus)?.let { sheet -> ui.buses.firstOrNull { it.id == sheet.id } }
    val stretch = remember(color, path, openBus?.stretch) { MapGeoJson.stretch(color, path, openBus?.stretch) }
    val stretchOn = stretch != MapGeoJson.EMPTY

    val heading = painterResource(R.drawable.ic_heading)
    // The bus: a disc in the service's colour, ringed in the map's edge. An icon,
    // not a circle, so a bus at a stop can sit beside the dot (its offset is
    // per bus, and turns with the road).
    val busIcon = remember(color, edge) { BusIcon(Color(color), edge) }
    val ringIcon = remember(ink) { RingIcon(ink) }
    val stopMark = remember { ColorPainter(Color.Transparent) }
    val busSize = interpolate(linear(), zoom(), 13 to const(0.64f), 17 to const(1f))
    // Where the buses were last seen, not where they are: faded.
    val busOpacity = const(if (ui.busesStale) 0.4f else 1f)
    val selected = ui.selected
    val state =
        rememberMapState(baseStyle = BaseStyle.Json(style)) {
            val routeSource = rememberGeoJsonSource(GeoJsonData.JsonString(routes))
            val stopSource = rememberGeoJsonSource(GeoJsonData.JsonString(stops))
            val meSource = rememberGeoJsonSource(GeoJsonData.JsonString(me))
            val stretchSource = rememberGeoJsonSource(GeoJsonData.JsonString(stretch))
            val lineWidth = interpolate(linear(), zoom(), 13 to const(1.5.dp), 16 to const(4.dp), 18 to const(7.dp))
            LineLayer(
                id = "route-casing",
                source = routeSource,
                color = const(edge),
                width = interpolate(linear(), zoom(), 13 to const(3.dp), 16 to const(7.dp), 18 to const(11.dp)),
                opacity = const((if (selected == null) 0.9f else 0.3f) * edgeAlpha),
                cap = const(LineCap.Round),
                join = const(LineJoin.Round),
            )
            LineLayer(
                id = "routes",
                source = routeSource,
                color = feature["color"].asString().convertToColor(),
                width = lineWidth,
                opacity = const(if (selected == null) 0.9f else 0.18f),
                cap = const(LineCap.Round),
                join = const(LineJoin.Round),
            )
            // The chosen service, drawn again on top.
            if (selected != null) {
                LineLayer(
                    id = "route-on",
                    source = routeSource,
                    filter = feature["svc"].asString() eq const(selected),
                    color = feature["color"].asString().convertToColor(),
                    width = interpolate(linear(), zoom(), 13 to const(3.dp), 16 to const(6.dp), 18 to const(9.dp)),
                    opacity = const(if (stretchOn) 0.2f else 1f),
                    cap = const(LineCap.Round),
                    join = const(LineJoin.Round),
                )
            }
            LineLayer(
                id = "stretch-casing",
                source = stretchSource,
                color = const(edge),
                opacity = const(edgeAlpha),
                width = interpolate(linear(), zoom(), 13 to const(7.dp), 16 to const(13.dp), 18 to const(18.dp)),
                cap = const(LineCap.Round),
                join = const(LineJoin.Round),
            )
            LineLayer(
                id = "stretch",
                source = stretchSource,
                color = feature["color"].asString().convertToColor(),
                width = interpolate(linear(), zoom(), 13 to const(5.dp), 16 to const(9.dp), 18 to const(13.dp)),
                cap = const(LineCap.Round),
                join = const(LineJoin.Round),
            )
            // Of the stops a tap takes in, the one nearest the finger.
            val openNearestStop: FeaturesClickHandler = { features ->
                val codes = features.mapNotNull { it.properties?.get("code")?.toString()?.trim('"') }
                campus.nearest(codes, position?.latitude, position?.longitude)?.let(actions.openStop)
                ClickResult.Consume
            }
            val onRoute = if (selected == null) const(true) else feature["services"].asString().contains(" $selected ")
            CircleLayer(
                id = "stops",
                source = stopSource,
                radius = interpolate(linear(), zoom(), 13 to const(2.5.dp), 16 to const(5.5.dp), 18 to const(8.dp)),
                color = const(paper),
                strokeColor = const(ink),
                strokeWidth = interpolate(linear(), zoom(), 13 to const(1.dp), 16 to const(2.dp)),
                opacity = switch(condition(onRoute, const(1f)), fallback = const(0.35f)),
                strokeOpacity = switch(condition(onRoute, const(1f)), fallback = const(0.35f)),
                // About a fingertip: the dots are small.
                hitPadding = 24.dp,
                onClick = openNearestStop,
            )
            SymbolLayer(
                id = "stop-names",
                source = stopSource,
                minZoom = 15f,
                textField = feature["name"].asString(),
                textFont = const(listOf("Noto Sans Medium")),
                textSize = interpolate(linear(), zoom(), 15 to const(11.sp), 18 to const(14.sp)),
                textColor = const(ink),
                textHaloColor = const(paper),
                // Wide enough to part the lines it sits on.
                textHaloWidth = const(2.5.dp),
                // Below the dot, or another side of it when a bus or another stop is there.
                textVariableAnchor = const(listOf(SymbolAnchor.Top, SymbolAnchor.Bottom, SymbolAnchor.Right, SymbolAnchor.Left)),
                textRadialOffset = const(0.9.em),
                textOptional = const(true),
                textMaxWidth = const(8.em),
                textOpacity = switch(condition(onRoute, const(1f)), fallback = const(0.4f)),
                hitPadding = 4.dp,
                onClick = openNearestStop,
            )
            // Each dot again, unseen, for the names to keep off: placed before
            // them (the higher layer goes first), so no name covers another stop.
            SymbolLayer(
                id = "stop-marks",
                source = stopSource,
                minZoom = 15f,
                iconImage = image(stopMark, size = DpSize(16.dp, 16.dp)),
                iconSize = interpolate(linear(), zoom(), 15 to const(0.6f), 18 to const(1f)),
                iconAllowOverlap = const(true),
                iconOpacity = const(0f),
            )
            CircleLayer(id = "me-halo", source = meSource, radius = const(14.dp), color = const(Color(0xFF2B7BF3)), opacity = const(0.18f))
            CircleLayer(
                id = "me",
                source = meSource,
                radius = const(6.5.dp),
                color = const(Color(0xFF2B7BF3)),
                strokeColor = const(Color.White),
                strokeWidth = const(2.5.dp),
            )
            BusLayers(
                BusLook(selected.orEmpty(), color, openBus?.id.orEmpty(), busOpacity, busSize, busIcon, ringIcon, heading),
                slides,
                now,
                actions.openBus,
            )
        }

    var framed by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(state) {
        try {
            if (!framed) {
                framed = true
                firstView(state, ui, campus, ctx, cover)
            }
        } finally {
            if (!cover.campusOnly) cover.started = true
        }
        // A finger moving the map, caught as it does: from then the map stays where it's put, through a fold or a resize too.
        launch { snapshotFlow { state.cameraMoveReason }.collect { if (it == CameraMoveReason.Gesture) cover.campusOnly = false } }
        refitFrame(state, ui, campus, cover, density)
    }
    // A stop opened from Nearby or a bus's sheet: the map glides to it.
    LaunchedEffect(ui.focus) {
        val stop = ui.focus?.let { campus.stop(it) } ?: return@LaunchedEffect
        cover.campusOnly = false
        cover.loosened { state.centreOn(stop.lat, stop.lon, cover, density) }
    }
    // Back from a stop to the bus it was opened from: the map follows, as
    // it went to the stop, so the bus isn't left off screen.
    LaunchedEffect(ui.focusBus) {
        val bus = ui.focusBus?.let { id -> ui.buses.firstOrNull { it.id == id } } ?: return@LaunchedEffect
        cover.campusOnly = false
        cover.loosened { state.centreOn(bus.lat, bus.lon, cover, density) }
    }
    // Back to campus, from the button.
    LaunchedEffect(recentre) {
        if (recentre == 0) return@LaunchedEffect
        cover.campusOnly = false
        // With animations off in the phone's settings, it jumps there (the library reads the setting). Beside a floating sheet, in the
        // part of the map it leaves.
        cover.loosened {
            state.animateCameraToBounds(
                box(campus.coreExtent(ui.core)),
                CameraFit(fitPadding = cover.padding(density)),
                animation = CameraAnimation.Ease.Standard,
            )
        }
        // The whole campus again: fitted again as the window changes, till something moves it.
        cover.campusOnly = true
    }
    // A pill: its whole line in view, when it's chosen (not again on coming back to the tab).
    var framedLine by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(selected) {
        if (selected == framedLine) return@LaunchedEffect
        framedLine = selected
        // A service let go of: its line isn't fitted again; the map stays where it is.
        if (cover.framing != CAMPUS) cover.framing = null
        val r = selected?.let { campus.routes[it] } ?: return@LaunchedEffect
        cover.framing = null
        cover.loosened {
            state.animateCameraToBounds(
                box(r.bounds()),
                CameraFit(fitPadding = cover.linePadding(density, state.viewport?.size, r.bounds())),
                animation = CameraAnimation.Ease.Standard,
            )
        }
        // Fitted again as the window or the sheet changes, till a finger moves it.
        cover.framing = selected
    }

    // The map is drawn, and its stops and buses are only reached by a finger
    // on them. To a screen reader it says so, and offers the same as a list:
    // the open stop's board, or the chosen service's line, on the Stops tab.
    val mapLabel = stringResource(R.string.a11y_map)
    val listLabel = stringResource(R.string.a11y_show_list)
    val openStop = (ui.sheet as? MapSheet.Stop)?.code
    // The screen stays on the street map (PanLimit). Worked out again as the
    // zoom changes, rounded down to a 16th: never past the edge, at the cost
    // of a few pixels short of it.
    val limits by
        remember(state) {
            derivedStateOf {
                val view = state.viewport
                val w = view?.size?.width?.value?.toDouble() ?: 0.0
                val h = view?.size?.height?.value?.toDouble() ?: 0.0
                if (view == null || w <= 0 || h <= 0 || cover.loose)
                    return@derivedStateOf CameraConstraints {
                        minZoom = 13.0
                        maxZoom = 19.0
                        boundingBox = box(PanLimit.EXTENT)
                    }
                // What an open sheet covers, which may show past the street map ([PanLimit.centre]).
                val (west, south) =
                    with(density) { cover.left.toDp().value.toDouble() to (cover.floatTop + cover.sheet).toDp().value.toDouble() }
                val min = max(13.0, PanLimit.minZoom(w, h, west, south))
                val zoom = floor(max(min, view.cameraPosition.zoom) * 16) / 16
                CameraConstraints {
                    minZoom = min
                    maxZoom = 19.0
                    boundingBox = box(PanLimit.centre(w, h, zoom, west, south))
                }
            }
        }
    MaplibreMap(
        state = state,
        modifier =
            Modifier.fillMaxSize().semantics {
                contentDescription = mapLabel
                customActions =
                    listOf(
                        CustomAccessibilityAction(listLabel) {
                            actions.showList(selected, openStop)
                            true
                        }
                    )
            },
        cameraConstraints = limits,
        // A TextureView, not a SurfaceView: the map fades with the tab around it.
        uiOptions = MapUiOptions { renderMode = AndroidRenderMode.Texture },
        interactions =
            MapInteractions {
                camera {
                    rotate { enabled = false }
                    pitch { enabled = false }
                }
                callbacks {
                    // A tap anywhere closes the sheet; a tap on a stop or bus then opens its own.
                    click {
                        onEvent {
                            actions.closeSheet()
                            ClickResult.Pass
                        }
                    }
                }
            },
        // The credit, in the bottom-left corner, moves along to clear a floating sheet there.
        overlay = {
            val insets = LocalViewportInsets.current
            val dir = LocalLayoutDirection.current
            val left = with(LocalDensity.current) { cover.left.toDp() }
            CompositionLocalProvider(
                LocalViewportInsets provides
                    PaddingValues(
                        start = insets.calculateStartPadding(dir) + left,
                        top = insets.calculateTopPadding(),
                        end = insets.calculateEndPadding(dir),
                        bottom = insets.calculateBottomPadding() + with(LocalDensity.current) { cover.inset.toDp() },
                    )
            ) {
                include(MapOverlay.AttributionOnly)
            }
        },
    )
}

/**
 * The map's first view, once ([CampusMapView]'s `framed`): your nearest stop when you're on campus, otherwise the whole campus (fitted by
 * [refitCampus]). Opened on a stop from Nearby, that's the first view. Back on the tab, the map is where you left it (the camera is saved
 * state, kept by the tabs).
 */
private suspend fun firstView(state: MapState, ui: MapUi, campus: CampusMap, ctx: Context, cover: MapCover) {
    if (ui.focus != null) {
        cover.campusOnly = false
        return
    }
    val at = Locator.lastKnown(ctx) ?: return
    val near =
        campus.stops
            .minByOrNull { (it.lat - at.latitude) * (it.lat - at.latitude) + (it.lon - at.longitude) * (it.lon - at.longitude) }
            ?.takeIf { abs(it.lat - at.latitude) < NEAR_CAMPUS_DEG && abs(it.lon - at.longitude) < NEAR_CAMPUS_DEG } ?: return
    cover.campusOnly = false
    cover.loosened { state.setCameraPosition(CameraPosition(center = Position(longitude = near.lon, latitude = near.lat), zoom = 17.0)) }
}

/**
 * What the map frames ([MapCover.framing]: the whole campus, or a chosen service's line) fitted to each size the map takes and each change
 * in what covers it: the map is first measured before the window settles (the rail, the system bars), a fold or a resized window changes it
 * again, a status line under the pills comes and goes, and a stop's sheet opens and grows.
 */
private suspend fun refitFrame(state: MapState, ui: MapUi, campus: CampusMap, cover: MapCover, density: Density) {
    snapshotFlow {
        state.viewport?.size?.let { size ->
            val line = cover.framing?.takeIf { it != CAMPUS }?.let { campus.routes[it]?.bounds() }
            Frame(size, cover.framing, cover.padding(density), line?.let { cover.linePadding(density, size, it) })
        }
    }
        .filterNotNull()
        .filter { it.size.width.value > 0 && it.size.height.value > 0 }
        .distinctUntilChanged()
        .collectLatest { f ->
            val framing = f.framing ?: return@collectLatest
            val (bounds, padding) =
                if (framing == CAMPUS) campus.coreExtent(ui.core) to f.campus
                else (campus.routes[framing]?.bounds() ?: return@collectLatest) to (f.line ?: return@collectLatest)
            cover.loosened { state.fitCameraToBounds(box(bounds), CameraFit(fitPadding = padding)) }
            cover.started = true
        }
}

/** What [refitFrame] fits to: the map's size, what it's framing, and the room round the campus and round a line. */
private data class Frame(val size: DpSize, val framing: String?, val campus: DpPadding, val line: DpPadding?)

/** Web Mercator's northing for [lat], in degrees: how tall a box looks on the map. */
private fun mercator(lat: Double) = Math.toDegrees(ln(tan(Math.PI / 4 + Math.toRadians(lat) / 2)))

/** How the buses are drawn, apart from where: the same from frame to frame. */
private class BusLook(
    val svc: String,
    val color: Long,
    /** The tapped bus, ringed; empty for none. */
    val openId: String,
    val opacity: Expression<NumberValue<Number>>,
    val size: Expression<NumberValue<Number>>,
    val icon: Painter,
    val ring: Painter,
    val heading: Painter,
)

/**
 * The live buses, where [slides] has them at [now]. Its own scope, the only one that reads the frame clock: a sliding bus redraws these
 * three layers, not the routes and stops under them.
 */
@Composable
@MaplibreComposable
private fun BusLayers(look: BusLook, slides: Slides, now: LongState, onOpen: (String) -> Unit) {
    val drawn = slides.at(now.longValue)
    val busSource = rememberGeoJsonSource(GeoJsonData.JsonString(MapGeoJson.buses(look.svc, look.color, drawn)))
    // The tapped bus, ringed. The offset is in the bus's own frame, so
    // the ring turns with the bus too, or it lands beside it.
    SymbolLayer(
        id = "bus-on",
        source = busSource,
        iconOpacity = look.opacity,
        filter = feature["id"].asString() eq const(look.openId),
        iconImage = image(look.ring, size = DpSize(40.dp, 40.dp)),
        iconSize = look.size,
        iconRotate = feature["heading"].asNumber(),
        iconRotationAlignment = const(IconRotationAlignment.Map),
        iconOffset = feature["offset"].asDpOffset(),
        iconAllowOverlap = const(true),
        iconIgnorePlacement = const(true),
    )
    SymbolLayer(
        id = "buses",
        source = busSource,
        iconOpacity = look.opacity,
        iconImage = image(look.icon, size = DpSize(27.dp, 27.dp)),
        iconSize = look.size,
        iconRotate = feature["heading"].asNumber(),
        iconRotationAlignment = const(IconRotationAlignment.Map),
        iconOffset = feature["offset"].asDpOffset(),
        iconAllowOverlap = const(true),
        // Stop names keep clear of buses (they move to another side of their dot).
        iconIgnorePlacement = const(false),
        hitPadding = 8.dp,
        onClick = { features ->
            features.firstOrNull()?.properties?.get("id")?.toString()?.trim('"')?.let(onOpen)
            ClickResult.Consume
        },
    )
    SymbolLayer(
        id = "bus-heading",
        source = busSource,
        iconOpacity = look.opacity,
        iconImage = image(look.heading, size = DpSize(12.dp, 12.dp)),
        iconSize = look.size,
        iconOffset = feature["offset"].asDpOffset(),
        iconRotate = feature["heading"].asNumber(),
        iconRotationAlignment = const(IconRotationAlignment.Map),
        iconAllowOverlap = const(true),
        iconIgnorePlacement = const(true),
    )
}

/**
 * A pill per service, in one bar: one at a time shows its line and live buses. The bar is as wide as its pills, centred; where they don't
 * fit (a phone) it runs the width and scrolls inside itself.
 */
@Composable
private fun Pills(campus: CampusMap, selected: String?, onChoose: (String?) -> Unit) {
    FloatingBar {
        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            for (svc in campus.services) {
                val c = campus.routes[svc]?.color?.color() ?: Color.Gray
                val on = svc == selected
                FilterChip(
                    selected = on,
                    onClick = { onChoose(svc) },
                    label = { Text(svc, fontWeight = FontWeight.SemiBold) },
                    leadingIcon = { Box(Modifier.size(10.dp).background(if (on) inkOn(c) else c, CircleShape)) },
                    shape = CircleShape,
                    // The bar is their background: only the chosen one is filled.
                    colors =
                        FilterChipDefaults.filterChipColors(
                            containerColor = Color.Transparent,
                            labelColor = MaterialTheme.colorScheme.onSurface,
                            selectedContainerColor = c,
                            selectedLabelColor = inkOn(c),
                        ),
                    border = null,
                )
            }
        }
    }
}

/** What floats over the map with the map's buttons, in their look: the pills' bar and the status lines under it. */
@Composable
private fun FloatingBar(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier = modifier, shape = CircleShape, color = MaterialTheme.colorScheme.surface, shadowElevation = 3.dp, content = content)
}

@Composable
private fun BusStatusLine(status: BusStatus, svc: String) {
    val text =
        when (status) {
            BusStatus.Finding -> stringResource(R.string.map_finding_buses, svc)
            is BusStatus.Running ->
                if (status.count == 1) stringResource(R.string.map_one_bus, svc) else stringResource(R.string.map_buses, status.count, svc)
            BusStatus.NoneRunning -> stringResource(R.string.map_no_buses, svc)
            BusStatus.Unavailable -> stringResource(R.string.map_buses_unavailable)
        }
    StatusChip(text)
}

/** A line of status over the map, centred under the pills' bar. */
@Composable
private fun StatusChip(text: String, busy: Boolean = false) {
    FloatingBar(Modifier.padding(top = 8.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(
                text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** White or near-black, whichever reads on a service's colour ([Ink]). */
internal fun inkOn(c: Color): Color = Color(Ink.on(c.toArgb().toLong() and 0xFFFFFFFFL))

/** A service's code on its colour, as on the bus: a stop's services, in its sheet. */
@Composable
internal fun SvcTag(svc: String, color: Color, onClick: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(7.dp)
    val content: @Composable () -> Unit = {
        val said = stringResource(R.string.a11y_bus, svc)
        Text(
            svc,
            color = inkOn(color),
            fontWeight = FontWeight.Bold,
            style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.semantics { contentDescription = said }.padding(horizontal = 8.dp, vertical = 3.dp).widthIn(min = 24.dp),
        )
    }
    if (onClick == null) Surface(shape = shape, color = color, content = content)
    else Surface(onClick = onClick, shape = shape, color = color, content = content)
}

/**
 * The frame a stop's sheet and a bus's share, so the two read alike: a grab handle; a [lead] tile beside the [title], [sub] and close; a
 * line of [facts]; then [body] (a [SectionBand] and its rows); then the [footer]'s buttons.
 *
 * The grab handle does what it promises: dragged down, the sheet follows the finger and, let go, slides off at the finger's speed, as a
 * bottom sheet does; dragged up, it gives a little and springs back. [handle], when set, comes first: a drag up or a tap on the handle
 * opens what it holds (true, or null to toggle), and a drag down closes that (false) before the sheet, returning whether it changed
 * anything.
 */
@Composable
private fun MapSheetFrame(
    paneName: String,
    focusKey: Any,
    title: String,
    sub: String?,
    onClose: () -> Unit,
    lead: @Composable () -> Unit,
    facts: (@Composable () -> Unit)? = null,
    handle: ((Boolean?) -> Boolean)? = null,
    footer: (@Composable RowScope.() -> Unit)? = null,
    body: @Composable ColumnScope.() -> Unit,
) {
    val c = MaterialTheme.colorScheme
    // A pane of its own, named for what's in it, and a screen reader's focus
    // moved to its title when it opens or shows another stop or bus.
    val focus = remember { FocusRequester() }
    // Up past a few dp, [handle] opens; down far enough or flung, [handle]
    // closes, else the sheet does. While dragging down the sheet follows the
    // finger; up, it gives less and less (Fling.rubber). Let go, it carries on
    // from where it is at the finger's speed: off the bottom, or back.
    var dragged by remember { mutableFloatStateOf(0f) }
    var dragging by remember { mutableStateOf(false) }
    // Where this drag took it from: a catch mid-slide starts away from rest, and
    // what decides is how far the finger then moved it, so a catch and let go keeps it.
    var caught by remember { mutableFloatStateOf(0f) }
    val drag = rememberDraggableState { dragged += it }
    val density = LocalDensity.current
    val dragMin = with(density) { 24.dp.toPx() }
    val closeMin = with(density) { 96.dp.toPx() }
    val flingMin = with(density) { 800.dp.toPx() }
    val lift = with(density) { 22.dp.toPx() }
    val settle = remember { Animatable(0f) }
    var height by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    // Another stop or bus opened while this one slides off stays open.
    val showing by rememberUpdatedState(focusKey)
    // Floating, the sheet has no room above it to lift into.
    val room = LocalSheetRoom.current
    val y = { (if (dragging) Fling.rubber(dragged, lift) else settle.value).let { if (room != null) it.coerceAtLeast(0f) else it } }
    LaunchedEffect(focusKey) {
        settle.snapTo(0f)
        runCatching { focus.requestFocus() }
    }
    // No bounce, about 0.3 s, as on the iPhone; done within a pixel, so a closing sheet goes when it's out of sight.
    val motion = spring(Spring.DampingRatioNoBouncy, Spring.StiffnessMediumLow, visibilityThreshold = 1f)
    val surface = c.surface
    Surface(
        modifier =
            Modifier.fillMaxWidth()
                .heightIn(max = room ?: 480.dp)
                .onSizeChanged { height = it.height }
                .offset { IntOffset(0, y().roundToInt()) }
                // Lifted, the sheet's colour carries on under it, so the map doesn't show through below; over the
                // sheet's shadow, which would draw a grey band there.
                .drawWithContent {
                    drawContent()
                    if (y() < 0f) drawRect(surface, Offset(0f, size.height - 1f), Size(size.width, -y() + 1f))
                }
                .semantics { paneTitle = paneName },
        shape = if (room != null) RoundedCornerShape(20.dp) else RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        color = c.surface,
        shadowElevation = 8.dp,
    ) {
        // The rows scroll; the footer's buttons stay in view under them.
        Column(Modifier.animateContentSize().padding(bottom = LocalSheetInset.current)) {
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                Column(
                    Modifier.draggable(
                        drag,
                        Orientation.Vertical,
                        // Caught on its way off or back, at a touch, it stays under the finger from where
                        // it's drawn: the finger first, then the slide stopped.
                        startDragImmediately = settle.isRunning,
                        onDragStarted = {
                            dragged = Fling.unrubber(settle.value, lift)
                            caught = dragged
                            dragging = true
                            settle.stop()
                        },
                        onDragStopped = { velocity ->
                            val d = dragged
                            val moved = d - caught
                            // Drawn where the finger left it, then let go of: no jump.
                            settle.snapTo(Fling.rubber(d, lift))
                            dragging = false
                            dragged = 0f
                            val closing = (d > closeMin && moved > dragMin) || (moved > dragMin && velocity > flingMin)
                            if (closing && handle?.invoke(false) != true) {
                                val mine = focusKey
                                scope.launch {
                                    settle.animateTo(height + lift, motion, initialVelocity = velocity)
                                    if (showing == mine) onClose()
                                }
                            } else {
                                if (moved < -dragMin) handle?.invoke(true)
                                val back = Fling.backSpeed(velocity, d, lift, sqrt(motion.stiffness))
                                scope.launch { settle.animateTo(0f, motion, initialVelocity = back) }
                            }
                        },
                    )
                ) {
                    // The grab handle; the section band does the same for a screen reader.
                    Box(
                        Modifier.fillMaxWidth()
                            .height(20.dp)
                            .then(if (handle != null) Modifier.clearAndSetSemantics {}.clickable { handle(null) } else Modifier),
                        contentAlignment = Alignment.Center,
                    ) {
                        Box(Modifier.size(width = 36.dp, height = 4.dp).background(c.outlineVariant, RoundedCornerShape(2.dp)))
                    }
                    Row(Modifier.padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        lead()
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(
                                title,
                                style = MaterialTheme.typography.titleLarge,
                                fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.focusRequester(focus).focusable().semantics { heading() },
                            )
                            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant) }
                        }
                        IconButton(onClick = onClose) {
                            Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.close))
                        }
                    }
                    if (facts != null) Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp)) { facts() }
                }
                Spacer(Modifier.height(12.dp))
                body()
                if (footer == null) Spacer(Modifier.height(16.dp))
            }
            if (footer != null) {
                HorizontalDivider(color = c.outlineVariant)
                Row(
                    Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    content = footer,
                )
            }
        }
    }
}

/** The tile that leads a sheet's header, the same size for a stop as for a bus. */
@Composable
private fun SheetTile(color: Color, said: String?, content: @Composable () -> Unit) {
    Box(
        Modifier.size(48.dp)
            .background(color, RoundedCornerShape(12.dp))
            .then(if (said != null) Modifier.semantics { contentDescription = said } else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        content()
    }
}

/**
 * A tapped bus: its service, where its line ends and where it is or is going next; its plate, whether it's moving and how full it is; and,
 * dragged or tapped open, the stops ahead of it on a strip of its line. What's ahead is the server's ([LiveBus.upcoming]): the app doesn't
 * walk the route. Its button opens the sheet of the stop it's at or coming to.
 */
@Composable
private fun BusSheet(bus: LiveBus, svc: String, color: Color, campus: CampusMap, actions: MapActions, sheet: MapSheet.Bus) {
    var all by rememberSaveable(bus.id) { mutableStateOf(sheet.all) }
    // How many stops the short list leaves out: what "Show more" adds and "Show
    // fewer" takes away. One alone is just shown, as on a stop's sheet.
    val hidden = BusStrip.of(bus).more.takeIf { it > 1 } ?: 0
    val strip = BusStrip.of(bus, all = all || hidden == 0)
    val where =
        when {
            bus.at != null -> stringResource(R.string.map_bus_at, bus.at)
            bus.nextStop != null -> stringResource(R.string.map_bus_next, bus.nextStop)
            else -> null
        }
    // Where its line ends leads, as a stop's name does; where it is comes under.
    val title = bus.towards?.let { stringResource(R.string.map_bus_towards, it) } ?: where ?: stringResource(R.string.a11y_bus, svc)
    val sub = if (bus.towards != null) where else null
    var expanded by rememberSaveable(bus.id) { mutableStateOf(sheet.stops) }
    // A stop on its line by its code, or by name: the one on this service nearest
    // the bus, as one name can be either side of a road; worked out here for an older server.
    fun stopFor(code: String?, name: String?): MapStop? =
        code?.let(campus::stop)
            ?: name?.let { n ->
                campus
                    .nearest(campus.stops.filter { it.name == n && svc in it.services }.map { it.code }, bus.lat, bus.lon)
                    ?.let(campus::stop)
            }
    // A stop opened from here: its sheet, the map on it, and back returns to this bus as it is.
    val open: (MapStop) -> Unit = { actions.showStop(it.code, MapSheet.Bus(bus.id, stops = expanded, all = all)) }
    val stop = if (bus.at != null) stopFor(strip.hereCode, bus.at) else stopFor(strip.nextCode, bus.nextStop)
    MapSheetFrame(
        paneName = stringResource(R.string.a11y_bus, svc),
        focusKey = bus.id,
        title = title,
        sub = sub,
        onClose = actions.closeSheet,
        lead = { SvcPill(svc, color) },
        facts = { BusFacts(bus) },
        handle =
            if (strip.any)
                ({ open ->
                    val next = open ?: !expanded
                    (next != expanded).also { expanded = next }
                })
            else null,
        footer =
            stop?.let { s ->
                {
                    OutlinedButton(onClick = { open(s) }, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.map_show_stop, s.name))
                    }
                }
            },
    ) {
        if (strip.any) {
            SectionBand(stringResource(R.string.map_bus_stops_ahead), expanded) { expanded = !expanded }
            if (expanded) {
                Spacer(Modifier.height(6.dp))
                BusStripList(strip, color, ::stopFor, open)
                if (hidden > 0) {
                    TextButton(onClick = { all = !all }, modifier = Modifier.padding(start = 4.dp)) {
                        Text(if (all) stringResource(R.string.map_show_fewer) else stringResource(R.string.map_show_more_stops, hidden))
                    }
                }
                Spacer(Modifier.height(6.dp))
            }
        }
    }
}

/** A service's code, large, on its colour: the bus sheet's lead. */
@Composable
private fun SvcPill(svc: String, color: Color) {
    SheetTile(color, stringResource(R.string.a11y_bus, svc)) {
        Text(svc, color = inkOn(color), fontWeight = FontWeight.ExtraBold, fontSize = 20.sp, maxLines = 1)
    }
}

/** The bus's plate, whether it's moving, and how full it is. */
@Composable
private fun BusFacts(bus: LiveBus) {
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        // The number plate, like the one on the bus.
        bus.plate?.let {
            Surface(shape = RoundedCornerShape(5.dp), border = BorderStroke(1.dp, c.outline), color = Color.Transparent) {
                Text(
                    it,
                    modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp),
                    style = MaterialTheme.typography.labelMedium,
                    fontFamily = FontFamily.Monospace,
                    letterSpacing = 0.5.sp,
                    color = muted,
                )
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(8.dp).background(c.outline, CircleShape))
            Spacer(Modifier.width(6.dp))
            Text(
                stringResource(if (bus.moving) R.string.map_bus_moving else R.string.map_bus_stopped),
                style = MaterialTheme.typography.bodyMedium,
                color = muted,
            )
        }
        val level =
            when (bus.crowd) {
                "low" -> 1
                "medium" -> 2
                "high" -> 3
                else -> 0
            }
        if (level > 0) {
            val word =
                stringResource(
                    when (level) {
                        1 -> R.string.buses_seats
                        2 -> R.string.buses_busy
                        else -> R.string.buses_packed
                    }
                )
            val fill =
                when (level) {
                    1 -> goodColor()
                    2 -> c.tertiary
                    else -> c.error
                }
            Row(verticalAlignment = Alignment.CenterVertically) {
                // Three rising bars, as many filled as it's full; the word says it.
                Row(
                    Modifier.clearAndSetSemantics {},
                    horizontalArrangement = Arrangement.spacedBy(2.dp),
                    verticalAlignment = Alignment.Bottom,
                ) {
                    for ((i, h) in listOf(6.dp, 10.dp, 14.dp).withIndex()) {
                        Box(
                            Modifier.size(width = 4.dp, height = h)
                                .background(if (i < level) fill else c.outlineVariant, RoundedCornerShape(1.dp))
                        )
                    }
                }
                Spacer(Modifier.width(6.dp))
                Text(word, style = MaterialTheme.typography.bodyMedium, color = muted)
            }
        }
    }
}

/**
 * A grey band naming what's under it, the same on a stop's sheet ("Buses here") as on a bus's ("Stops ahead"). With [onToggle], it opens
 * and closes what's under it, and a chevron says so.
 */
@Composable
private fun SectionBand(text: String, expanded: Boolean = true, onToggle: (() -> Unit)? = null) {
    val c = MaterialTheme.colorScheme
    val turn by animateFloatAsState(if (expanded) -90f else 90f, label = "chevron")
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 44.dp)
            .background(c.surfaceContainerHigh)
            .then(
                if (onToggle == null) Modifier.semantics { heading() }
                else
                    Modifier.clickable(role = Role.Button, onClick = onToggle).semantics {
                        if (expanded)
                            collapse {
                                onToggle()
                                true
                            }
                        else
                            expand {
                                onToggle()
                                true
                            }
                    }
            )
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant, modifier = Modifier.weight(1f))
        // The chevron is mirrored right to left, so it turns the other way there.
        if (onToggle != null)
            Icon(
                painterResource(R.drawable.ic_chevron),
                contentDescription = null,
                tint = c.onSurfaceVariant,
                modifier = Modifier.rotate(if (rtl) -turn else turn),
            )
    }
}

/** One row of the strip: what's on the line beside it. */
private enum class StripMark {
    Passed,
    Bus,
    Here,
    Next,
    Ahead,
}

/** The stops ahead of a bus as a strip of its line, the bus on it. */
@Composable
private fun BusStripList(strip: BusStrip, color: Color, stopFor: (code: String?, name: String) -> MapStop?, onStop: (MapStop) -> Unit) {
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    Column(Modifier.padding(horizontal = 16.dp)) {
        val openLabel = stringResource(R.string.map_open_stop)
        // Each row: what's on the line beside it, the stop's name and its code.
        val rows = buildList {
            strip.passed?.let { add(Triple(StripMark.Passed, it, strip.passedCode)) }
            if (strip.between) add(Triple(StripMark.Bus, null, null)) else add(Triple(StripMark.Here, strip.here, strip.hereCode))
            strip.next?.let { add(Triple(StripMark.Next, it, strip.nextCode)) }
            strip.after.forEachIndexed { j, s -> add(Triple(StripMark.Ahead, s, strip.afterCodes.getOrNull(j))) }
        }
        rows.forEachIndexed { i, (mark, name, code) ->
            val first = i == 0
            val last = i == rows.lastIndex && strip.more == 0
            // Passed, here and next are drawn on the line (grey, the bus, bold),
            // not written beside it; a screen reader still hears the word.
            val said =
                when (mark) {
                    StripMark.Passed -> stringResource(R.string.map_bus_passed)
                    StripMark.Here -> stringResource(R.string.map_bus_here)
                    StripMark.Next -> stringResource(R.string.map_bus_next_tag)
                    else -> null
                }
            // A stop's row opens its sheet, and its chevron says so: only one found
            // on the map, and not the bus's own row.
            val stop = if (name != null && mark != StripMark.Bus) stopFor(code, name) else null
            val tap = if (stop != null) Modifier.clickable(role = Role.Button, onClickLabel = openLabel) { onStop(stop) } else Modifier
            Row(
                Modifier.fillMaxWidth().height(if (mark == StripMark.Next || mark == StripMark.Here) 44.dp else 40.dp).then(tap).semantics(
                    mergeDescendants = true
                ) {
                    if (said != null) stateDescription = said
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StripRail(color, mark, first, last)
                Spacer(Modifier.width(10.dp))
                when (mark) {
                    StripMark.Bus ->
                        Text(
                            stringResource(R.string.map_bus_on_its_way),
                            style = MaterialTheme.typography.bodyMedium,
                            color = muted,
                            modifier = Modifier.weight(1f),
                        )
                    else ->
                        Text(
                            name.orEmpty(),
                            style =
                                if (mark == StripMark.Next || mark == StripMark.Here) MaterialTheme.typography.titleMedium
                                else MaterialTheme.typography.bodyLarge,
                            fontWeight = if (mark == StripMark.Next || mark == StripMark.Here) FontWeight.Bold else null,
                            color = if (mark == StripMark.Passed) muted.copy(alpha = 0.7f) else c.onSurface,
                            maxLines = 1,
                            modifier = Modifier.weight(1f),
                        )
                }
                if (stop != null)
                    Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
            }
        }
        if (strip.more > 0) {
            // The line fading out: it goes on, and the button under it shows the rest.
            Row(Modifier.fillMaxWidth().height(16.dp).clearAndSetSemantics {}) {
                StripRail(color, null, first = false, last = true)
            }
        }
    }
}

/**
 * The line beside one row of the strip, in the service's [color] (grey up to the bus, where it's been), and the row's stop dot or the bus.
 * [mark] null: just the line, fading out ("+3 more"). As the Stops tab's line, smaller.
 */
@Composable
private fun StripRail(color: Color, mark: StripMark?, first: Boolean, last: Boolean) {
    val paper = MaterialTheme.colorScheme.surface
    val been = MaterialTheme.colorScheme.outlineVariant
    Canvas(Modifier.width(20.dp).fillMaxHeight()) {
        val x = size.width / 2
        val y = size.height / 2
        val w = 3.dp.toPx()
        // Above the bus (the passed stop's row, and the bus's own top half) is grey.
        val above = if (mark == StripMark.Passed || mark == StripMark.Bus || mark == StripMark.Here) been else color
        val below = if (mark == StripMark.Passed) been else color
        // Just the line, fading out: drawn faint alone, not over a solid one.
        if (mark == null) {
            if (!first) drawLine(color.copy(alpha = 0.35f), Offset(x, 0f), Offset(x, size.height / 2), w)
            return@Canvas
        }
        if (!first) drawLine(above, Offset(x, 0f), Offset(x, y), w)
        if (!last) drawLine(below, Offset(x, y), Offset(x, size.height), w)
        when (mark) {
            StripMark.Bus,
            StripMark.Here -> {
                drawCircle(paper, 9.dp.toPx(), Offset(x, y))
                drawCircle(color, 7.dp.toPx(), Offset(x, y))
            }
            else -> {
                val r = if (mark == StripMark.Next) 6.dp.toPx() else 4.5.dp.toPx()
                val ring = if (mark == StripMark.Passed) been else color
                drawCircle(paper, r, Offset(x, y))
                drawCircle(ring, r, Offset(x, y), style = Stroke(if (mark == StripMark.Next) 3.dp.toPx() else 2.dp.toPx()))
            }
        }
    }
}

/** Saving a stop as a place, or taking it off again, from the account's profile (Settings' favourites). */
internal class PlacesForMap(
    val savedAs: (code: String) -> String?,
    val full: () -> Boolean,
    val save: (code: String, name: String) -> Unit,
    val remove: (code: String) -> Unit,
)

/** The rows a stop's sheet shows before "Show more", so the map stays in view. */
private const val PEEK_ROWS = 3

/**
 * A stop: its board as the Stops tab has it, the first few rows until asked for the rest, and ways to go there. A row tapped shows its
 * service on the map.
 */
@Composable
private fun StopSheet(stop: MapStop, ui: MapUi, campus: CampusMap, actions: MapActions) {
    val places = actions.places
    val ctx = LocalContext.current
    val c = MaterialTheme.colorScheme
    var all by remember(stop.code) { mutableStateOf(false) }
    MapSheetFrame(
        paneName = stop.name,
        focusKey = stop.code,
        title = stop.name,
        sub = stop.longName?.takeIf { it != stop.name },
        onClose = actions.closeSheet,
        // A stop's tile, where a bus's has its service: the two headers line up.
        lead = {
            SheetTile(c.surfaceVariant, null) { Icon(painterResource(R.drawable.ic_pin), contentDescription = null, tint = c.onSurface) }
        },
        footer = {
            Button(onClick = { actions.goThere(stop.code, stop.name) }, modifier = Modifier.weight(1f)) {
                Text(stringResource(R.string.map_go_there))
            }
            OutlinedIconButton(
                onClick = {
                    val uri = "https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}&travelmode=walking".toUri()
                    runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                }
            ) {
                Icon(painterResource(R.drawable.ic_walk), contentDescription = stringResource(R.string.map_walking_directions))
            }
            val saved = places.savedAs(stop.code) != null
            val full = !saved && places.full()
            OutlinedIconButton(
                onClick = { if (saved) places.remove(stop.code) else places.save(stop.code, stop.name) },
                enabled = saved || !full,
            ) {
                Icon(
                    painterResource(if (saved) R.drawable.ic_star_filled else R.drawable.ic_star),
                    contentDescription =
                        stringResource(
                            if (saved) R.string.map_remove_place else if (full) R.string.map_places_full else R.string.map_save_place
                        ),
                    tint = if (saved) c.primary else LocalContentColor.current,
                )
            }
        },
    ) {
        SectionBand(stringResource(R.string.map_buses_here))
        val board = ui.board
        val note =
            when {
                ui.boardFailed -> R.string.map_times_need_connection
                // Down or busy: not "no times", which would say no buses are coming.
                ui.boardError -> R.string.map_times_failed
                board == null -> R.string.refreshing
                board.rows.isEmpty() -> if (board.available) R.string.map_no_buses_due else R.string.map_no_times
                else -> null
            }
        if (note != null || board == null) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(note ?: R.string.refreshing), color = c.onSurfaceVariant)
                // No times to list them by: the services here, each showing its line.
                if (note != R.string.refreshing) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (svc in stop.services) SvcTag(svc, campus.routes[svc]?.color?.color() ?: Color.Gray) {
                            if (ui.selected != svc) actions.choose(svc)
                        }
                    }
                }
            }
        } else {
            val rows = runningFirst(board.rows)
            val more = rows.size - PEEK_ROWS
            val colors = remember(campus) { campus.routes.mapValues { it.value.color } }
            BoardRows(
                if (all || more <= 1) rows else rows.take(PEEK_ROWS),
                colors,
                compact = true,
                clickLabel = { stringResource(R.string.on_the_map, it) },
                // A row picks its line here, as the pills do, and again unpicks it.
                picked = Picked(ui.selected),
            ) {
                actions.choose(if (ui.selected == it.svc) null else it.svc)
            }
            if (more > 1) {
                HorizontalDivider(color = c.outlineVariant)
                TextButton(onClick = { all = !all }, modifier = Modifier.padding(start = 4.dp)) {
                    Text(if (all) stringResource(R.string.map_show_fewer) else stringResource(R.string.map_show_more, more))
                }
            }
        }
    }
}

/** The tapped bus's ring, in the map's ink, a little way out from the bus. */
private class RingIcon(private val ink: Color) : Painter() {
    override val intrinsicSize: Size = Size.Unspecified

    override fun DrawScope.onDraw() {
        val stroke = size.minDimension * 2.5f / 40f
        drawCircle(ink, radius = size.minDimension * 16.5f / 40f, style = Stroke(stroke))
    }

    override fun equals(other: Any?) = other is RingIcon && other.ink == ink

    override fun hashCode() = ink.hashCode()
}

/** A bus on the map: a disc of [fill], 22 dp across the middle, ringed 2.5 dp in [ring]. */
private class BusIcon(private val fill: Color, private val ring: Color) : Painter() {
    override val intrinsicSize: Size = Size.Unspecified

    override fun DrawScope.onDraw() {
        val r = size.minDimension / 2
        drawCircle(ring, radius = r)
        drawCircle(fill, radius = r * 22f / 27f)
    }

    override fun equals(other: Any?) = other is BusIcon && other.fill == fill && other.ring == ring

    override fun hashCode() = fill.hashCode() * 31 + ring.hashCode()
}
