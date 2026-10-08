package sh.rcn.terminus.ui

import android.animation.ValueAnimator
import android.content.Intent
import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import org.maplibre.compose.camera.CameraAnimation
import org.maplibre.compose.camera.CameraPosition
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
import org.maplibre.compose.expressions.value.SymbolAnchor
import org.maplibre.compose.interaction.ClickResult
import org.maplibre.compose.interaction.MapInteractions
import org.maplibre.compose.layers.CircleLayer
import org.maplibre.compose.layers.FeaturesClickHandler
import org.maplibre.compose.layers.LineLayer
import org.maplibre.compose.layers.SymbolLayer
import org.maplibre.compose.map.AndroidRenderMode
import org.maplibre.compose.map.CameraConstraints
import org.maplibre.compose.map.MapUiOptions
import org.maplibre.compose.map.MaplibreMap
import org.maplibre.compose.map.rememberMapState
import org.maplibre.compose.map.renderMode
import org.maplibre.compose.overlay.MapOverlay
import org.maplibre.compose.overlay.include
import org.maplibre.compose.sources.GeoJsonData
import org.maplibre.compose.sources.rememberGeoJsonSource
import org.maplibre.compose.style.BaseStyle
import org.maplibre.compose.util.DpPadding
import org.maplibre.spatialk.geojson.BoundingBox
import org.maplibre.spatialk.geojson.Position
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.Ink
import sh.rcn.terminus.Lang
import sh.rcn.terminus.LiveBus
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapGeoJson
import sh.rcn.terminus.MapStop
import sh.rcn.terminus.R
import sh.rcn.terminus.Slides
import sh.rcn.terminus.Spoken
import kotlin.math.abs

/** The map file's extent (MAP_BOUNDS in apps/api/src/map.ts), with room to spare. */
private val PAN_LIMIT = BoundingBox(west = 103.735, south = 1.26, east = 103.85, north = 1.352)
/** Further than this from campus (in degrees, about 3 km), the map opens on campus, not on you. */
private const val NEAR_CAMPUS_DEG = 0.027

/** Room round the campus's core when the map frames it: the pills are along the top. */
private val CORE_PADDING = DpPadding(left = 24.dp, top = 96.dp, right = 24.dp, bottom = 24.dp)

private fun Long.color() = Color(this.toInt())

/** West, south, east, north (MapData's bounds) as a box for the camera. */
private fun box(b: DoubleArray) = BoundingBox(west = b[0], south = b[1], east = b[2], north = b[3])

/**
 * The Map tab: the campus's streets, every service's line in its colour,
 * the stops, a pill per service along the top (one at a time: its line and
 * live buses), and a sheet for a tapped stop or bus.
 */
@Composable
internal fun MapScreen(map: MapViewModel, onGoThere: (code: String, name: String) -> Unit, places: PlacesForMap, onShowList: (svc: String?, stop: String?) -> Unit = { _, _ -> }) {
    val ui by map.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val dark = isSystemInDarkTheme()
    val zh = Lang.current(ctx) == Lang.ZH
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
    BackHandler(enabled = ui.sheet != null) { map.closeSheet() }
    MapLayout(ui, dark, MapActions(map::choose, map::openStop, map::openBus, map::closeSheet, onGoThere, places, onShowList))
}

/** [block], then again every [ms], while the app is in front. */
private suspend fun Lifecycle.every(ms: Long, block: suspend () -> Unit) = repeatOnLifecycle(Lifecycle.State.RESUMED) {
    while (true) {
        block()
        delay(ms)
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
    /** The Buses tab, on the open stop or the chosen service's line: the map as a list, for a screen reader. */
    val showList: (svc: String?, stop: String?) -> Unit = { _, _ -> },
)

/** The map and everything over it, from [ui] alone. */
@Composable
internal fun MapLayout(ui: MapUi, dark: Boolean, actions: MapActions) {
    val campus = ui.campus
    val style = ui.style
    // "Back to campus": bumped by the button, watched by the map.
    var recentre by remember { mutableStateOf(0) }
    Box(Modifier.fillMaxSize()) {
        when {
            campus != null && style != null -> CampusMapView(ui, campus, style, dark, actions, recentre)
            ui.failed -> Text(
                stringResource(R.string.map_needs_connection),
                modifier = Modifier.align(Alignment.Center).padding(32.dp),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            else -> CircularProgressIndicator(Modifier.align(Alignment.Center))
        }
        if (campus != null) {
            Column(Modifier.statusBarsPadding().padding(top = 8.dp)) {
                Pills(campus, ui.selected, actions.choose)
                ui.busStatus?.let { BusStatusLine(it, ui.selected.orEmpty()) }
                // The feed is down: these are where the buses were last seen.
                if (ui.busesStale) StatusChip(stringResource(R.string.map_buses_stale))
                when {
                    ui.downloading -> StatusChip(stringResource(R.string.map_downloading), busy = true)
                    ui.downloadFailed -> StatusChip(stringResource(R.string.map_download_failed))
                }
            }
            if (ui.sheet == null) {
                // Lost after a pinch or a fling: one tap back to the whole campus.
                SmallFloatingActionButton(
                    onClick = { recentre++ },
                    modifier = Modifier.align(Alignment.BottomEnd).padding(end = 12.dp, bottom = 40.dp),
                    containerColor = MaterialTheme.colorScheme.surface,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Icon(painterResource(R.drawable.ic_recentre), contentDescription = stringResource(R.string.map_recentre))
                }
            }
            ui.sheet?.let { sheet ->
                Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                    when (sheet) {
                        is MapSheet.Stop -> campus.stop(sheet.code)?.let { StopSheet(it, ui, campus, actions) }
                        is MapSheet.Bus -> ui.buses.firstOrNull { it.id == sheet.id }?.let { BusSheet(it, ui.selected.orEmpty(), actions.closeSheet) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CampusMapView(ui: MapUi, campus: CampusMap, style: String, dark: Boolean, actions: MapActions, recentre: Int) {
    val ctx = LocalContext.current
    val ink = if (dark) Color(0xFFF2EFEB) else Color(0xFF1C1917)
    val paper = if (dark) Color(0xFF1A1816) else Color.White
    // What edges the lines and buses. On the light street map a service's own
    // colour (A2's yellow, K's blue) is faint against the white roads: edged
    // in the ink there, so it stands out. In the dark, the paper does that.
    val edge = if (dark) paper else ink
    val edgeAlpha = if (dark) 1f else 0.6f
    val routes = remember(campus) { MapGeoJson.routes(campus) }
    val stops = remember(campus) { MapGeoJson.stops(campus) }

    // Buses slide to each new place along their line (see Slides): a plain
    // holder, not state, redrawn by the frame clock while one moves. With
    // animations off in the phone's settings, they jump.
    // Every answer is planned again, the same list or not, so a bus that
    // hasn't moved for a while still slides when it does. The clock keeps
    // counting while the phone sleeps, so a map left that long is seen as stale.
    val slides = remember(ui.selected) { Slides() }
    var now by remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
    val path = ui.selected?.let { campus.routes[it]?.path }
    LaunchedEffect(ui.busAnswers, ui.buses, slides) {
        slides.update(ui.buses, path, SystemClock.elapsedRealtime(), still = !ValueAnimator.areAnimatorsEnabled())
        do {
            withFrameMillis { now = SystemClock.elapsedRealtime() }
        } while (slides.moving(now))
    }
    val drawn = slides.at(now)
    val color = ui.selected?.let { campus.routes[it]?.color } ?: 0xFF8A939CL
    val buses = MapGeoJson.buses(ui.selected.orEmpty(), color, drawn)
    val me = ui.me?.let { (lat, lon) -> MapGeoJson.me(lat, lon) } ?: MapGeoJson.EMPTY
    // A tapped bus between stops: its stretch, the part of the route it's
    // somewhere on (its midpoint can be a long way from the bus).
    val openBus = (ui.sheet as? MapSheet.Bus)?.let { sheet -> ui.buses.firstOrNull { it.id == sheet.id } }
    val stretch = MapGeoJson.stretch(color, path, openBus?.stretch)
    val stretchOn = stretch != MapGeoJson.EMPTY

    val heading = painterResource(R.drawable.ic_heading)
    // The bus: a disc in the service's colour, ringed in the map's edge. An icon,
    // not a circle, so a bus at a stop can sit beside the dot (its offset is
    // per bus, and turns with the road).
    val busIcon = remember(color, edge) { BusIcon(Color(color), edge) }
    val ringIcon = remember(ink) { RingIcon(ink) }
    val busSize = interpolate(linear(), zoom(), 13 to const(0.64f), 17 to const(1f))
    // Where the buses were last seen, not where they are: faded.
    val busOpacity = const(if (ui.busesStale) 0.4f else 1f)
    val selected = ui.selected
    val state = rememberMapState(baseStyle = BaseStyle.Json(style)) {
        val routeSource = rememberGeoJsonSource(GeoJsonData.JsonString(routes))
        val stopSource = rememberGeoJsonSource(GeoJsonData.JsonString(stops))
        val busSource = rememberGeoJsonSource(GeoJsonData.JsonString(buses))
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
            textHaloWidth = const(1.5.dp),
            // Below the dot, or another side of it when a bus is there.
            textVariableAnchor = const(listOf(const(SymbolAnchor.Top), const(SymbolAnchor.Bottom), const(SymbolAnchor.Right), const(SymbolAnchor.Left))),
            textRadialOffset = const(0.9.em),
            textOptional = const(true),
            textMaxWidth = const(8.em),
            textOpacity = switch(condition(onRoute, const(1f)), fallback = const(0.4f)),
            hitPadding = 4.dp,
            onClick = openNearestStop,
        )
        CircleLayer(id = "me-halo", source = meSource, radius = const(14.dp), color = const(Color(0xFF2B7BF3)), opacity = const(0.18f))
        CircleLayer(id = "me", source = meSource, radius = const(6.5.dp), color = const(Color(0xFF2B7BF3)), strokeColor = const(Color.White), strokeWidth = const(2.5.dp))
        // The tapped bus, ringed. The offset is in the bus's own frame, so
        // the ring turns with the bus too, or it lands beside it.
        SymbolLayer(
            id = "bus-on",
            source = busSource,
            iconOpacity = busOpacity,
            filter = feature["id"].asString() eq const(openBus?.id.orEmpty()),
            iconImage = image(ringIcon, size = DpSize(40.dp, 40.dp)),
            iconSize = busSize,
            iconRotate = feature["heading"].asNumber(),
            iconRotationAlignment = const(IconRotationAlignment.Map),
            iconOffset = feature["offset"].asDpOffset(),
            iconAllowOverlap = const(true),
            iconIgnorePlacement = const(true),
        )
        SymbolLayer(
            id = "buses",
            source = busSource,
            iconOpacity = busOpacity,
            iconImage = image(busIcon, size = DpSize(27.dp, 27.dp)),
            iconSize = busSize,
            iconRotate = feature["heading"].asNumber(),
            iconRotationAlignment = const(IconRotationAlignment.Map),
            iconOffset = feature["offset"].asDpOffset(),
            iconAllowOverlap = const(true),
            // Stop names keep clear of buses (they move to another side of their dot).
            iconIgnorePlacement = const(false),
            hitPadding = 8.dp,
            onClick = { features ->
                features.firstOrNull()?.properties?.get("id")?.toString()?.trim('"')?.let(actions.openBus)
                ClickResult.Consume
            },
        )
        SymbolLayer(
            id = "bus-heading",
            source = busSource,
            iconOpacity = busOpacity,
            iconImage = image(heading, size = DpSize(12.dp, 12.dp)),
            iconSize = busSize,
            iconOffset = feature["offset"].asDpOffset(),
            iconRotate = feature["heading"].asNumber(),
            iconRotationAlignment = const(IconRotationAlignment.Map),
            iconAllowOverlap = const(true),
            iconIgnorePlacement = const(true),
        )
    }

    // First view: your nearest stop when you're on campus, otherwise the whole
    // campus. Once only: back on the tab, the map is where you left it (the
    // camera is saved state, kept by the tabs).
    var framed by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(state) {
        if (framed) return@LaunchedEffect
        framed = true
        // Opened on a stop from Nearby: that's the first view (below).
        if (ui.focus != null) return@LaunchedEffect
        state.fitCameraToBounds(box(campus.coreBounds(ui.core)), fitPadding = CORE_PADDING)
        val at = Locator.lastKnown(ctx) ?: return@LaunchedEffect
        val near = campus.stops.minByOrNull { (it.lat - at.latitude) * (it.lat - at.latitude) + (it.lon - at.longitude) * (it.lon - at.longitude) } ?: return@LaunchedEffect
        if (abs(near.lat - at.latitude) < NEAR_CAMPUS_DEG && abs(near.lon - at.longitude) < NEAR_CAMPUS_DEG) {
            state.setCameraPosition(CameraPosition(target = Position(longitude = near.lon, latitude = near.lat), zoom = 17.0))
        }
    }
    // A stop opened from Nearby: close in, and a little above the middle,
    // so its sheet (over the lower part of the map) doesn't cover it. At
    // zoom 17, 0.0006 degrees of latitude is about a sixth of the screen.
    LaunchedEffect(ui.focus) {
        val stop = ui.focus?.let { campus.stop(it) } ?: return@LaunchedEffect
        state.setCameraPosition(CameraPosition(target = Position(longitude = stop.lon, latitude = stop.lat - 0.0006), zoom = 17.0))
    }
    // Back to campus, from the button.
    LaunchedEffect(recentre) {
        if (recentre == 0) return@LaunchedEffect
        // With animations off in the phone's settings, it jumps there.
        if (ValueAnimator.areAnimatorsEnabled()) state.animateCameraToBounds(box(campus.coreBounds(ui.core)), fitPadding = CORE_PADDING, animation = CameraAnimation.Ease())
        else state.fitCameraToBounds(box(campus.coreBounds(ui.core)), fitPadding = CORE_PADDING)
    }
    // A pill: its whole line in view, when it's chosen (not again on coming back to the tab).
    var framedLine by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(selected) {
        if (selected == framedLine) return@LaunchedEffect
        framedLine = selected
        val r = selected?.let { campus.routes[it] } ?: return@LaunchedEffect
        val padding = DpPadding(left = 40.dp, top = 110.dp, right = 40.dp, bottom = 40.dp)
        if (ValueAnimator.areAnimatorsEnabled()) state.animateCameraToBounds(box(r.bounds()), fitPadding = padding, animation = CameraAnimation.Ease())
        else state.fitCameraToBounds(box(r.bounds()), fitPadding = padding)
    }

    // The map is drawn, and its stops and buses are only reached by a finger
    // on them. To a screen reader it says so, and offers the same as a list:
    // the open stop's board, or the chosen service's line, on the Buses tab.
    val mapLabel = stringResource(R.string.a11y_map)
    val listLabel = stringResource(R.string.a11y_show_list)
    val openStop = (ui.sheet as? MapSheet.Stop)?.code
    MaplibreMap(
        state = state,
        modifier = Modifier.fillMaxSize().semantics {
            contentDescription = mapLabel
            customActions = listOf(CustomAccessibilityAction(listLabel) { actions.showList(selected, openStop); true })
        },
        cameraConstraints = CameraConstraints(minZoom = 13.0, maxZoom = 19.0, boundingBox = PAN_LIMIT),
        // A TextureView, not a SurfaceView: the map fades with the tab around it.
        uiOptions = MapUiOptions { renderMode = AndroidRenderMode.Texture },
        interactions = MapInteractions {
            camera {
                rotate { enabled = false }
                tilt { enabled = false }
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
        overlay = { include(MapOverlay.AttributionOnly) },
    )
}

/** A pill per service: one at a time shows its line and live buses. */
@Composable
private fun Pills(campus: CampusMap, selected: String?, onChoose: (String?) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        for (svc in campus.services) {
            val c = campus.routes[svc]?.color?.color() ?: Color.Gray
            val on = svc == selected
            FilterChip(
                selected = on,
                onClick = { onChoose(svc) },
                label = { Text(svc, fontWeight = FontWeight.SemiBold) },
                leadingIcon = { Box(Modifier.size(10.dp).background(if (on) inkOn(c) else c, CircleShape)) },
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                    selectedContainerColor = c,
                    selectedLabelColor = inkOn(c),
                ),
                elevation = FilterChipDefaults.filterChipElevation(elevation = 2.dp),
            )
        }
    }
}

@Composable
private fun BusStatusLine(status: BusStatus, svc: String) {
    val text = when (status) {
        BusStatus.Finding -> stringResource(R.string.map_finding_buses, svc)
        is BusStatus.Running -> if (status.count == 1) stringResource(R.string.map_one_bus, svc) else stringResource(R.string.map_buses, status.count, svc)
        BusStatus.NoneRunning -> stringResource(R.string.map_no_buses, svc)
        BusStatus.Unavailable -> stringResource(R.string.map_buses_unavailable)
    }
    StatusChip(text)
}

/** A line of status over the map, under the pills. */
@Composable
private fun StatusChip(text: String, busy: Boolean = false) {
    Surface(
        modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp),
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 2.dp,
    ) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            if (busy) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.size(8.dp))
            }
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** White or near-black, whichever reads on a service's colour ([Ink]). */
internal fun inkOn(c: Color): Color = Color(Ink.on(c.toArgb().toLong() and 0xFFFFFFFFL))

/** A service's code on its colour, as on the bus. Also Nearby's, on Now. */
@Composable
internal fun SvcTag(svc: String, color: Color, onClick: (() -> Unit)? = null) {
    val shape = RoundedCornerShape(7.dp)
    val content: @Composable () -> Unit = {
        val said = stringResource(R.string.a11y_bus, svc)
        Text(svc, color = inkOn(color), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge, modifier = Modifier.semantics { contentDescription = said }.padding(horizontal = 8.dp, vertical = 3.dp).widthIn(min = 24.dp))
    }
    if (onClick == null) Surface(shape = shape, color = color, content = content)
    else Surface(onClick = onClick, shape = shape, color = color, content = content)
}

@Composable
private fun SheetSurface(title: String, sub: String?, onClose: () -> Unit, badge: String? = null, content: @Composable () -> Unit) {
    // A pane of its own, named for what's in it, and a screen reader's focus
    // moved to its title when it opens or shows another stop or bus.
    val focus = remember { FocusRequester() }
    LaunchedEffect(title) { runCatching { focus.requestFocus() } }
    Surface(
        modifier = Modifier.fillMaxWidth().heightIn(max = 480.dp).semantics { paneTitle = title },
        shape = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp),
        color = MaterialTheme.colorScheme.surface,
        shadowElevation = 8.dp,
    ) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.focusRequester(focus).focusable().semantics { heading() })
                        // A bus's number plate by its name, like the plate on the bus.
                        badge?.let {
                            Spacer(Modifier.width(8.dp))
                            Surface(shape = RoundedCornerShape(5.dp), border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline), color = Color.Transparent) {
                                Text(it, modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.dp), style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, letterSpacing = 0.5.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                    sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                IconButton(onClick = onClose) {
                    Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.close))
                }
            }
            content()
        }
    }
}

@Composable
private fun crowdWord(c: String?): String? = when (c) {
    "low" -> stringResource(R.string.crowd_low)
    "medium" -> stringResource(R.string.crowd_medium)
    "high" -> stringResource(R.string.crowd_high)
    else -> null
}

@Composable
private fun BusSheet(bus: LiveBus, svc: String, onClose: () -> Unit) {
    val sub = when {
        bus.at != null -> stringResource(R.string.map_bus_at, bus.at)
        bus.stretch != null && bus.nextStop != null -> stringResource(R.string.map_bus_between, bus.stretch.last, bus.nextStop)
        else -> null
    }
    SheetSurface(stringResource(R.string.map_bus_title, svc), sub, onClose, badge = bus.plate) {
        bus.nextStop?.let { SheetRow(stringResource(R.string.map_next_stop), it) }
        crowdWord(bus.crowd)?.let { SheetRow(stringResource(R.string.map_crowding), it) }
    }
}

@Composable
private fun SheetRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.SemiBold)
    }
}

/** Saving a stop as a place, from the account's profile (Settings' favourites). */
internal class PlacesForMap(val savedAs: (code: String) -> String?, val full: () -> Boolean, val save: (code: String, name: String) -> Unit)

@Composable
private fun StopSheet(stop: MapStop, ui: MapUi, campus: CampusMap, actions: MapActions) {
    val places = actions.places
    val ctx = LocalContext.current
    SheetSurface(stop.name, null, actions.closeSheet) {
        val board = ui.board
        when {
            ui.boardFailed -> Text(stringResource(R.string.map_times_need_connection), color = MaterialTheme.colorScheme.onSurfaceVariant)
            board == null -> Text(stringResource(R.string.refreshing), color = MaterialTheme.colorScheme.onSurfaceVariant)
            board.rows.isEmpty() -> Text(stringResource(if (board.available) R.string.map_no_buses_due else R.string.map_no_times), color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                for (r in board.rows) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        SvcTag(r.svc, campus.routes[r.svc]?.color?.color() ?: Color.Gray)
                        Spacer(Modifier.weight(1f))
                        // The server's words ("4 min", "~6 min", "now"); worked out here for an older server.
                        val s = r.etaS ?: 0
                        val min = stringResource(R.string.map_min, s / 60)
                        // Said in words: "about 6 minutes, timetable", where the screen has "~6 min".
                        val said = Spoken.eta(r.etaS, r.quality)
                        Text(
                            r.eta ?: when {
                                s < 60 -> stringResource(R.string.map_arriving)
                                r.quality != "live" -> stringResource(R.string.map_about, min)
                                else -> min
                            },
                            fontWeight = FontWeight.SemiBold,
                            modifier = if (said == null) Modifier else Modifier.semantics { contentDescription = said },
                        )
                    }
                }
            }
        }
        Text(stringResource(R.string.map_services_here), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            for (svc in stop.services) SvcTag(svc, campus.routes[svc]?.color?.color() ?: Color.Gray) { if (ui.selected != svc) actions.choose(svc) }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { actions.goThere(stop.code, stop.name) }) { Text(stringResource(R.string.map_go_there)) }
            OutlinedButton(onClick = {
                val uri = "https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lon}&travelmode=walking".toUri()
                runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, uri)) }
            }) { Text(stringResource(R.string.map_walking_directions)) }
            val saved = places.savedAs(stop.code)
            when {
                saved != null -> OutlinedButton(onClick = {}, enabled = false) { Text(stringResource(R.string.map_saved_as)) }
                places.full() -> OutlinedButton(onClick = {}, enabled = false) { Text(stringResource(R.string.map_places_full)) }
                else -> OutlinedButton(onClick = { places.save(stop.code, stop.name) }) { Text(stringResource(R.string.map_save_place)) }
            }
        }
        Spacer(Modifier.height(4.dp))
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

/** A bus on the map: a disc of [fill], 11 dp across the middle, ringed 2.5 dp in [ring]. */
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
