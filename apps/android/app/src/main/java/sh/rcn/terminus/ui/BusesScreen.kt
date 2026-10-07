package sh.rcn.terminus.ui

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.rcn.terminus.Board
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.BusHit
import sh.rcn.terminus.BusTimes
import sh.rcn.terminus.L
import sh.rcn.terminus.Line
import sh.rcn.terminus.LineBus
import sh.rcn.terminus.LineItem
import sh.rcn.terminus.Locator
import sh.rcn.terminus.Pins
import sh.rcn.terminus.Stopped
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseColor
import sh.rcn.terminus.searchBuses
import sh.rcn.terminus.busesTabIndex

/** How often the page in view is refreshed: the API's own cache, so sooner shows nothing new. */
private const val REFRESH_MS = 15_000L

/**
 * The Buses tab: a search, then pages to swipe between, the nearest stop
 * and each pinned one, each with its board. A row opens its service's
 * line; a stop on the line, or found in the search, opens its board.
 *
 * Only the times the API gives are shown: the next bus and its `later`
 * buses. A timetabled time says so; no time is guessed.
 */
@Composable
internal fun BusesScreen(
    vm: BusesViewModel,
    insets: PaddingValues,
    pins: List<String>,
    onPin: (String) -> Unit,
    onShowOnMap: (String) -> Unit,
    publicBuses: Boolean = false,
    pinLimit: Int = sh.rcn.terminus.Limits.DEFAULT.pinnedStops,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    // Before the boards below ask, so the first ones have them too.
    vm.publicBuses = publicBuses
    vm.pinLimit = pinLimit
    LaunchedEffect(Unit) { vm.loadCampus() }
    val top = state.stack.lastOrNull()
    BackHandler(enabled = top != null) { vm.back() }
    // The sky runs up under the status bar; each page keeps the room for it inside its band.
    val bar = insets.calculateTopPadding()
    Box(Modifier.fillMaxSize().padding(bottom = insets.calculateBottomPadding())) {
        when (top) {
            null -> Home(state, vm, pins, onPin, bar)
            is BusRoute.Stop -> StopRoute(state, vm, top.code, pins, onPin, bar)
            is BusRoute.Line -> LineRoute(state, vm, top, onShowOnMap, bar)
        }
    }
}

/** Runs [refresh] now and every 15 s while this is on screen and the app is in front. */
@Composable
private fun Refreshing(vararg keys: Any?, refresh: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latest by rememberUpdatedState(refresh)
    LaunchedEffect(*keys) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                latest()
                delay(REFRESH_MS)
            }
        }
    }
}

/** The clock, a tick a second, for "Updated 5 s ago". */
@Composable
private fun ticking(): Long {
    val now by produceState(ServerClock.now()) {
        while (true) {
            delay(1_000)
            value = ServerClock.now()
        }
    }
    return now
}

@Composable
private fun Home(state: BusesUi, vm: BusesViewModel, pins: List<String>, onPin: (String) -> Unit, top: Dp) {
    var query by rememberSaveable { mutableStateOf("") }
    BackHandler(enabled = query.isNotEmpty()) { query = "" }
    val pages = Pins.pages(state.nearest?.code, pins)
    // The sky stays and what's in it changes: the stop's name swipes in the
    // band, its board under it, the two pagers kept together.
    val heads = rememberPagerState { pages.size }
    val boards = rememberPagerState { pages.size }
    LaunchedEffect(heads, boards) {
        snapshotFlow { Triple(heads.isScrollInProgress, heads.currentPage, heads.currentPageOffsetFraction) }.collect { (moving, page, off) ->
            if (moving && !boards.isScrollInProgress) boards.scrollToPage(page, off)
        }
    }
    LaunchedEffect(heads, boards) {
        snapshotFlow { Triple(boards.isScrollInProgress, boards.currentPage, boards.currentPageOffsetFraction) }.collect { (moving, page, off) ->
            if (moving && !heads.isScrollInProgress) heads.scrollToPage(page, off)
        }
    }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize()) {
        // The dots' line has room for the moon on the right.
        // Searching, just the field over the hills, so the results start right under it.
        SkyBand(skyPhase(), top, moonLow = true, moonLine = query.isBlank() && pages.size <= 1, padded = false, moon = query.isBlank()) {
            Column {
                SearchBox(query, { query = it }, Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
                if (query.isBlank()) {
                    // Every header composed, so the band is as tall as the longest name and doesn't jump.
                    HorizontalPager(heads, Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top, beyondViewportPageCount = pages.size, key = { pages.getOrNull(it) ?: "nearest" }) { i ->
                        Box(Modifier.padding(horizontal = 16.dp)) { PageHeader(state, i, pages.getOrNull(i), pins, vm, onPin) }
                    }
                    if (pages.size > 1) Dots(pages.size, boards.currentPage, nearestFirst = true)
                }
            }
        }
        if (query.isNotBlank()) {
            SearchResults(state, query) { hit ->
                query = ""
                vm.open(
                    when (hit) {
                        is BusHit.Service -> BusRoute.Line(hit.svc, null)
                        is BusHit.Stop -> BusRoute.Stop(hit.code)
                    },
                )
            }
            return@Column
        }
        val shown = pages.getOrNull(boards.settledPage)
        // The page in view only: swiping past one doesn't ask for it. The
        // nearest stop's twin comes with it, so across the road costs nothing more.
        val first = boards.settledPage == 0
        Refreshing(if (first) null else shown, first, state.across) { vm.refreshPage(if (first) null else shown) }
        HorizontalPager(boards, Modifier.fillMaxWidth().weight(1f), verticalAlignment = Alignment.Top, key = { pages.getOrNull(it) ?: "nearest" }) { i ->
            val code = pages.getOrNull(i)
            val next = pages.getOrNull(i + 1)?.let { stopName(state, it) }
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
                if (i == 0 && code == null) NoNearest(state, vm)
                else if (code != null) StopBody(state, vm, code)
                if (next != null) SwipeFor(next) { scope.launch { boards.animateScrollToPage(i + 1) } }
            }
        }
    }
}

/** Page [i]'s header in the sky: the nearest stop ([code] null until it's known) or a pinned one. */
@Composable
private fun PageHeader(state: BusesUi, i: Int, code: String?, pins: List<String>, vm: BusesViewModel, onPin: (String) -> Unit) {
    if (code == null) {
        Column(Modifier.padding(top = 8.dp)) {
            Text(stringResource(R.string.buses_nearest), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                stringResource(if (state.nearestState == Nearest.Loading) R.string.checking else R.string.buses_find_title),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.ExtraBold,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        return
    }
    val board = state.boards[code]
    val label = if (i == 0) {
        if (!state.located) stringResource(R.string.buses_near_home)
        else board?.distM?.let { stringResource(R.string.buses_nearest_m, it) } ?: stringResource(R.string.buses_nearest)
    } else stringResource(R.string.buses_pinned)
    val plain = if (i == 0) stringResource(if (state.located) R.string.buses_nearest else R.string.buses_near_home) else label
    StopHeader(state, vm, code, label, plain, nearest = i == 0 && state.located, pins = pins, onPin = onPin)
}

/** A stop's name before its board is here: from the campus data, else its code. */
private fun stopName(state: BusesUi, code: String) = state.boards[code]?.name ?: state.campus?.stop(code)?.fullName ?: code

@Composable
private fun SearchBox(query: String, onQuery: (String) -> Unit, modifier: Modifier) {
    val focus = LocalFocusManager.current
    TextField(
        value = query,
        onValueChange = onQuery,
        // A label, not only a placeholder: it keeps the field's name once something's typed.
        label = { Text(stringResource(R.string.buses_search)) },
        leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon = if (query.isEmpty()) null else {
            { IconButton(onClick = { onQuery(""); focus.clearFocus() }) { Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.close)) } }
        },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        shape = RoundedCornerShape(16.dp),
        colors = TextFieldDefaults.colors(
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            // The sky's glass, so the hour shows through it.
            focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
private fun SearchResults(state: BusesUi, query: String, onPick: (BusHit) -> Unit) {
    val campus = state.campus
    val index = remember(campus) { campus?.let(::busesTabIndex).orEmpty() }
    val hits = remember(index, query) { searchBuses(query, index) }
    val colors = campus?.routes?.mapValues { it.value.color }.orEmpty()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
        if (hits.isEmpty() && campus != null) {
            Text(stringResource(R.string.buses_search_none), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
        }
        var group: Boolean? = null
        for (hit in hits) {
            val isService = hit is BusHit.Service
            if (group != isService) {
                group = isService
                Label(stringResource(if (isService) R.string.buses_group_services else R.string.group_stops), Modifier.padding(top = 12.dp, bottom = 4.dp))
            }
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { onPick(hit) }.padding(vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                when (hit) {
                    is BusHit.Service -> {
                        SvcChip(hit.svc, colors[hit.svc] ?: GREY)
                        val n = campus?.stops?.count { hit.svc in it.services } ?: 0
                        if (n > 0) Text(stringResource(R.string.buses_n_stops, n), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    is BusHit.Stop -> Column(Modifier.weight(1f)) {
                        Text(hit.name, fontWeight = FontWeight.SemiBold)
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 3.dp)) {
                            Text(hit.code, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            for (svc in hit.services) BusBadge(svc, colors[svc] ?: GREY, 11.sp, pad = 5.dp)
                        }
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

/** Page one without a nearest stop: no location and no home stop. */
@Composable
private fun NoNearest(state: BusesUi, vm: BusesViewModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
        scope.launch { vm.refreshNearest(force = true) }
    }
    Column(Modifier.padding(top = 16.dp)) {
        when (state.nearestState) {
            Nearest.Loading -> {}
            Nearest.Failed -> {
                Text(stringResource(R.string.cant_reach), color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { scope.launch { vm.refreshNearest(force = true) } }) { Text(stringResource(R.string.try_again)) }
            }
            else -> LinkTile(null, Modifier.fillMaxWidth()) {
                Text(
                    stringResource(if (hasLocation) R.string.buses_find_text_search else R.string.buses_find_text),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp),
                )
                if (!hasLocation) {
                    TextButton(onClick = { ask.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }) {
                        Text(stringResource(R.string.allow_location))
                    }
                }
            }
        }
    }
}

/** A stop opened from the search or a line: its page, with Back. */
@Composable
private fun StopRoute(state: BusesUi, vm: BusesViewModel, code: String, pins: List<String>, onPin: (String) -> Unit, top: Dp) {
    Refreshing(code, state.across) { vm.refreshPage(code) }
    Column(Modifier.fillMaxSize()) {
        // Back, and the stop, in the sky, as on the tab's own pages.
        SkyBand(skyPhase(), top, moonLow = true) {
            Column {
                BackRow(stringResource(R.string.back)) { vm.back() }
                val label = if (code in pins) stringResource(R.string.buses_pinned) else null
                StopHeader(state, vm, code, label, label, nearest = false, pins = pins, onPin = onPin)
            }
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
            StopBody(state, vm, code)
        }
    }
}

@Composable
private fun BackRow(text: String, trailing: @Composable () -> Unit = {}, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Row(
            Modifier.weight(1f, fill = false).clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button, onClick = onBack).padding(vertical = 8.dp, horizontal = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(painterResource(R.drawable.ic_back), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            Text(text, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        trailing()
    }
}

/**
 * One stop's page: what it is ("Nearest stop · 40 m", "Pinned"), its name,
 * the star, this side or across the road, and the board.
 */
/**
 * A stop's header, in the sky: what it is ("Nearest stop · 40 m",
 * "Pinned"), its name, its code and the star. Across the road, the stop
 * shown is the twin, and the star is for that one.
 */
@Composable
private fun StopHeader(
    state: BusesUi,
    vm: BusesViewModel,
    code: String,
    label: String?,
    /** The label across the road, where the distance is the other stop's. */
    plainLabel: String?,
    nearest: Boolean,
    pins: List<String>,
    onPin: (String) -> Unit,
) {
    val own = state.boards[code]
    val opposite = own?.opposite
    val across = opposite != null && code in state.across
    val shownCode = if (across) opposite else code
    val board = state.boards[shownCode]
    val c = MaterialTheme.colorScheme
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            if (label != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (nearest) Icon(painterResource(R.drawable.ic_near), contentDescription = null, tint = smallAccent(), modifier = Modifier.size(14.dp))
                    Text(if (across) plainLabel.orEmpty() else label, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                }
            }
            Text(
                board?.name ?: stopName(state, shownCode),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.ExtraBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 2.dp).semantics { heading() },
            )
            Text(shownCode, style = MaterialTheme.typography.labelMedium, color = c.onSurfaceVariant, letterSpacing = 0.8.sp)
        }
        val starOn = shownCode in pins
        val ctx = LocalContext.current
        IconButton(
            onClick = {
                if (!starOn && pins.size >= vm.pinLimit) android.widget.Toast.makeText(ctx, L.s(R.string.buses_pins_full, vm.pinLimit), android.widget.Toast.LENGTH_SHORT).show()
                else onPin(shownCode)
            },
            // A pane of the sky's glass, as the search is.
            modifier = Modifier.padding(start = 8.dp).size(44.dp).background(c.surfaceVariant, CircleShape),
        ) {
            Icon(
                painterResource(if (starOn) R.drawable.ic_star_filled else R.drawable.ic_star),
                contentDescription = stringResource(if (starOn) R.string.buses_unpin else R.string.buses_pin),
                tint = if (starOn) c.primary else c.onSurface,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

/** Under the sky: this side or across the road, and the board. */
@Composable
private fun StopBody(state: BusesUi, vm: BusesViewModel, code: String) {
    val own = state.boards[code]
    val opposite = own?.opposite
    val across = opposite != null && code in state.across
    val shownCode = if (across) opposite else code
    val board = state.boards[shownCode]
    if (opposite != null) {
        Segmented(
            // Labelled from the page's own stop, so they stay put after switching. Two
            // stops only near each other (PGP and its Foyer) aren't sides of a road: their names.
            if (own.oppositeAcross) listOf(stringResource(R.string.buses_this_side), stringResource(R.string.buses_across))
            else listOf(own.name, own.oppositeName ?: stopName(state, opposite)),
            if (across) 1 else 0,
            Modifier.padding(top = 12.dp),
        ) { vm.setAcross(code, it == 1) }
    }
    Spacer(Modifier.height(12.dp))
    BoardCard(board, failed = shownCode in state.failed, colors = state.campus?.routes?.mapValues { it.value.color }.orEmpty()) { row ->
        vm.open(BusRoute.Line(row.svc, shownCode))
    }
    board?.let { Foot(it) }
}

/** The pages as dots, the one in view long; the nearest stop's an arrow. */
@Composable
private fun Dots(count: Int, current: Int, nearestFirst: Boolean) {
    val c = MaterialTheme.colorScheme
    val said = stringResource(R.string.a11y_page, current + 1, count)
    Row(Modifier.fillMaxWidth().padding(top = 10.dp).clearAndSetSemantics { contentDescription = said }, horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
        for (i in 0 until count) {
            if (i == 0 && nearestFirst) {
                Icon(painterResource(R.drawable.ic_near), contentDescription = null, tint = if (current == 0) c.onSurface else c.outline, modifier = Modifier.padding(horizontal = 3.dp).size(10.dp))
            } else {
                Box(
                    Modifier.padding(horizontal = 3.dp).height(6.dp).width(if (i == current) 18.dp else 6.dp)
                        .background(if (i == current) c.onSurface else c.outlineVariant, CircleShape),
                )
            }
        }
    }
}

/** Two choices side by side, the chosen one raised: "This side | Across the road". */
@Composable
private fun Segmented(options: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Min).clip(RoundedCornerShape(14.dp)).background(c.secondaryContainer).padding(4.dp).selectableGroup()) {
        for ((i, text) in options.withIndex()) {
            val on = i == selected
            Box(
                Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(10.dp))
                    .background(if (on) c.surface else Color.Transparent)
                    .selectable(selected = on, role = Role.Tab) { onSelect(i) }
                    .padding(vertical = 9.dp, horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                // A long stop name takes two lines, centred; both halves keep one height.
                Text(text, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium, color = if (on) c.onSurface else c.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, lineHeight = 18.sp)
            }
        }
    }
}

/** The board: a row per service, sorted as the API sorts them. */
@Composable
private fun BoardCard(board: Board?, failed: Boolean, colors: Map<String, Long>, onRow: (BoardRow) -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.outlineVariant, shape)) {
        when {
            board == null -> Text(
                stringResource(if (failed) R.string.cant_reach else R.string.checking),
                color = c.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
            board.rows.isEmpty() -> Text(
                stringResource(if (board.available) R.string.buses_none_here else R.string.buses_feed_down),
                color = c.onSurfaceVariant,
                modifier = Modifier.padding(16.dp),
            )
            else -> {
                if (!board.available) Text(stringResource(R.string.buses_feed_down), color = c.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
                // The services not running come after the ones that are, as the API sorts them.
                val rows = board.rows.filter { it.running } + board.rows.filter { !it.running }
                val now = ticking()
                for ((i, row) in rows.withIndex()) {
                    if (i > 0 || !board.available) HorizontalDivider(color = c.outlineVariant)
                    val color = row.color?.let(::parseColor) ?: colors[row.svc] ?: GREY
                    // A public bus has no line page: /line is the shuttles'.
                    val open = if (row.paid) null else ({ onRow(row) })
                    val stopped = Stopped.of(row.running, row.stopped, row.resumesAtMs, now)
                    if (stopped != null) StoppedRowView(row, color, stopped, open) else BoardRowView(row, color, open)
                }
            }
        }
    }
}

@Composable
private fun BoardRowView(row: BoardRow, color: Long, onClick: (() -> Unit)?) {
    val c = MaterialTheme.colorScheme
    val arriving = row.etaS != null && row.etaS < BusTimes.ARRIVING_S
    Row(
        Modifier.fillMaxWidth()
            .background(if (arriving) c.primaryContainer else Color.Transparent)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_line, row.svc), onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        SvcChip(row.svc, color, paid = row.paid)
        Column(Modifier.weight(1f)) {
            // Where it goes, as the server words it ("to Central Library, Kent Vale", "Ends here").
            if (row.toText != null) Text(towards(row.toText, row.towards.firstOrNull(), row.towards.isEmpty()), style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            else if (row.towards.isNotEmpty()) Text(towards(row.towards), style = MaterialTheme.typography.bodyLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
            // The end of its line: said, so no direction doesn't read as missing.
            else if (row.endsHere) Text(stringResource(R.string.buses_ends_here), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Bold)
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(
                Modifier.padding(top = if (row.toText == null && row.towards.isEmpty() && !row.endsHere) 2.dp else 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                QualityTag(row)
                crowdWord(row.crowd)?.let { CrowdPill(it, row.crowd == "high") }
            }
        }
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(min = 72.dp)) {
            BigTime(row.etaS, row.quality, arriving, row.eta)
            thenText(row)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant, textAlign = TextAlign.End, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

/**
 * A service that calls here but isn't running: greyed, its chip faded, and
 * where the minutes go, why and when it's back. No time, no Live, no crowd.
 */
@Composable
private fun StoppedRowView(row: BoardRow, color: Long, stopped: Stopped, onClick: (() -> Unit)?) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val (why, back) = stopped.lines(remember { hour12(ctx) })
    Row(
        Modifier.fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_line, row.svc), onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.alpha(0.35f)) { SvcChip(row.svc, color, paid = row.paid) }
        Column(Modifier.weight(1f)) {
            if (row.towards.isNotEmpty()) {
                Text(row.toText ?: stringResource(R.string.buses_towards, row.towards.joinToString(stringResource(R.string.list_sep))), style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(why, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = c.onSurfaceVariant)
            back?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant) }
        }
    }
}

/** The server's "to Central Library, Kent Vale" with the next stop ([next]) in bold; all of it bold at the end of the line. */
private fun towards(text: String, next: String?, endsHere: Boolean): AnnotatedString = buildAnnotatedString {
    append(text)
    val at = next?.let { text.indexOf(it) } ?: -1
    if (endsHere) addStyle(SpanStyle(fontWeight = FontWeight.Bold), 0, text.length)
    else if (at >= 0) addStyle(SpanStyle(fontWeight = FontWeight.Bold), at, at + next!!.length)
}

/** "to **Central Library**, Kent Vale", worked out here for an older server without `toText`. */
@Composable
private fun towards(names: List<String>): AnnotatedString {
    val joined = names.joinToString(stringResource(R.string.list_sep))
    val full = stringResource(R.string.buses_towards, joined)
    val at = full.indexOf(joined)
    return buildAnnotatedString {
        append(full)
        if (at >= 0) addStyle(SpanStyle(fontWeight = FontWeight.Bold), at, at + names.first().length)
    }
}

/** Live (a dot), Scheduled (amber), or the last time known; nothing when there's no time. */
@Composable
private fun QualityTag(row: BoardRow) {
    val c = MaterialTheme.colorScheme
    when {
        row.etaS == null -> Text(
            stringResource(if (row.quality == "unknown") R.string.buses_no_live_times else R.string.buses_no_time_yet),
            style = MaterialTheme.typography.labelLarge,
            color = c.onSurfaceVariant,
        )
        row.quality == "live" -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val good = goodColor()
            Canvas(Modifier.size(10.dp)) {
                drawCircle(good.copy(alpha = 0.25f))
                drawCircle(good, radius = size.minDimension / 3.2f)
            }
            Text(stringResource(R.string.buses_live), style = MaterialTheme.typography.labelLarge, color = good, fontWeight = FontWeight.SemiBold)
        }
        row.quality == "stale" -> Tag(stringResource(R.string.buses_last_known), c.onSurfaceVariant)
        else -> Tag(stringResource(R.string.buses_scheduled), c.tertiary)
    }
}

@Composable
private fun Tag(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.SemiBold,
        color = color,
        modifier = Modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
    )
}

@Composable
private fun CrowdPill(text: String, packed: Boolean) {
    val c = MaterialTheme.colorScheme
    val color = if (packed) c.tertiary else c.onSurfaceVariant
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = color,
        modifier = Modifier.background(if (packed) color.copy(alpha = 0.12f) else c.secondaryContainer, RoundedCornerShape(50)).padding(horizontal = 9.dp, vertical = 2.dp),
    )
}

@Composable
private fun crowdWord(crowd: String?): String? = when (crowd) {
    "low" -> stringResource(R.string.buses_seats)
    "medium" -> stringResource(R.string.buses_busy)
    "high" -> stringResource(R.string.buses_packed)
    else -> null
}

/**
 * "4 min" with the number large, or "Arriving"; nothing without a time (the
 * tag says why). The words are the server's ([eta]: "4 min", "~6 min", "约 6
 * 分钟", "now"), with its number drawn large; worked out here for an older server.
 */
@Composable
private fun BigTime(etaS: Int?, quality: String, arriving: Boolean, eta: String? = null) {
    val c = MaterialTheme.colorScheme
    val number = eta?.let { Regex("\\d+").find(it) }
    when {
        etaS == null -> Text("–", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.outline)
        eta != null -> Text(
            buildAnnotatedString {
                if (number == null) {
                    withStyle(SpanStyle(fontSize = 24.sp, fontWeight = FontWeight.ExtraBold)) { append(eta) }
                } else {
                    withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) { append(eta.substring(0, number.range.first)) }
                    withStyle(SpanStyle(fontSize = 34.sp, fontWeight = FontWeight.ExtraBold)) { append(number.value) }
                    withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) { append(eta.substring(number.range.last + 1)) }
                }
            },
            color = if (arriving) c.primary else if (quality == "live") c.onSurface else c.onSurfaceVariant,
            maxLines = 1,
            // "about 6 minutes", not "tilde 6 min": the tag beside it says live or timetable.
            modifier = Modifier.semantics { contentDescription = Spoken.eta(etaS, quality, withQuality = false) ?: eta },
        )
        arriving -> Text(stringResource(R.string.map_arriving), fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = c.primary)
        else -> {
            val unit = stringResource(R.string.buses_min)
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(fontSize = 34.sp, fontWeight = FontWeight.ExtraBold)) { append("${BusTimes.minutes(etaS)}") }
                    withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) { append(" $unit") }
                },
                // A timetabled time isn't drawn as boldly as a bus seen.
                color = if (quality == "live") c.onSurface else c.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.semantics { contentDescription = Spoken.eta(etaS, quality, withQuality = false) ?: L.s(R.string.n_min, BusTimes.minutes(etaS)) },
            )
        }
    }
}

/** "then 12, ~20, 25 min", as the server words it; worked out here, from the later buses it gave, for an older server. */
private fun thenText(row: BoardRow): String? {
    row.laterText?.let { return it }
    val later = BusTimes.later(row)
    if (later.isEmpty()) return null
    val list = later.joinToString(L.s(R.string.list_sep))
    return L.s(if (BusTimes.laterScheduled(row)) R.string.buses_then_scheduled else R.string.buses_then, list)
}

/** Under the board: the services ending within two hours, and how old the times are. */
@Composable
private fun Foot(board: Board) {
    val ctx = LocalContext.current
    val now = ticking()
    val h12 = remember { hour12(ctx) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().padding(top = 12.dp, start = 4.dp, end = 4.dp), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f)) {
            for ((svc, at) in BusTimes.endingSoon(board.rows.filter { it.running }, now)) {
                val time = clock(at, h12)
                val full = stringResource(R.string.buses_svc_runs_until, svc, time)
                Text(
                    buildAnnotatedString {
                        append(full)
                        val i = full.indexOf(svc)
                        if (i >= 0) addStyle(SpanStyle(fontWeight = FontWeight.Bold), i, i + svc.length)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        board.asOfMs?.let { Text(updated(it, now), style = MaterialTheme.typography.bodyMedium, color = muted, modifier = Modifier.padding(start = 8.dp)) }
    }
    if (board.rows.any { !it.paid }) Text(stringResource(R.string.buses_tap_hint), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 10.dp, start = 4.dp))
}

private fun updated(asOfMs: Long, now: Long): String {
    val s = BusTimes.ageS(asOfMs, now)
    return if (s < 60) L.s(R.string.buses_updated_s, s.toInt()) else L.s(R.string.buses_updated_min, (s / 60).toInt())
}

/** An instant as the clock on campus shows it, 12- or 24-hour as the account chose. */
private fun clock(ms: Long, h12: Boolean): String = BusTimes.campusMinute(ms).let { if (h12) hhmm12(it) else hhmm(it) }

@Composable
private fun SwipeFor(name: String, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(16.dp)
    Row(
        Modifier.fillMaxWidth().padding(top = 16.dp).clip(shape).border(1.dp, c.outlineVariant, shape).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val full = stringResource(R.string.buses_swipe_for, name)
        Text(
            buildAnnotatedString {
                append(full)
                val i = full.indexOf(name)
                if (i >= 0) addStyle(SpanStyle(fontWeight = FontWeight.Bold), i, i + name.length)
            },
            color = c.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = c.onSurfaceVariant)
    }
}

/** A service as it's painted on the bus, larger, for the board's rows and the line's heading. */
@Composable
private fun SvcChip(svc: String, color: Long, paid: Boolean = false, big: Boolean = false) {
    val said = stringResource(if (paid) R.string.a11y_bus_paid else R.string.a11y_bus, svc)
    Box(
        Modifier.semantics(mergeDescendants = true) { contentDescription = said }.widthIn(min = if (big) 64.dp else 46.dp).heightIn(min = if (big) 44.dp else 32.dp).background(Color(color), RoundedCornerShape(if (big) 12.dp else 9.dp)).padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(badgeText(svc, paid), color = inkOn(Color(color)), fontWeight = FontWeight.ExtraBold, fontSize = if (big) 20.sp else 15.sp, maxLines = 1)
    }
}

private const val GREY = 0xFF8A939CL

/* ---------- a service's line ---------- */

@Composable
private fun LineRoute(state: BusesUi, vm: BusesViewModel, route: BusRoute.Line, onShowOnMap: (String) -> Unit, top: Dp) {
    val key = lineKey(route.svc, route.from)
    Refreshing(key) { vm.refreshLine(route.svc, route.from) }
    val line = state.lines[key]
    val c = MaterialTheme.colorScheme
    val now = ticking()
    val ctx = LocalContext.current
    val h12 = remember { hour12(ctx) }
    val color = line?.color ?: state.campus?.routes?.get(route.svc)?.color ?: GREY
    val scroll = rememberScrollState()
    // Opened from a stop: scrolled to it once, so your stop is in view with the buses coming to it.
    var hereY by remember { mutableStateOf<Int?>(null) }
    var scrolled by rememberSaveable(key) { mutableStateOf(false) }
    val gap = with(LocalDensity.current) { 160.dp.roundToPx() }
    // Not running, the banner at the top says it all: no scrolling past it.
    val running = line?.running != false
    LaunchedEffect(hereY, running) {
        val y = hereY ?: return@LaunchedEffect
        if (!scrolled && running) {
            scrolled = true
            scroll.animateScrollTo((y - gap).coerceAtLeast(0))
        }
    }
    Column(Modifier.fillMaxSize()) {
    // Back, the service and how many buses it has out, in the sky; the line on the page.
    SkyBand(skyPhase(), top, moonLow = true) { Column {
        BackRow(
            route.from?.let { stopName(state, it) } ?: stringResource(R.string.back),
            trailing = {
                TextButton(onClick = { onShowOnMap(route.svc) }) {
                    Icon(painterResource(R.drawable.ic_tab_map), contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.buses_show_on_map), modifier = Modifier.padding(start = 6.dp))
                }
            },
        ) { vm.back() }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp), modifier = Modifier.padding(top = 8.dp)) {
            SvcChip(route.svc, color, big = true)
            Column {
                if (line != null) {
                    val n = line.buses.size
                    Text(
                        when {
                            !line.available -> stringResource(R.string.map_buses_unavailable)
                            n == 0 -> stringResource(R.string.buses_none_running)
                            n == 1 -> stringResource(R.string.buses_one_running)
                            else -> stringResource(R.string.buses_n_running, n)
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    line.endsAtMs?.let { Text(stringResource(R.string.buses_runs_until, clock(it, h12)), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        }
    } }
    Column(Modifier.weight(1f).verticalScroll(scroll).padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
        // Not running: why and when it's back, over the stops (it has no buses to show).
        line?.let { Stopped.of(it.running, it.stopped, it.resumesAtMs, now) }?.let { st ->
            val (why, back) = st.lines(h12)
            Column(Modifier.fillMaxWidth().padding(top = 14.dp).clip(RoundedCornerShape(14.dp)).background(c.secondaryContainer).padding(horizontal = 14.dp, vertical = 12.dp)) {
                Text(why, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                back?.let { Text(it, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp)) }
            }
        }
        HorizontalDivider(Modifier.padding(top = 16.dp), color = c.outlineVariant)
        when {
            line == null && key in state.lineFailed -> Text(stringResource(R.string.buses_unknown_line), color = c.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
            line == null -> Text(stringResource(R.string.checking), color = c.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
            else -> {
                Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Label(stringResource(R.string.buses_n_stops, line.stops.size), Modifier.weight(1f))
                    line.asOfMs?.let { Text(updated(it, now), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant) }
                }
                LineList(line, Color(color), colors = state.campus?.routes?.mapValues { it.value.color }.orEmpty(), onHere = { hereY = it }) { code -> vm.open(BusRoute.Stop(code)) }
                if (line.here != null && line.running) Text(stringResource(R.string.buses_times_here_only), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }
    }
}

/** The line top to bottom in the service's colour: a node per stop, the buses on it at a stop or between two. */
@Composable
private fun LineList(line: Line, color: Color, colors: Map<String, Long>, onHere: (Int) -> Unit, onStop: (String) -> Unit) {
    val items = line.items()
    val c = MaterialTheme.colorScheme
    for ((i, item) in items.withIndex()) {
        val first = i == 0
        val last = i == items.lastIndex
        when (item) {
            is LineItem.Stop -> {
                val here = item.here
                Row(
                    Modifier.fillMaxWidth().height(IntrinsicSize.Min)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (here) c.primaryContainer else Color.Transparent)
                        .then(if (here) Modifier.onGloballyPositioned { onHere(it.positionInParent().y.toInt()) } else Modifier)
                        .clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { onStop(item.stop.code) },
                ) {
                    Rail(color, first, last, bus = item.buses.isNotEmpty(), here = here)
                    Column(Modifier.weight(1f).padding(vertical = 10.dp).padding(end = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(item.stop.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                if (item.stop.services.isNotEmpty()) {
                                    @OptIn(ExperimentalLayoutApi::class)
                                    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        for (svc in item.stop.services) BusBadge(svc, colors[svc] ?: GREY, 10.sp, pad = 4.dp)
                                    }
                                }
                            }
                            if (here) line.here?.row?.takeIf { it.running }?.let { HereTime(it) }
                        }
                        if (here) Box(Modifier.padding(top = 6.dp)) { Tag(stringResource(R.string.buses_your_stop), c.primary) }
                        if (item.buses.isNotEmpty()) BusesOnLine(item.buses, stringResource(R.string.buses_at_stop))
                    }
                }
            }
            is LineItem.Between -> Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                Rail(color, first = false, last = last, bus = true, here = false)
                Box(Modifier.weight(1f).padding(vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                    BusesOnLine(item.buses, stringResource(R.string.buses_on_the_way))
                }
            }
        }
    }
}

/** The plates and how full each bus is. */
@Composable
private fun BusesOnLine(buses: List<LineBus>, where: String) {
    @OptIn(ExperimentalLayoutApi::class)
    FlowRow(
        Modifier.padding(top = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        for (b in buses) {
            b.plate?.let { Plate(it) }
            crowdWord(b.crowd)?.let { CrowdPill(it, b.crowd == "high") }
        }
        Text(where, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun Plate(text: String) {
    val c = MaterialTheme.colorScheme
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.5.sp,
        modifier = Modifier.background(c.surface, RoundedCornerShape(6.dp)).border(1.dp, c.outlineVariant, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

/** Your stop's time on the line, from its board row: the only time on the page. */
@Composable
private fun HereTime(row: BoardRow) {
    Column(horizontalAlignment = Alignment.End) {
        BigTime(row.etaS, row.quality, row.etaS != null && row.etaS < BusTimes.ARRIVING_S, row.eta)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            QualityTag(row)
        }
        thenText(row)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** The line's stretch beside one row: the line through it, and its stop's node or a bus. */
@Composable
private fun Rail(color: Color, first: Boolean, last: Boolean, bus: Boolean, here: Boolean) {
    val paper = MaterialTheme.colorScheme.surface
    val ring = MaterialTheme.colorScheme.primary
    Box(Modifier.width(48.dp).fillMaxHeight(), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val x = size.width / 2
            val y = size.height / 2
            val w = 6.dp.toPx()
            drawLine(color, Offset(x, if (first) y else 0f), Offset(x, if (last) y else size.height), w)
            if (!bus) {
                if (here) drawCircle(ring.copy(alpha = 0.25f), 13.dp.toPx(), Offset(x, y))
                drawCircle(paper, 7.dp.toPx(), Offset(x, y))
                drawCircle(color, 7.dp.toPx(), Offset(x, y), style = Stroke(3.dp.toPx()))
            }
        }
        if (bus) {
            Box(Modifier.size(28.dp).background(color, RoundedCornerShape(8.dp)).border(2.dp, paper, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_bus), contentDescription = null, tint = inkOn(color), modifier = Modifier.size(16.dp))
            }
        }
    }
}
