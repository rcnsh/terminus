package sh.rcn.terminus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.pager.PagerState
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
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
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
import sh.rcn.terminus.LineRow
import sh.rcn.terminus.PinPages
import sh.rcn.terminus.Pins
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullScene
import sh.rcn.terminus.Quiet
import sh.rcn.terminus.R
import sh.rcn.terminus.SearchRank
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.ServiceRoute
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.Stopped
import sh.rcn.terminus.busesTabIndex
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseColor
import sh.rcn.terminus.runningFirst
import sh.rcn.terminus.searchBuses

@Composable
internal fun BusesScreen(
    vm: BusesViewModel,
    insets: PaddingValues,
    pins: List<String>,
    onPin: (String) -> Unit,
    onShowOnMap: (String) -> Unit,
    pinsKnown: Boolean = true,
    publicBuses: Boolean = false,
    pinLimit: Int = sh.rcn.terminus.Limits.DEFAULT.pinnedStops,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    vm.publicBuses = publicBuses
    vm.pinLimit = pinLimit
    LaunchedEffect(Unit) { vm.loadCampus() }
    val bar = insets.calculateTopPadding()
    val pane = Modifier.fillMaxSize().padding(bottom = insets.calculateBottomPadding())
    var query by rememberSaveable { mutableStateOf("") }
    val wide = windowWidth() == Width.Wide
    val open = (state.stack.lastOrNull() as? BusRoute.Stop)?.code?.takeIf { wide }
    SideEffect { vm.openStop = open }
    val focus = LocalFocusManager.current
    LaunchedEffect(state.stack.lastOrNull()) { if (wide) focus.clearFocus() }
    val scrolls = rememberPaneScrolls()
    scrolls.keep(state.stack.mapIndexed { i, r -> pageKey(i + 1, r) }.toSet() + HOME)
    val route: @Composable (BusRoute) -> Unit = { top ->
        Keeps(scrolls, pageKey(LocalPageDepth.current, top)) {
            when (top) {
                is BusRoute.Stop -> StopRoute(state, vm, top.code, pins, pinsKnown, onPin, bar)
                is BusRoute.Line -> LineRoute(state, vm, top, onShowOnMap, bar)
            }
        }
    }
    if (!wide) {
        PageStack(state.stack, onBack = vm::back, pane) { top ->
            if (top == null) Keeps(scrolls, HOME) { Home(state, vm, query, { query = it }, pins, pinsKnown, onPin, bar) } else route(top)
        }
        return
    }
    val skies = remember { PaneSkies() }
    val list = remember(skies) { SkyPane(skies, leading = true) }
    val page = remember(skies) { SkyPane(skies, leading = false) }
    Row(pane) {
        Box(Modifier.width(Widths.PANE.dp).fillMaxHeight()) {
            CompositionLocalProvider(LocalSkyPane provides list) {
                Keeps(scrolls, HOME) {
                    Home(state, vm, query, { query = it }, pins, pinsKnown, onPin, bar, chosen = state.stack.lastOrNull())
                }
            }
        }
        VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        CompositionLocalProvider(LocalSkyPane provides page) {
            PageStack(state.stack, onBack = vm::back, Modifier.weight(1f).fillMaxHeight()) { top ->
                if (top == null) NothingOpen(bar) else route(top)
            }
        }
    }
    BackHandler(enabled = query.isNotEmpty()) {
        query = ""
        focus.clearFocus()
    }
}

private const val HOME = "home"

private fun pageKey(depth: Int, route: BusRoute) = "$depth:$route"

@Composable
private fun NothingOpen(top: Dp) {
    Column(Modifier.fillMaxSize()) {
        SkyBand(skyPhase(), top) { TabHeader {} }
        Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
            Text(
                stringResource(R.string.buses_choose),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun Refreshing(vararg keys: Any?, next: (Long) -> Unit, refresh: suspend () -> Unit) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val latest by rememberUpdatedState(refresh)
    val nextAt by rememberUpdatedState(next)
    LaunchedEffect(*keys) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                latest()
                val wait = maxOf(BusTimes.REFRESH_MS, Quiet.waitMs())
                nextAt(System.currentTimeMillis() + wait)
                delay(wait)
            }
        }
    }
}

@Composable
private fun ticking(): Long {
    val now by
        produceState(ServerClock.now()) {
            while (true) {
                delay(1_000)
                value = ServerClock.now()
            }
        }
    return now
}

@Composable
private fun Home(
    state: BusesUi,
    vm: BusesViewModel,
    query: String,
    onQuery: (String) -> Unit,
    pins: List<String>,
    pinsKnown: Boolean,
    onPin: (String) -> Unit,
    top: Dp,
    chosen: BusRoute? = null,
) {
    val focus = LocalFocusManager.current
    val clear = {
        onQuery("")
        focus.clearFocus()
    }
    BackHandler(enabled = query.isNotEmpty(), onBack = clear)
    val pinned = Pins.shown(pins, vm.pinLimit)
    val pager = remember(pinned) { PagerState(vm.pinPage(pinned)) { pinned.size + 1 } }
    LaunchedEffect(pager) {
        if (pinned.isNotEmpty()) snapshotFlow { pager.currentPage }.collect { vm.pinShown = PinPages.at(pinned, it) }
    }
    val showing = PinPages.at(pinned, pager.currentPage).takeIf { it != PinPages.ADD }
    val around = PinPages.around(pinned, pager.settledPage)
    val phase = skyPhase()
    val scroll = rememberPaneScroll()
    BusPull(
        showing?.let { pinLivery(state, it) },
        ::hillScene,
        enabled = query.isBlank(),
        onRefresh = { vm.pullPinned(showing, around) },
        nextUpdateAt = { showing?.let(vm::pinNextAt) },
    ) {
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                TitleBand(stringResource(R.string.tab_buses), phase, top)
                SearchBox(query, onQuery, Modifier.column().padding(horizontal = 16.dp).padding(top = 12.dp))
                if (query.isNotBlank()) {
                    SearchResults(state, query) { hit ->
                        clear()
                        vm.show(
                            when (hit) {
                                is BusHit.Service -> BusRoute.Line(hit.svc, null)
                                is BusHit.Stop -> BusRoute.Stop(hit.code)
                            }
                        )
                    }
                    return@Column
                }
                Refreshing(pinned, pager.settledPage, next = { vm.pinsTimedAt = it }) { vm.refreshPinned(around) }
                LinesPolling(vm)
                Column(Modifier.column().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
                    Label(stringResource(R.string.buses_pinned), Modifier.padding(top = 16.dp, bottom = 4.dp))
                    when {
                        !pinsKnown -> PinnedSkeleton()
                        pinned.isEmpty() -> NoPins()
                        else -> PinnedCard(state, vm, pinned, pager, pins, onPin, (chosen as? BusRoute.Stop)?.code)
                    }
                    Row(Modifier.fillMaxWidth().padding(top = 24.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Label(stringResource(R.string.buses_group_services), Modifier.padding(end = 12.dp))
                        Text(
                            stringResource(R.string.buses_services_hint),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.End,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Services(state, (chosen as? BusRoute.Line)?.svc) { vm.show(BusRoute.Line(it, null)) }
                }
            }
            StatusStrip(phase, top, scroll)
        }
    }
}

@Composable
private fun LinesPolling(vm: BusesViewModel) {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                vm.refreshLines()
                delay(maxOf(vm.linesNextMs(), Quiet.waitMs()))
            }
        }
    }
}

internal fun hillScene(width: Float) = PullScene(width, Pull.hillSign(width))

private fun boardLivery(state: BusesUi, code: String): Long? {
    val opposite = state.boards[code]?.opposite
    val shown = if (code in state.across && opposite != null) opposite else code
    val row = state.boards[shown]?.rows?.let(::runningFirst)?.firstOrNull() ?: return null
    return row.color?.let(::parseColor) ?: state.campus?.routes?.get(row.svc)?.color
}

private fun pinLivery(state: BusesUi, code: String): Long? {
    val row = state.pinned[code]?.stop?.board?.firstOrNull { it.running } ?: return null
    return row.color?.let(::parseColor) ?: state.campus?.routes?.get(row.svc)?.color
}

private fun pinName(state: BusesUi, code: String) = state.pinned[code]?.stop?.name ?: state.campus?.stop(code)?.name ?: code

@Composable
private fun PinnedCard(
    state: BusesUi,
    vm: BusesViewModel,
    pinned: List<String>,
    pager: PagerState,
    pins: List<String>,
    onPin: (String) -> Unit,
    chosen: String?,
) {
    val scope = rememberCoroutineScope()
    val density = LocalDensity.current
    val act =
        NearbyActions(
            pins,
            pinsKnown = true,
            pinLimit = vm.pinLimit,
            onPin = onPin,
            openStop = { vm.show(BusRoute.Stop(it)) },
            openLine = { svc, stop -> vm.show(BusRoute.Line(svc, stop)) },
        )
    PinTabs(
        pinned.map { pinName(state, it) },
        pager.currentPage.takeIf { it < pinned.size },
        Modifier.padding(top = 4.dp, bottom = 10.dp),
    ) {
        scope.launch { pager.animateScrollToPage(it) }
    }
    val now = ticking()
    val all = pinned.mapNotNull { code -> state.pinned[code]?.let { code to it.aged(now) } }
    val loaded = all.map { (code, s) -> code to s.copy(board = s.board.filter { it.running }) }
    val stopped = all.associate { (code, s) -> code to s.board.filterNot { it.running } }
    var tallest by remember(pinned) { mutableIntStateOf(0) }
    val tallestDp = with(density) { tallest.toDp() }
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val signs = nearbySigns(loaded.map { it.second }, maxWidth)
        HorizontalPager(
            pager,
            Modifier.fillMaxWidth().heightIn(min = tallestDp),
            pageSpacing = 16.dp,
            verticalAlignment = Alignment.Top,
            key = { PinPages.at(pinned, it) },
        ) { page ->
            val code = PinPages.at(pinned, page)
            val i = loaded.indexOfFirst { it.first == code }
            val measured = if (i >= 0) Modifier.onSizeChanged { if (it.height > tallest) tallest = it.height } else Modifier
            Box(Modifier.fillMaxWidth().then(measured)) {
                when {
                    code == PinPages.ADD -> PinAnother(tallestDp)
                    i >= 0 ->
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            NearbySign(
                                signs,
                                i,
                                act,
                                saysNone = true,
                                stopped = stopped[code].orEmpty(),
                                modifier = Modifier.chosenCard(code == chosen, 14.dp),
                            )
                            if (signs.cells[i].any { row -> row.any { it.mark.isNotEmpty() } }) {
                                Text(
                                    L.s(R.string.nearby_guess),
                                    Modifier.padding(horizontal = 6.dp),
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    fontSize = 13.sp,
                                    lineHeight = 18.sp,
                                )
                            }
                        }
                    else -> PinnedWaiting(state, code, failed = code in state.pinFailed, act)
                }
            }
        }
    }
}

@Composable
private fun PinnedWaiting(state: BusesUi, code: String, failed: Boolean, act: NearbyActions) {
    val name = pinName(state, code)
    StopSign(
        name,
        plate = Modifier.clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { act.openStop(code) },
        opens = true,
        trailing = {
            PinStar(code, act.pins, act.pinLimit, act.onPin, name = state.campus?.stop(code)?.fullName ?: name)
        },
    ) {
        if (failed)
            Text(
                stringResource(R.string.cant_reach),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(14.dp),
            )
        else
            Skeleton(stringResource(R.string.checking)) {
                SkeletonBoardLines(stopServices(state, code).map { it.first to Color(it.second) }.ifEmpty { List(3) { null } })
            }
    }
}

private fun stopServices(state: BusesUi, code: String): List<Pair<String, Long>> {
    val campus = state.campus ?: return emptyList()
    return campus.stop(code)?.services.orEmpty().map { it to (campus.routes[it]?.color ?: GREY) }
}

@Composable
private fun PinnedSkeleton() {
    Skeleton(stringResource(R.string.checking), Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Box(
            Modifier.fillMaxWidth()
                .padding(bottom = 10.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(MaterialTheme.colorScheme.secondaryContainer)
                .padding(4.dp)
        ) {
            Box(Modifier.fillMaxWidth().padding(vertical = 9.dp, horizontal = 12.dp), contentAlignment = Alignment.Center) {
                TextBar(MaterialTheme.typography.bodyLarge.copy(lineHeight = 18.sp), width = 96.dp)
            }
        }
        val shape = RoundedCornerShape(14.dp)
        Column(
            Modifier.fillMaxWidth()
                .clip(shape)
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
        ) {
            PlateSkeleton(0.48f)
            SkeletonBoardLines(List(3) { null })
        }
    }
}

@Composable
private fun PinAnother(height: Dp) {
    val c = MaterialTheme.colorScheme
    Column(
        Modifier.fillMaxWidth().heightIn(min = maxOf(height, 160.dp)).dashed(c.outline).padding(horizontal = 20.dp, vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(painterResource(R.drawable.ic_star), contentDescription = null, tint = c.onSurfaceVariant, modifier = Modifier.size(24.dp))
        Text(
            stringResource(R.string.buses_pin_another),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.semantics { heading() },
        )
        Text(stringResource(R.string.buses_pin_another_how), color = c.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

private fun Modifier.dashed(line: Color): Modifier = drawBehind {
    val d = 1.dp.toPx()
    drawRoundRect(
        line,
        topLeft = Offset(d / 2, d / 2),
        size = Size(size.width - d, size.height - d),
        cornerRadius = CornerRadius(18.dp.toPx()),
        style = Stroke(1.5f * d, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6 * d, 5 * d))),
    )
}

@Composable
private fun NoPins() {
    val c = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().padding(top = 8.dp).dashed(c.outline).padding(horizontal = 16.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(painterResource(R.drawable.ic_star), contentDescription = null, tint = c.onSurfaceVariant, modifier = Modifier.size(24.dp))
        Text(stringResource(R.string.buses_no_pins), color = c.onSurfaceVariant)
    }
}

@Composable
private fun Services(state: BusesUi, chosen: String?, onOpen: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val campus = state.campus
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.outlineVariant, shape)) {
        if (campus == null) {
            ServicesSkeleton()
            return@Column
        }
        val routes = campus.lines.ifEmpty { campus.serviceCodes.map { ServiceRoute(it, emptyList(), false) } }
        val rows = routes.map { route -> LineRow.of(route, state.out[route.svc]) { campus.stop(it)?.fullName ?: it } }
        val badge = badgeWidth(rows.map { it.svc })
        for ((i, row) in rows.withIndex()) {
            if (i > 0) HorizontalDivider(color = c.outlineVariant)
            val on = row.svc == chosen
            Row(
                Modifier.fillMaxWidth()
                    .chosen(on)
                    .clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_line, row.svc)) { onOpen(row.svc) }
                    .clearAndSetSemantics {
                        contentDescription = row.said()
                        selected = on
                    }
                    .padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                ServiceBadge(row.svc, Color(campus.routes[row.svc]?.color ?: GREY), badge)
                Column(Modifier.weight(1f)) {
                    row.name?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold) }
                    row.via?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant) }
                }
                row.out?.let { out ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (row.live) LiveDot(said = false)
                        Text(out.outText, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                    }
                }
                Icon(
                    painterResource(R.drawable.ic_chevron),
                    contentDescription = null,
                    tint = c.onSurfaceVariant,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

@Composable
private fun ServicesSkeleton() {
    val c = MaterialTheme.colorScheme
    Skeleton(stringResource(R.string.checking)) {
        for (i in 0 until 6) {
            if (i > 0) HorizontalDivider(color = c.outlineVariant)
            Row(
                Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Bar(Modifier.size(32.dp, 28.dp), RoundedCornerShape(8.dp))
                Column(Modifier.weight(1f)) {
                    TextBar(MaterialTheme.typography.bodyLarge, fraction = barFraction(i))
                    TextBar(MaterialTheme.typography.bodyMedium, fraction = barFraction(i, 1))
                }
                TextBar(MaterialTheme.typography.bodyMedium, width = 44.dp)
                Spacer(Modifier.width(20.dp))
            }
        }
    }
}

@Composable
internal fun PinStar(
    code: String,
    pins: List<String>,
    limit: Int,
    onPin: (String) -> Unit,
    modifier: Modifier = Modifier,
    name: String? = null,
) {
    val c = MaterialTheme.colorScheme
    val on = code in pins
    val ctx = LocalContext.current
    IconButton(
        onClick = {
            if (!on && pins.size >= limit)
                android.widget.Toast.makeText(ctx, L.s(R.string.buses_pins_full, limit), android.widget.Toast.LENGTH_SHORT).show()
            else onPin(code)
        },
        modifier = modifier,
    ) {
        Icon(
            painterResource(if (on) R.drawable.ic_star_filled else R.drawable.ic_star),
            contentDescription =
                if (name != null) stringResource(if (on) R.string.buses_unpin_stop else R.string.buses_pin_stop, name)
                else stringResource(if (on) R.string.buses_unpin else R.string.buses_pin),
            tint = if (on) c.primary else c.onSurface,
            modifier = Modifier.size(22.dp),
        )
    }
}

private fun stopName(state: BusesUi, code: String) = state.boards[code]?.name ?: state.campus?.stop(code)?.fullName ?: code

@Composable
private fun SearchBox(query: String, onQuery: (String) -> Unit, modifier: Modifier) {
    val focus = LocalFocusManager.current
    TextField(
        value = query,
        onValueChange = onQuery,
        label = { Text(stringResource(R.string.buses_search)) },
        leadingIcon = { Icon(painterResource(R.drawable.ic_search), contentDescription = null, modifier = Modifier.size(20.dp)) },
        trailingIcon =
            if (query.isEmpty()) null
            else {
                {
                    IconButton(
                        onClick = {
                            onQuery("")
                            focus.clearFocus()
                        }
                    ) {
                        Icon(painterResource(R.drawable.ic_close), contentDescription = stringResource(R.string.close))
                    }
                }
            },
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        shape = RoundedCornerShape(16.dp),
        colors =
            TextFieldDefaults.colors(
                focusedIndicatorColor = Color.Transparent,
                unfocusedIndicatorColor = Color.Transparent,
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
    val hits = remember(index, query) { SearchRank.grouped(searchBuses(query, index)) { it is BusHit.Service } }
    val colors = campus?.routes?.mapValues { it.value.color }.orEmpty()
    Column(Modifier.column().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
        if (hits.isEmpty() && campus != null) {
            Text(
                stringResource(R.string.buses_search_none),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 12.dp),
            )
        }
        var group: Boolean? = null
        for (hit in hits) {
            val isService = hit is BusHit.Service
            if (group != isService) {
                group = isService
                Label(
                    stringResource(if (isService) R.string.buses_group_services else R.string.group_stops),
                    Modifier.padding(top = 12.dp, bottom = 4.dp),
                )
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
                    is BusHit.Stop ->
                        Column(Modifier.weight(1f)) {
                            Text(hit.name, fontWeight = FontWeight.SemiBold)
                            Row(
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(top = 3.dp),
                            ) {
                                Text(
                                    hit.code,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                for (svc in hit.services) BusBadge(svc, colors[svc] ?: GREY, 11.sp, pad = 5.dp, even = true)
                            }
                        }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        }
    }
}

@Composable private fun canGoBack(state: BusesUi): Boolean = windowWidth() != Width.Wide || state.stack.size > 1

@Composable
private fun StopRoute(
    state: BusesUi,
    vm: BusesViewModel,
    code: String,
    pins: List<String>,
    pinsKnown: Boolean,
    onPin: (String) -> Unit,
    top: Dp,
) {
    Refreshing(code, state.across, next = { vm.pageTimedAt = it }) { vm.refreshPage(code) }
    val phase = skyPhase()
    val scroll = rememberPaneScroll()
    BusPull(boardLivery(state, code), ::hillScene, onRefresh = { vm.pullPage(code) }, nextUpdateAt = { vm.pageNextAt(code) }) { pull ->
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                SkyBand(phase, top, moonLow = true) {
                    Column {
                        if (canGoBack(state)) BackRow(stringResource(R.string.back), Modifier.pullLead(pull)) { vm.back() }
                        PullRoom(below = 8.dp)
                        val label = if (code in pins) stringResource(R.string.buses_pinned) else null
                        StopHeader(state, vm, code, label, pins = pins, pinsKnown = pinsKnown, onPin = onPin)
                    }
                }
                Column(Modifier.column().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
                    StopBody(state, vm, code)
                }
            }
            StatusStrip(phase, top, scroll)
        }
    }
}

@Composable
private fun BackRow(
    text: String,
    modifier: Modifier = Modifier,
    back: Boolean = true,
    trailing: @Composable () -> Unit = {},
    onBack: () -> Unit,
) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = if (back) Arrangement.SpaceBetween else Arrangement.End,
    ) {
        if (back)
            Row(
                Modifier.weight(1f, fill = false)
                    .clip(RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button, onClick = onBack)
                    .padding(vertical = 8.dp, horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Icon(
                    painterResource(R.drawable.ic_back),
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp),
                )
                Text(
                    text,
                    color = MaterialTheme.colorScheme.primary,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        trailing()
    }
}

@Composable
private fun StopHeader(
    state: BusesUi,
    vm: BusesViewModel,
    code: String,
    label: String?,
    pins: List<String>,
    pinsKnown: Boolean,
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
            if (label != null) Text(label, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
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
        if (pinsKnown)
            PinStar(
                shownCode,
                pins,
                vm.pinLimit,
                onPin,
                Modifier.padding(start = 8.dp).size(44.dp).background(c.surfaceVariant, CircleShape),
            )
    }
}

@Composable
private fun StopBody(state: BusesUi, vm: BusesViewModel, code: String) {
    val own = state.boards[code]
    val opposite = own?.opposite
    val across = opposite != null && code in state.across
    val shownCode = if (across) opposite else code
    val board = state.boards[shownCode]
    if (opposite != null) {
        Segmented(
            if (own.oppositeAcross) listOf(stringResource(R.string.buses_this_side), stringResource(R.string.buses_across))
            else listOf(own.name, own.oppositeName ?: stopName(state, opposite)),
            if (across) 1 else 0,
            Modifier.padding(top = 12.dp),
        ) {
            vm.setAcross(code, it == 1)
        }
    }
    Spacer(Modifier.height(12.dp))
    BoardCard(
        board,
        failed = shownCode in state.failed,
        colors = state.campus?.routes?.mapValues { it.value.color }.orEmpty(),
        services = stopServices(state, shownCode),
    ) { row ->
        vm.open(BusRoute.Line(row.svc, shownCode))
    }
    board?.let { Foot(it) }
}

@Composable
internal fun Segmented(
    options: List<String>,
    selected: Int,
    modifier: Modifier = Modifier,
    label: String? = null,
    onSelect: (Int) -> Unit,
) {
    Row(
        modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .segments()
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier)
    ) {
        for ((i, text) in options.withIndex()) {
            Box(Modifier.weight(1f).fillMaxHeight().segment(i == selected) { onSelect(i) }, contentAlignment = Alignment.Center) {
                SegmentText(text, i == selected, maxLines = 2)
            }
        }
    }
}

@Composable
private fun PinTabs(names: List<String>, selected: Int?, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    val scroll = rememberScrollState()
    val spans = remember(names) { mutableStateMapOf<Int, IntRange>() }
    val span = selected?.let { spans[it] }
    LaunchedEffect(span) {
        if (span == null) return@LaunchedEffect
        val view = scroll.viewportSize
        when {
            span.first < scroll.value -> scroll.animateScrollTo(span.first)
            span.last > scroll.value + view -> scroll.animateScrollTo(span.last - view)
        }
    }
    BoxWithConstraints(modifier.fillMaxWidth().segments()) {
        val share = maxWidth / names.size
        Row(Modifier.horizontalScroll(scroll)) {
            for ((i, name) in names.withIndex()) {
                Box(
                    Modifier.widthIn(min = share)
                        .onPlaced { at ->
                            val x = at.positionInParent().x.toInt()
                            (x..x + at.size.width).let { if (spans[i] != it) spans[i] = it }
                        }
                        .segment(i == selected, side = 12.dp) { onSelect(i) },
                    contentAlignment = Alignment.Center,
                ) {
                    SegmentText(name, i == selected, maxLines = 1)
                }
            }
        }
    }
}

@Composable
private fun Modifier.segments(): Modifier =
    clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.secondaryContainer).padding(4.dp).selectableGroup()

@Composable
private fun Modifier.segment(on: Boolean, side: Dp = 8.dp, onClick: () -> Unit): Modifier =
    clip(RoundedCornerShape(10.dp))
        .background(if (on) MaterialTheme.colorScheme.surface else Color.Transparent)
        .selectable(selected = on, role = Role.Tab, onClick = onClick)
        .padding(vertical = 9.dp, horizontal = side)

@Composable
private fun SegmentText(text: String, on: Boolean, maxLines: Int) {
    val c = MaterialTheme.colorScheme
    Text(
        text,
        fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
        color = if (on) c.onSurface else c.onSurfaceVariant,
        maxLines = maxLines,
        softWrap = maxLines > 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
        lineHeight = 18.sp,
    )
}

@Composable
private fun BoardCard(
    got: Board?,
    failed: Boolean,
    colors: Map<String, Long>,
    services: List<Pair<String, Long>>,
    onRow: (BoardRow) -> Unit,
) {
    val c = MaterialTheme.colorScheme
    val board = got?.aged(ticking())
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.outlineVariant, shape)) {
        when {
            board == null && failed ->
                Text(stringResource(R.string.cant_reach), color = c.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            board == null -> BoardSkeleton(services)
            board.rows.isEmpty() ->
                Text(
                    stringResource(if (board.available) R.string.buses_none_here else R.string.buses_feed_down),
                    color = c.onSurfaceVariant,
                    modifier = Modifier.padding(16.dp),
                )
            else -> {
                if (!board.available)
                    Text(
                        stringResource(R.string.buses_feed_down),
                        color = c.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                BoardRows(runningFirst(board.rows), colors, dividerFirst = !board.available, onRow = onRow)
            }
        }
    }
}

@Composable
private fun BoardSkeleton(services: List<Pair<String, Long>>) {
    val c = MaterialTheme.colorScheme
    val type = MaterialTheme.typography
    Skeleton(stringResource(R.string.checking)) {
        val rows: List<Pair<String, Long>?> = services.ifEmpty { List(3) { null } }
        for ((i, svc) in rows.withIndex()) {
            if (i > 0) HorizontalDivider(color = c.outlineVariant)
            Row(
                Modifier.fillMaxWidth().padding(start = 14.dp, end = 8.dp, top = 14.dp, bottom = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (svc != null) SvcChip(svc.first, svc.second) else Bar(Modifier.size(46.dp, 32.dp), RoundedCornerShape(9.dp))
                Column(Modifier.weight(1f)) {
                    TextBar(type.bodyLarge, fraction = barFraction(i))
                    TextBar(type.bodyMedium, Modifier.padding(top = 2.dp), fraction = barFraction(i, 1))
                }
                Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(min = 72.dp)) {
                    TextBar(TextStyle(fontSize = 28.sp, lineHeight = 34.sp), width = listOf(58.dp, 62.dp, 66.dp)[i % 3])
                    TextBar(type.bodyMedium, Modifier.padding(top = 4.dp), width = 40.dp)
                }
                Spacer(Modifier.width(20.dp))
            }
        }
    }
}

@Composable
internal fun BoardRows(
    rows: List<BoardRow>,
    colors: Map<String, Long>,
    compact: Boolean = false,
    dividerFirst: Boolean = false,
    clickLabel: @Composable (String) -> String = { stringResource(R.string.a11y_open_line, it) },
    picked: Picked? = null,
    onRow: (BoardRow) -> Unit,
) {
    val c = MaterialTheme.colorScheme
    for ((i, row) in rows.withIndex()) {
        if (i > 0 || dividerFirst) HorizontalDivider(color = c.outlineVariant)
        val color = row.color?.let(::parseColor) ?: colors[row.svc] ?: GREY
        val open = if (row.paid) null else ({ onRow(row) })
        val label = clickLabel(row.svc)
        val look = RowLook(chevron = picked == null && open != null, picked = picked?.let { it.svc == row.svc })
        if (row.running) BoardRowView(row, color, open, label, compact, look) else StoppedRow(row, color, open, label, compact, look)
    }
}

internal class Picked(val svc: String?)

private class RowLook(val chevron: Boolean, val picked: Boolean?)

private fun Modifier.rowGround(look: RowLook, color: Long, base: Color): Modifier =
    background(if (look.picked == true) Color(color.toInt()).copy(alpha = 0.16f) else base)
        .then(if (look.picked != null) Modifier.semantics { selected = look.picked } else Modifier)

@Composable
private fun RowScope.RowChevron(look: RowLook) {
    if (look.chevron)
        Icon(
            painterResource(R.drawable.ic_chevron),
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp).align(Alignment.CenterVertically),
        )
}

@Composable
private fun BoardRowView(row: BoardRow, color: Long, onClick: (() -> Unit)?, clickLabel: String, compact: Boolean, look: RowLook) {
    val c = MaterialTheme.colorScheme
    val arriving = BusTimes.arriving(row.etaS, row.quality)
    Row(
        Modifier.fillMaxWidth()
            .rowGround(look, color, Color.Transparent)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = clickLabel, onClick = onClick) else Modifier)
            .padding(
                start = if (compact) 16.dp else 14.dp,
                end = if (look.chevron) 8.dp else if (compact) 16.dp else 14.dp,
                top = if (compact) 10.dp else 14.dp,
                bottom = if (compact) 10.dp else 14.dp,
            ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SvcChip(row.svc, color, paid = row.paid, small = compact)
        Column(Modifier.weight(1f)) {
            destination(row)?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            @OptIn(ExperimentalLayoutApi::class)
            FlowRow(
                Modifier.padding(top = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                if (row.towards.size > 1)
                    Text(
                        stringResource(R.string.buses_next_stop, row.towards.first()),
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.onSurfaceVariant,
                    )
                QualityTag(row)
                crowdWord(row.crowd)?.let { CrowdPill(it, row.crowd == "high") }
            }
        }
        Column(horizontalAlignment = Alignment.End, modifier = Modifier.widthIn(min = 72.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                if (row.etaS != null && row.quality == "live") LiveDot()
                BigTime(row.etaS, row.quality, arriving, row.eta, size = if (compact) 24.sp else 28.sp)
            }
            thenText(row)?.let {
                Text(
                    it,
                    style = if (compact) MaterialTheme.typography.bodySmall else MaterialTheme.typography.bodyMedium,
                    color = c.onSurfaceVariant,
                    textAlign = TextAlign.End,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
        }
        RowChevron(look)
    }
}

@Composable
private fun StoppedRow(row: BoardRow, color: Long, onClick: (() -> Unit)?, clickLabel: String, compact: Boolean, look: RowLook) {
    val stopped = Stopped.of(running = false, row.stopped, row.resumesAtMs, ticking()) ?: return
    StoppedRowView(row, color, stopped, onClick, clickLabel, compact, look)
}

@Composable
private fun StoppedRowView(
    row: BoardRow,
    color: Long,
    stopped: Stopped,
    onClick: (() -> Unit)?,
    clickLabel: String,
    compact: Boolean,
    look: RowLook,
) {
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val (why, back) = stopped.lines(remember { hour12(ctx) })
    Row(
        Modifier.fillMaxWidth()
            .rowGround(look, color, Color.Transparent)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = clickLabel, onClick = onClick) else Modifier)
            .padding(
                start = if (compact) 16.dp else 14.dp,
                end = if (look.chevron) 8.dp else if (compact) 16.dp else 14.dp,
                top = if (compact) 8.dp else 12.dp,
                bottom = if (compact) 8.dp else 12.dp,
            ),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SvcChip(row.svc, color, paid = row.paid, small = compact)
        Column(Modifier.weight(1f)) {
            if (row.towards.isNotEmpty()) {
                Text(
                    row.towards.last(),
                    style = MaterialTheme.typography.bodyMedium,
                    color = c.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Text(why, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = c.onSurfaceVariant)
            back?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant) }
        }
        RowChevron(look)
    }
}

@Composable
private fun destination(row: BoardRow): String? =
    when {
        row.towards.isNotEmpty() -> row.towards.last()
        row.endsHere -> stringResource(R.string.buses_ends_here)
        else -> row.toText
    }

@Composable
private fun QualityTag(row: BoardRow) {
    val c = MaterialTheme.colorScheme
    when {
        row.etaS == null ->
            Text(
                stringResource(if (row.quality == "unknown") R.string.buses_no_live_times else R.string.buses_no_time_yet),
                style = MaterialTheme.typography.labelLarge,
                color = c.onSurfaceVariant,
            )
        row.quality == "live" -> {}
        row.quality == "stale" -> Tag(stringResource(R.string.buses_last_known), c.onSurfaceVariant)
        else -> Tag(stringResource(R.string.buses_scheduled), c.tertiary)
    }
}

@Composable
private fun LiveDot(said: Boolean = true) {
    val good = goodColor()
    val live = stringResource(R.string.buses_live)
    Canvas(Modifier.size(10.dp).then(if (said) Modifier.semantics { contentDescription = live } else Modifier)) {
        drawCircle(good.copy(alpha = 0.25f))
        drawCircle(good, radius = size.minDimension / 3.2f)
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
        modifier =
            Modifier.background(if (packed) color.copy(alpha = 0.12f) else c.secondaryContainer, RoundedCornerShape(50))
                .padding(horizontal = 9.dp, vertical = 2.dp),
    )
}

@Composable
private fun crowdWord(crowd: String?): String? =
    when (crowd) {
        "low" -> stringResource(R.string.buses_seats)
        "medium" -> stringResource(R.string.buses_busy)
        "high" -> stringResource(R.string.buses_packed)
        else -> null
    }

private val DIGITS = Regex("\\d+")

@Composable
private fun BigTime(etaS: Int?, quality: String, arriving: Boolean, words: String? = null, size: TextUnit = 34.sp) {
    val c = MaterialTheme.colorScheme
    val eta = words?.takeUnless { quality != "live" && DIGITS.find(it) == null }
    val number = eta?.let { DIGITS.find(it) }
    when {
        etaS == null -> Text("–", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = c.outline)
        eta != null ->
            Text(
                buildAnnotatedString {
                    if (number == null) {
                        withStyle(SpanStyle(fontSize = size, fontWeight = FontWeight.ExtraBold)) { append(eta) }
                    } else {
                        withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) {
                            append(eta.substring(0, number.range.first))
                        }
                        withStyle(SpanStyle(fontSize = size, fontWeight = FontWeight.ExtraBold)) { append(number.value) }
                        withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) {
                            append(eta.substring(number.range.last + 1))
                        }
                    }
                },
                color = if (arriving) c.primary else if (quality == "live") c.onSurface else c.onSurfaceVariant,
                maxLines = 1,
                modifier = Modifier.semantics { contentDescription = Spoken.eta(etaS, quality, withQuality = false) ?: eta },
            )
        arriving -> Text(stringResource(R.string.map_arriving), fontSize = size, fontWeight = FontWeight.ExtraBold, color = c.primary)
        else -> {
            val unit = stringResource(R.string.buses_min)
            Text(
                buildAnnotatedString {
                    if (quality != "live") withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) { append("~") }
                    withStyle(SpanStyle(fontSize = size, fontWeight = FontWeight.ExtraBold)) { append("${BusTimes.minutes(etaS)}") }
                    withStyle(SpanStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold)) { append(" $unit") }
                },
                color = if (quality == "live") c.onSurface else c.onSurfaceVariant,
                maxLines = 1,
                modifier =
                    Modifier.semantics {
                        contentDescription = Spoken.eta(etaS, quality, withQuality = false) ?: L.s(R.string.n_min, BusTimes.minutes(etaS))
                    },
            )
        }
    }
}

private fun thenText(row: BoardRow): String? {
    row.laterText?.let {
        return it
    }
    val later = BusTimes.later(row)
    if (later.isEmpty()) return null
    val list = later.joinToString(L.s(R.string.list_sep))
    return L.s(if (BusTimes.laterScheduled(row)) R.string.buses_then_scheduled else R.string.buses_then, list)
}

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
        board.asOfMs?.let {
            val live = board.available && board.rows.any { r -> r.running && r.etaS != null && r.quality == "live" }
            Row(Modifier.padding(start = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (live) {
                    LiveDot(said = false)
                    Text(
                        stringResource(R.string.buses_live_updated, updated(it, now)),
                        style = MaterialTheme.typography.bodyMedium,
                        color = muted,
                        modifier = Modifier.padding(start = 6.dp),
                    )
                } else Text(updated(it, now), style = MaterialTheme.typography.bodyMedium, color = muted)
            }
        }
    }
}

private fun updated(asOfMs: Long, now: Long): String {
    val s = BusTimes.ageS(asOfMs, now)
    return when {
        s < 5 -> L.s(R.string.pull_updated)
        s < 60 -> L.s(R.string.buses_updated_s, s.toInt())
        else -> L.s(R.string.buses_updated_min, (s / 60).toInt())
    }
}

private fun clock(ms: Long, h12: Boolean): String = BusTimes.campusMinute(ms).let { if (h12) hhmm12(it) else hhmm(it) }

@Composable
private fun SvcChip(svc: String, color: Long, paid: Boolean = false, big: Boolean = false, small: Boolean = false) {
    val said = stringResource(if (paid) R.string.a11y_bus_paid else R.string.a11y_bus, svc)
    val (w, h, r) =
        when {
            big -> Triple(64.dp, 44.dp, 12.dp)
            small -> Triple(40.dp, 26.dp, 7.dp)
            else -> Triple(46.dp, 32.dp, 9.dp)
        }
    Box(
        Modifier.semantics(mergeDescendants = true) { contentDescription = said }
            .widthIn(min = w)
            .heightIn(min = h)
            .background(Color(color), RoundedCornerShape(r))
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            badgeText(svc, paid),
            color = inkOn(Color(color)),
            fontWeight = FontWeight.ExtraBold,
            fontSize = if (big) 20.sp else if (small) 13.sp else 15.sp,
            maxLines = 1,
        )
    }
}

private const val GREY = 0xFF8A939CL

@Composable
private fun LineRoute(state: BusesUi, vm: BusesViewModel, route: BusRoute.Line, onShowOnMap: (String) -> Unit, top: Dp) {
    val key = lineKey(route.svc, route.from)
    Refreshing(key, next = { vm.pageTimedAt = it }) { vm.refreshLine(route.svc, route.from) }
    val now = ticking()
    val line = state.lines[key]?.aged(now)
    val c = MaterialTheme.colorScheme
    val ctx = LocalContext.current
    val h12 = remember { hour12(ctx) }
    val color = line?.color ?: state.campus?.routes?.get(route.svc)?.color ?: GREY
    val scroll = rememberPaneScroll()
    var hereY by remember { mutableStateOf<Int?>(null) }
    var band by remember { mutableStateOf(0) }
    var scrolled by rememberSaveable(key) { mutableStateOf(false) }
    val gap = with(LocalDensity.current) { 160.dp.roundToPx() }
    val running = line?.running != false
    var arrived by rememberSaveable(key) { mutableStateOf(false) }
    LaunchedEffect(line != null) {
        if (line == null || arrived) return@LaunchedEffect
        arrived = true
        if (!line.running) scroll.animateScrollTo(0)
    }
    LaunchedEffect(hereY, running) {
        val y = hereY ?: return@LaunchedEffect
        if (!scrolled && running) {
            scrolled = true
            scroll.animateScrollTo((band + y - gap).coerceAtLeast(0))
        }
    }
    val phase = skyPhase()
    BusPull(
        color,
        ::hillScene,
        onRefresh = { vm.pullLine(route.svc, route.from) },
        nextUpdateAt = { vm.lineNextAt(route.svc, route.from) },
    ) { pull ->
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                Box(Modifier.onSizeChanged { band = it.height }) {
                    SkyBand(phase, top, moonLow = true) {
                        Column {
                            BackRow(
                                back = canGoBack(state),
                                text =
                                    when (val under = state.stack.getOrNull(state.stack.size - 2)) {
                                        is BusRoute.Stop -> stopName(state, under.code)
                                        is BusRoute.Line -> under.svc
                                        null -> stringResource(R.string.tab_buses)
                                    },
                                modifier = Modifier.pullLead(pull),
                                trailing = {
                                    TextButton(onClick = { onShowOnMap(route.svc) }) {
                                        Icon(
                                            painterResource(R.drawable.ic_tab_map),
                                            contentDescription = null,
                                            modifier = Modifier.size(18.dp),
                                        )
                                        Text(stringResource(R.string.buses_show_on_map), modifier = Modifier.padding(start = 6.dp))
                                    }
                                },
                            ) {
                                vm.back()
                            }
                            PullRoom(below = 8.dp)
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(14.dp),
                                modifier = Modifier.padding(top = 8.dp),
                            ) {
                                SvcChip(route.svc, color, big = true)
                                Column {
                                    if (line == null && key !in state.lineFailed)
                                        Skeleton(stringResource(R.string.checking)) {
                                            TextBar(MaterialTheme.typography.titleMedium, width = 150.dp, sky = true)
                                        }
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
                                        line.endsAtMs?.let {
                                            Text(
                                                stringResource(R.string.buses_runs_until, clock(it, h12)),
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Column(Modifier.column().padding(horizontal = 16.dp).padding(bottom = 16.dp)) {
                    line
                        ?.let { Stopped.of(it.running, it.stopped, it.resumesAtMs, now) }
                        ?.let { st ->
                            val (why, back) = st.lines(h12)
                            Column(
                                Modifier.fillMaxWidth()
                                    .padding(top = 14.dp)
                                    .clip(RoundedCornerShape(14.dp))
                                    .background(c.secondaryContainer)
                                    .padding(horizontal = 14.dp, vertical = 12.dp)
                            ) {
                                Text(why, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                back?.let { Text(it, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp)) }
                            }
                        }
                    val routeColors = remember(state.campus) { state.campus?.routes?.mapValues { it.value.color }.orEmpty() }
                    val known =
                        remember(state.campus, route.svc, route.from) { state.campus?.let { Line.fromCampus(it, route.svc, route.from) } }
                    HorizontalDivider(Modifier.padding(top = 16.dp), color = c.outlineVariant)
                    when {
                        line == null && key in state.lineFailed ->
                            Text(
                                stringResource(R.string.buses_unknown_line),
                                color = c.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 16.dp),
                            )
                        line == null -> {
                            if (known == null) LineSkeleton(Color(color))
                            else
                                Skeleton(stringResource(R.string.checking), real = true) {
                                    Row(
                                        Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Label(
                                            stringResource(R.string.buses_n_stops, known.stops.distinctBy { it.code }.size),
                                            Modifier.weight(1f),
                                        )
                                        TextBar(MaterialTheme.typography.bodySmall, width = 96.dp)
                                    }
                                    LineList(
                                        known,
                                        Color(color),
                                        colors = routeColors,
                                        onHere = { hereY = it },
                                        waiting = true,
                                    ) { code ->
                                        vm.open(BusRoute.Stop(code))
                                    }
                                }
                        }
                        else -> {
                            Row(
                                Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Label(stringResource(R.string.buses_n_stops, line.stops.distinctBy { it.code }.size), Modifier.weight(1f))
                                line.asOfMs?.let {
                                    Text(updated(it, now), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                                }
                            }
                            LineList(
                                line,
                                Color(color),
                                colors = routeColors,
                                onHere = { hereY = it },
                            ) { code ->
                                vm.open(BusRoute.Stop(code))
                            }
                            if (line.here != null && line.running)
                                Text(
                                    stringResource(R.string.buses_times_here_only),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = c.onSurfaceVariant,
                                    modifier = Modifier.padding(top = 12.dp),
                                )
                        }
                    }
                }
            }
            StatusStrip(phase, top, scroll)
        }
    }
}

@Composable
private fun LineList(
    line: Line,
    color: Color,
    colors: Map<String, Long>,
    onHere: (Int) -> Unit,
    waiting: Boolean = false,
    onStop: (String) -> Unit,
) {
    val items = line.items()
    val c = MaterialTheme.colorScheme
    for ((i, item) in items.withIndex()) {
        val first = i == 0
        val last = i == items.lastIndex
        when (item) {
            is LineItem.Stop -> {
                val here = item.here
                Row(
                    Modifier.fillMaxWidth()
                        .height(IntrinsicSize.Min)
                        .clip(RoundedCornerShape(14.dp))
                        .background(if (here) c.primaryContainer else Color.Transparent)
                        .then(if (here) Modifier.onGloballyPositioned { onHere(it.positionInParent().y.toInt()) } else Modifier)
                        .clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_open_stop)) { onStop(item.stop.code) }
                ) {
                    Rail(color, first, last, bus = item.buses.isNotEmpty(), here = here)
                    Column(Modifier.weight(1f).padding(vertical = 10.dp).padding(end = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(item.stop.name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                if (item.stop.services.isNotEmpty()) {
                                    @OptIn(ExperimentalLayoutApi::class)
                                    FlowRow(
                                        Modifier.padding(top = 4.dp),
                                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                                        verticalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        for (svc in item.stop.services) BusBadge(svc, colors[svc] ?: GREY, 10.sp, pad = 4.dp, even = true)
                                    }
                                }
                            }
                            if (here && waiting) HereTimeWaiting()
                            if (here) line.here?.row?.takeIf { it.running }?.let { HereTime(it) }
                        }
                        if (here) Box(Modifier.padding(top = 6.dp)) { Tag(stringResource(R.string.buses_your_stop), c.primary) }
                        if (item.buses.isNotEmpty()) BusesOnLine(item.buses, stringResource(R.string.buses_at_stop))
                    }
                }
            }
            is LineItem.Between ->
                Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                    Rail(color, first = false, last = last, bus = true, here = false)
                    Box(Modifier.weight(1f).padding(vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                        BusesOnLine(item.buses, stringResource(R.string.buses_on_the_way))
                    }
                }
        }
    }
}

@Composable
private fun LineSkeleton(color: Color) {
    val faded = lerp(MaterialTheme.colorScheme.background, color, 0.3f)
    Skeleton(stringResource(R.string.checking)) {
        Box(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 8.dp)) { TextBar(MaterialTheme.typography.labelMedium, fraction = 0.22f) }
        for (i in 0 until 6) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
                Rail(faded, first = i == 0, last = i == 5, bus = false, here = false)
                Column(Modifier.weight(1f).padding(vertical = 10.dp).padding(end = 10.dp)) {
                    TextBar(MaterialTheme.typography.titleMedium, fraction = barFraction(i))
                    Bar(Modifier.padding(top = 4.dp).size(24.dp, 26.dp), RoundedCornerShape(6.dp))
                }
            }
        }
    }
}

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
        modifier =
            Modifier.background(c.surface, RoundedCornerShape(6.dp))
                .border(1.dp, c.outlineVariant, RoundedCornerShape(6.dp))
                .padding(horizontal = 6.dp, vertical = 1.dp),
    )
}

@Composable
private fun HereTimeWaiting() {
    Column(horizontalAlignment = Alignment.End) {
        TextBar(TextStyle(fontSize = 34.sp, lineHeight = 40.sp), width = 64.dp)
        TextBar(MaterialTheme.typography.bodySmall, width = 52.dp)
    }
}

@Composable
private fun HereTime(row: BoardRow) {
    Column(horizontalAlignment = Alignment.End) {
        BigTime(row.etaS, row.quality, BusTimes.arriving(row.etaS, row.quality), row.eta)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            QualityTag(row)
        }
        thenText(row)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

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
            Box(
                Modifier.size(28.dp).background(color, RoundedCornerShape(8.dp)).border(2.dp, paper, RoundedCornerShape(8.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(painterResource(R.drawable.ic_bus), contentDescription = null, tint = inkOn(color), modifier = Modifier.size(16.dp))
            }
        }
    }
}
