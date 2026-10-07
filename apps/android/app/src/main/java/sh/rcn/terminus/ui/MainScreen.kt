package sh.rcn.terminus.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.IconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.produceState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.R
import sh.rcn.terminus.Target
import sh.rcn.terminus.soonOnCampus
import sh.rcn.terminus.widget.clock

/** Minutes past midnight on the phone's clock, for the sky's hour. */
private fun minuteOfDay(): Int = java.time.LocalTime.now().let { it.hour * 60 + it.minute }

/**
 * The hour of the sky over Now, and over Settings' list: by the phone's
 * clock, ticking each minute, and night after your day (Next resting).
 */
@Composable
internal fun skyPhase(state: UiState): Phase {
    val minute by produceState(minuteOfDay()) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000)
            value = minuteOfDay()
        }
    }
    return if (!state.showNearby && state.answer?.mode == "rest") Phase.NIGHT else phaseAt(minute)
}

@Composable
internal fun MainScreen(state: UiState, vm: MainViewModel, insets: PaddingValues, onOpenStop: (String) -> Unit) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    // After two refusals Android stops showing the dialog, and the button
    // would do nothing. Then the only way is the app's settings page.
    var blocked by rememberSaveable { mutableStateOf(false) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
        val activity = ctx as? android.app.Activity
        blocked = !hasLocation && activity?.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) == false
        vm.load()
    }
    val openSettings = { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))) }

    // Keep the answer fresh while the app is on screen; the API's own cache
    // is 15 s, so polling faster than that would show nothing new.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Location may have been allowed in system settings meanwhile.
            hasLocation = Locator.hasForeground(ctx)
            while (true) {
                vm.load()
                delay(30_000)
            }
        }
    }

    // Now's sky, by the hour (always night after your day): whatever's shown
    // under the chips says where it ends, and the header, chips and status
    // bar take its ink over it. One sky for the tab, so it stays as the
    // chips switch.
    val scroll = rememberScrollState()
    val sky = rememberSky(scroll, skyPhase(state))
    val page = MaterialTheme.colorScheme.background
    val shown = sky.end != null
    val light = sky.palette.lightInk
    NightStatusBar(shown && light)
    CompositionLocalProvider(LocalSky provides sky) { Box(Modifier.fillMaxSize()) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .onGloballyPositioned { sky.contentTop = it.positionInRoot().y }
            .skyBehind(sky, page)
            .padding(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding())
            .padding(horizontal = 16.dp),
    ) {
        SkyInk(shown, light) { Column {
        TabHeader { HeaderWordmark() }

        state.update?.let { v ->
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.update_out, v), modifier = Modifier.weight(1f))
                    // The APK built for this phone's CPU (the site falls back to arm64).
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/download/android?abi=${android.os.Build.SUPPORTED_ABIS.firstOrNull().orEmpty()}".toUri())) }) { Text(stringResource(R.string.update)) }
                }
            }
        }

        if (!hasLocation) {
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text(stringResource(R.string.location_ask))
                    if (blocked) {
                        TextButton(onClick = openSettings) { Text(stringResource(R.string.open_settings_location)) }
                    } else {
                        TextButton(onClick = {
                            askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        }) { Text(stringResource(R.string.allow_location)) }
                    }
                }
            }
        }

        // Next and Nearby first, as on the widget, then favourites and the
        // places added from "Go somewhere else" (each with an X); the row
        // scrolls, and the edge fades while there's more.
        val chips = rememberScrollState()
        var searching by rememberSaveable { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f).fadeEnd(chips).horizontalScroll(chips), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = !state.showNearby && state.target == Target.Plan, onClick = { vm.select(Target.Plan) }, label = { Text(stringResource(R.string.chip_next)) }, colors = chosenChip())
                FilterChip(selected = state.showNearby, onClick = vm::showNearby, label = { Text(stringResource(R.string.chip_nearby)) }, colors = chosenChip())
                for (p in state.places) {
                    FilterChip(
                        selected = !state.showNearby && state.target == Target.SavedPlace(p.key),
                        onClick = { vm.select(Target.SavedPlace(p.key)) },
                        label = { Text(p.label) },
                        colors = chosenChip(),
                    )
                }
                for (d in state.added) {
                    val code = d.id.removePrefix("stop:")
                    AddedChip(
                        label = d.label,
                        selected = !state.showNearby && (state.target as? Target.Code)?.code == code,
                        onClick = { vm.select(Target.Code(code, d.label)) },
                        onRemove = { vm.removeAdded(d) },
                    )
                }
            }
            // Go somewhere else: the search opens under the chips.
            IconButton(onClick = { searching = !searching }) {
                Icon(painterResource(R.drawable.ic_search), contentDescription = stringResource(R.string.go_somewhere_else))
            }
        }
        if (searching) Search(state, vm) { searching = false }
        } }
        Spacer(Modifier.height(12.dp))

        // A minimum height keeps the chips and search from jumping as views
        // switch or data arrives.
        Box(Modifier.fillMaxWidth().heightIn(min = 180.dp)) {
            if (state.showNearby) Column {
                SkyHead(26.dp) {}
                SkyGround()
                NearbyList(state.nearby, state.loading, onOpenStop)
            } else {
                // The last refresh failed: offline, the day plan kept for it stands in for a stale answer.
                val offline = state.target == Target.Plan && state.paired && state.error != null && !state.loading
                OfflinePlanOr(offline, state.answer, state.fetchedAt, state.day) {
                    AnswerCard(state.answer, state.loading, vm::signal, state.signalling, vm::choose, onPlace = { vm.select(Target.SavedPlace(it)) })
                }
            }
        }
        // The rest of today under the planned answer.
        if (!state.showNearby && state.target == Target.Plan) state.day?.let {
            DayTimeline(it, state.swipeHint, state.swipePeek, vm::removeFromToday, vm::swipePeeked)
        }
        // Somewhere else: going there later today, planned like a class (phase 8.3).
        if (!state.showNearby && state.target != Target.Plan && state.paired) {
            TimeButton(stringResource(R.string.go_later), null, vm::goLater, Modifier.padding(top = 8.dp), initial = ::soonOnCampus)
        }

        val footer = listOfNotNull(
            state.error,
            state.fetchedAt?.let { stringResource(R.string.updated_at, clock(ctx, it)) },
        ).joinToString(" · ")
        val refreshing = stringResource(R.string.refreshing)
        // One quiet line, as the web shows it: "Updated 9:41 · Is this wrong?",
        // and "✓ Reported, thanks" in the link's place for a few seconds once it's sent.
        val small = MaterialTheme.typography.bodySmall
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        Row(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(12.dp).semantics { contentDescription = refreshing }, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(footer, style = small, color = muted, modifier = Modifier.weight(1f, fill = false))
            if (!state.showNearby && state.answer != null) {
                if (footer.isNotEmpty()) Text(" · ", style = small, color = muted)
                if (state.reportShown) {
                    Text("✓ " + stringResource(R.string.reported_thanks), style = small, color = goodColor())
                } else {
                    var reporting by remember { mutableStateOf<String?>(null) }
                    var reportingFor by remember { mutableStateOf<Target>(Target.Plan) }
                    var opened by remember { mutableStateOf(false) }
                    Text(
                        stringResource(R.string.is_this_wrong),
                        style = small.copy(textDecoration = TextDecoration.Underline),
                        color = muted,
                        modifier = Modifier
                            .clickable(role = Role.Button) {
                                reporting = state.rawAnswers[state.target]
                                reportingFor = state.target
                                opened = true
                                vm.clearReportResult()
                            }
                            // A taller target than the words, for a thumb.
                            .padding(vertical = 10.dp),
                    )
                    if (opened) {
                        ReportDialog(
                            sending = state.reportSending,
                            onSend = { note ->
                                vm.report(note, reporting, reportingFor, BuildConfig.VERSION_NAME)
                                opened = false
                            },
                            onDismiss = { opened = false },
                        )
                    }
                }
            }
        }
        // Only a failure: a report that went shows in the line above.
        state.reportResult?.let {
            Text(it, style = small, color = MaterialTheme.colorScheme.error)
        }

        Spacer(Modifier.height(24.dp))
    }
    StatusStrip(sky, insets.calculateTopPadding(), scroll)
    } }
}

/** Asks for notification permission on the way to "on", and says so when it's refused. */
@Composable
internal fun NotifyToggle(title: String, hint: String, on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit, inCard: Boolean = false) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refused = !granted
        if (granted) onChange(true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = on,
                role = Role.Switch,
                onValueChange = { want ->
                    when {
                        !want -> onChange(false)
                        LeaveAlerts.canNotify(ctx) -> onChange(true)
                        // Only reached on Android 13+, where the permission exists.
                        else -> @Suppress("InlinedApi") ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
            .padding(horizontal = if (inCard) 16.dp else 0.dp, vertical = if (inCard) 10.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(
                hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
    if (refused && !on) {
        Text(stringResource(R.string.notifications_off), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = if (inCard) 16.dp else 0.dp))
        TextButton(onClick = openSettings, modifier = Modifier.padding(horizontal = if (inCard) 4.dp else 0.dp)) { Text(stringResource(R.string.open_settings)) }
    }
}

/**
 * "Notice when I board" (phase 8.1): the live notification follows the trip by
 * location. Needs notifications and precise location, asked for on the way to on.
 */
@Composable
internal fun DetectToggle(on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit, hint: String? = null, inCard: Boolean = false) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val ok = granted[Manifest.permission.ACCESS_FINE_LOCATION] == true && LeaveAlerts.canNotify(ctx)
        refused = !ok
        if (ok) onChange(true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = on,
                role = Role.Switch,
                onValueChange = { want ->
                    when {
                        !want -> onChange(false)
                        Locator.hasPrecise(ctx) && LeaveAlerts.canNotify(ctx) -> onChange(true)
                        else -> ask.launch(
                            listOfNotNull(
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION,
                                if (android.os.Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null,
                            ).toTypedArray(),
                        )
                    }
                },
            )
            .padding(horizontal = if (inCard) 16.dp else 0.dp, vertical = if (inCard) 10.dp else 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.detect))
            Text(
                hint ?: stringResource(R.string.detect_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
    if (refused && !on) {
        Text(stringResource(R.string.detect_needs), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = if (inCard) 16.dp else 0.dp))
        TextButton(onClick = openSettings, modifier = Modifier.padding(horizontal = if (inCard) 4.dp else 0.dp)) { Text(stringResource(R.string.open_settings)) }
    }
}

/** "Is this wrong?": an optional note, sent with the answer that was on screen. */
@Composable
private fun ReportDialog(sending: Boolean, onSend: (String) -> Unit, onDismiss: () -> Unit) {
    var note by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.report_title)) },
        text = {
            Column {
                OutlinedTextField(
                    value = note,
                    onValueChange = { if (it.length <= 1000) note = it },
                    placeholder = { Text(stringResource(R.string.report_placeholder)) },
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    stringResource(R.string.report_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSend(note) }, enabled = !sending) { Text(stringResource(R.string.send)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

/** Fades the trailing edge out while [scroll] can still go further, so a cut-off row reads as scrollable. */
/** The chip showing, filled in the ink (the web's too), so it stands out from the rest over any sky. */
@Composable
private fun chosenChip() = MaterialTheme.colorScheme.let {
    androidx.compose.material3.FilterChipDefaults.filterChipColors(selectedContainerColor = it.onSurface, selectedLabelColor = it.background)
}

/**
 * A place added from "Go somewhere else": a tab with an X that removes it.
 * Scrolled into view when it's the one showing, as a new one is.
 */
@Composable
private fun AddedChip(label: String, selected: Boolean, onClick: () -> Unit, onRemove: () -> Unit) {
    val reveal = remember { androidx.compose.foundation.relocation.BringIntoViewRequester() }
    LaunchedEffect(selected) { if (selected) reveal.bringIntoView() }
    val remove = stringResource(R.string.remove_tab, label)
    androidx.compose.material3.InputChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
        colors = MaterialTheme.colorScheme.let {
            androidx.compose.material3.InputChipDefaults.inputChipColors(selectedContainerColor = it.onSurface, selectedLabelColor = it.background, selectedTrailingIconColor = it.background)
        },
        trailingIcon = {
            androidx.compose.material3.Icon(
                androidx.compose.ui.res.painterResource(R.drawable.ic_close),
                contentDescription = remove,
                modifier = Modifier.size(18.dp).clickable(onClickLabel = remove, role = androidx.compose.ui.semantics.Role.Button, onClick = onRemove),
            )
        },
        modifier = Modifier
            .bringIntoViewRequester(reveal)
            .semantics { customActions = listOf(androidx.compose.ui.semantics.CustomAccessibilityAction(remove) { onRemove(); true }) },
    )
}

private fun Modifier.fadeEnd(scroll: ScrollState, width: Dp = 32.dp): Modifier =
    graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen).drawWithContent {
        drawContent()
        if (scroll.canScrollForward) {
            val w = width.toPx()
            drawRect(
                Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), startX = size.width - w, endX = size.width),
                topLeft = Offset(size.width - w, 0f),
                blendMode = BlendMode.DstIn,
            )
        }
    }
