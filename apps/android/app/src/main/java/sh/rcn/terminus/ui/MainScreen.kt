package sh.rcn.terminus.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.R
import sh.rcn.terminus.Target
import sh.rcn.terminus.soonOnCampus
import sh.rcn.terminus.widget.clock

/** Minutes past midnight on the phone's clock, for the sky's hour. */
private fun minuteOfDay(): Int = java.time.LocalTime.now().let { it.hour * 60 + it.minute }

/**
 * The hour of the sky over Now, and in Settings' bands: by the phone's
 * clock, ticking each minute, whatever the chip shows.
 */
@Composable
internal fun skyPhase(): Phase {
    val minute by produceState(minuteOfDay()) {
        while (true) {
            delay(60_000 - System.currentTimeMillis() % 60_000)
            value = minuteOfDay()
        }
    }
    return phaseAt(minute)
}

@Composable
internal fun MainScreen(state: UiState, vm: MainViewModel, insets: PaddingValues, email: String?, onAddEmail: () -> Unit, onOpenStop: (String) -> Unit) {
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
    val openSettings = { ctx.openAppSettings() }

    // Keep the answer fresh while the app is on screen: every 30 s (POLL_MS).
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            // Location may have been allowed in system settings meanwhile.
            hasLocation = Locator.hasForeground(ctx)
            while (true) {
                vm.load()
                // Never sooner than a 429's or a 503's Retry-After.
                delay(maxOf(POLL_MS, sh.rcn.terminus.Quiet.waitMs()))
            }
        }
    }

    // Now's sky, by the hour: whatever's shown
    // under the chips says where it ends, and the header, chips and status
    // bar take its ink over it. One sky for the tab, so it stays as the
    // chips switch.
    val scroll = rememberScrollState()
    val sky = rememberSky(scroll, skyPhase())
    val page = MaterialTheme.colorScheme.background
    val shown = sky.end != null
    val light = sky.palette.lightInk
    NightStatusBar(shown && light)
    CompositionLocalProvider(LocalSky provides sky) { Box(Modifier.fillMaxSize()) {
    // Pulled down at the top, what's shown (the card or Nearby) is asked for
    // again: the sky stretches, and your bus drives to your stop on its horizon.
    BusPull(sky.road.bus?.takeIf { sky.road.stop }?.color, scene = { roadScene(it, sky.road) }, onRefresh = vm::pull) { pull -> Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .onGloballyPositioned { sky.contentTop = it.positionInRoot().y }
            .skyBehind(sky, page, pull)
            .padding(top = insets.calculateTopPadding(), bottom = insets.calculateBottomPadding())
            .padding(horizontal = 16.dp),
    ) {
        // The header and chips come down a little with a pull; the room opens under them.
        SkyInk(shown, light) { Column(Modifier.pullLead(pull)) {
        TabHeader { HeaderWordmark() }

        // Refused as too old (426): the way to update, from where it was installed.
        if (state.updateRequired) {
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.update_required), modifier = Modifier.weight(1f))
                    TextButton(onClick = { ctx.openUpdate() }) { Text(stringResource(R.string.update)) }
                }
            }
        } else state.update?.let { v ->
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.update_out, v), modifier = Modifier.weight(1f))
                    // The APK built for this phone's CPU (the site falls back to arm64).
                    TextButton(onClick = { ctx.openUpdate() }) { Text(stringResource(R.string.update)) }
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
                OfflinePlanOr(offline, state.answer, state.day) {
                    // Undo once: on Today's row while it's there for this trip, not on the card as well.
                    AnswerCard(withoutLocalUndo(state.answer, state.removed?.takeIf { !it.failed }?.item?.key), state.loading, vm::signal, state.signalling, vm::choose, onPlace = { vm.select(Target.SavedPlace(it)) })
                }
            }
        }
        // The rest of today under the planned answer.
        if (!state.showNearby && state.target == Target.Plan) state.day?.let {
            DayTimeline(it, state.removed, vm::removeFromToday, vm::undoRemove, vm::dismissRemoved)
        }
        // Somewhere else: going there later today, planned like a class.
        if (!state.showNearby && state.target != Target.Plan && state.paired) {
            TimeButton(stringResource(R.string.go_later), null, vm::goLater, Modifier.padding(top = 8.dp), initial = ::soonOnCampus)
        }

        val footer = listOfNotNull(
            state.error,
            state.fetchedAt?.let { stringResource(R.string.updated_at, clock(ctx, it)) },
        ).joinToString(" · ")
        val refreshing = stringResource(R.string.refreshing)
        // One quiet line, as the web shows it: "Updated 9:41 · Is this wrong?".
        val small = MaterialTheme.typography.bodySmall
        val muted = MaterialTheme.colorScheme.onSurfaceVariant
        Row(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(min = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(12.dp).semantics { contentDescription = refreshing }, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            // A failed refresh is said as it happens; "Updated 9:41" alone isn't.
            val failed = state.error != null
            Text(footer, style = small, color = muted, modifier = Modifier.weight(1f, fill = false).semantics { if (failed) liveRegion = LiveRegionMode.Polite })
            if (!state.showNearby && state.answer != null) {
                if (footer.isNotEmpty()) Text(" · ", style = small, color = muted)
                var reporting by remember { mutableStateOf<String?>(null) }
                var reportingLine by remember { mutableStateOf("") }
                var opened by remember { mutableStateOf(false) }
                Text(
                    stringResource(R.string.is_this_wrong),
                    style = small.copy(textDecoration = TextDecoration.Underline),
                    color = muted,
                    modifier = Modifier
                        .clickable(role = Role.Button) {
                            reporting = state.rawAnswers[state.target]
                            reportingLine = state.answer?.card?.line ?: state.answer?.label ?: ""
                            opened = true
                            vm.reportOpened()
                        }
                        // A target 48 dp tall, though the words are small, for a thumb.
                        .heightIn(min = 48.dp)
                        .wrapContentHeight()
                        .padding(horizontal = 4.dp),
                )
                if (opened) {
                    ReportSheet(
                        line = reportingLine,
                        email = email,
                        sending = state.reportSending,
                        sent = state.reportSent,
                        failure = state.reportResult,
                        onSend = { reason, note -> vm.report(reason, note, reporting, BuildConfig.VERSION_NAME) },
                        onAddEmail = {
                            opened = false
                            onAddEmail()
                        },
                        onDismiss = { opened = false },
                    )
                }
            }
        }

        Spacer(Modifier.height(24.dp))
    } }
    StatusStrip(sky, insets.calculateTopPadding(), scroll)
    } }
}

/**
 * Asks for notification permission on the way to "on", and says so when it's
 * refused, or when notifications (or this one's [channel]) are off in the
 * phone's settings, where asking can't help.
 */
@Composable
internal fun NotifyToggle(title: String, hint: String, on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit, inCard: Boolean = false, channel: String? = null) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        val ok = LeaveAlerts.canNotify(ctx, channel)
        refused = !ok
        if (ok) onChange(true)
    }
    ToggleLine(title, hint, on, inCard) { want ->
        when {
            !want -> onChange(false)
            LeaveAlerts.canNotify(ctx, channel) -> onChange(true)
            // Android 13+, where the permission exists and isn't given yet.
            LeaveAlerts.needsPermission(ctx) -> @Suppress("InlinedApi") ask.launch(Manifest.permission.POST_NOTIFICATIONS)
            else -> refused = true
        }
    }
    if (refused && !on) Refused(stringResource(R.string.notifications_off), openSettings, inCard)
}

/** A setting's switch: its name and a line under it, the whole row the target. [inCard]: padded as a row of a group. */
@Composable
private fun ToggleLine(title: String, hint: String, on: Boolean, inCard: Boolean, onValueChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(value = on, role = Role.Switch, onValueChange = onValueChange)
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
}

/** Why a switch stayed off (a permission refused), and the app's settings page to allow it there. */
@Composable
internal fun Refused(text: String, openSettings: () -> Unit, inCard: Boolean) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = if (inCard) 16.dp else 0.dp))
    TextButton(onClick = openSettings, modifier = Modifier.padding(horizontal = if (inCard) 4.dp else 0.dp)) { Text(stringResource(R.string.open_settings)) }
}

/** The reasons offered as chips, as /me/feedback takes them (REASONS in the API's feedback.ts). */
private val REPORT_REASONS = listOf(
    "never-came" to R.string.report_never_came,
    "times-off" to R.string.report_times_off,
    "wrong-stop" to R.string.report_wrong_stop,
    "walk-longer" to R.string.report_walk_longer,
    "wrong-class" to R.string.report_wrong_class,
)

/**
 * "Is this wrong?", as the web's sheet: the answer it's about (`line`), the
 * reasons as chips, a note, and who the reply goes to. A reason or a note
 * sends it; once `sent`, the sheet says so, which is the only confirmation.
 * Without an email the server takes no reports, so it asks for one instead.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
private fun ReportSheet(
    line: String,
    email: String?,
    sending: Boolean,
    sent: Boolean,
    failure: String?,
    onSend: (String?, String) -> Unit,
    onAddEmail: () -> Unit,
    onDismiss: () -> Unit,
) {
    var reason by rememberSaveable { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    val colors = MaterialTheme.colorScheme
    val wide = Modifier.fillMaxWidth().heightIn(min = 52.dp)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 20.dp).verticalScroll(rememberScrollState())) {
            when {
                sent -> {
                    val good = if (colors.surface.luminance() < 0.5f) GoodDark else GoodLight
                    Box(
                        Modifier.align(Alignment.CenterHorizontally).size(56.dp).clip(CircleShape).background(good.copy(alpha = 0.18f)),
                        contentAlignment = Alignment.Center,
                    ) { Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = good, modifier = Modifier.size(30.dp)) }
                    Spacer(Modifier.height(14.dp))
                    Text(
                        stringResource(R.string.report_sent_title),
                        style = MaterialTheme.typography.titleLarge,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().semantics { liveRegion = LiveRegionMode.Polite },
                    )
                    if (email != null) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            withEmail(stringResource(R.string.report_sent_body, email), email, colors.onSurface),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                    Spacer(Modifier.height(20.dp))
                    FilledTonalButton(onClick = onDismiss, modifier = wide) { Text(stringResource(R.string.done)) }
                }
                email == null -> {
                    Text(stringResource(R.string.report_title), style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(10.dp))
                    Text(stringResource(R.string.report_needs_email), style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
                    Spacer(Modifier.height(20.dp))
                    Button(onClick = onAddEmail, modifier = wide) { Text(stringResource(R.string.add_email)) }
                }
                else -> {
                    Text(stringResource(R.string.report_title), style = MaterialTheme.typography.titleLarge)
                    if (line.isNotEmpty()) {
                        Spacer(Modifier.height(14.dp))
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(colors.surfaceVariant).height(IntrinsicSize.Min).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Box(Modifier.width(4.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(colors.primary))
                            Spacer(Modifier.width(10.dp))
                            Text(line, style = MaterialTheme.typography.titleSmall)
                        }
                    }
                    Spacer(Modifier.height(16.dp))
                    Text(stringResource(R.string.report_pick), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        REPORT_REASONS.forEach { (key, label) ->
                            val on = reason == key
                            FilterChip(
                                selected = on,
                                onClick = { reason = if (on) null else key },
                                label = { Text(stringResource(label)) },
                                leadingIcon = if (on) {
                                    { Icon(painterResource(R.drawable.ic_check), contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) }
                                } else {
                                    null
                                },
                                colors = chosenChip(),
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    val noteLabel = stringResource(R.string.report_note)
                    TextField(
                        value = note,
                        onValueChange = { if (it.length <= 1000) note = it },
                        placeholder = { Text(stringResource(R.string.report_placeholder)) },
                        minLines = 3,
                        maxLines = 6,
                        shape = RoundedCornerShape(12.dp),
                        colors = TextFieldDefaults.colors(
                            focusedIndicatorColor = Color.Transparent,
                            unfocusedIndicatorColor = Color.Transparent,
                            disabledIndicatorColor = Color.Transparent,
                        ),
                        modifier = Modifier.fillMaxWidth().semantics { contentDescription = noteLabel },
                    )
                    Spacer(Modifier.height(12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(painterResource(R.drawable.ic_mail), contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(10.dp))
                        Text(
                            withEmail(stringResource(R.string.report_hint, email), email, colors.onSurface),
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.onSurfaceVariant,
                        )
                    }
                    failure?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, style = MaterialTheme.typography.bodySmall, color = colors.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    }
                    Spacer(Modifier.height(16.dp))
                    Button(
                        onClick = { onSend(reason, note) },
                        enabled = !sending && (reason != null || note.isNotBlank()),
                        modifier = wide,
                    ) { Text(stringResource(if (sending) R.string.sending else R.string.send)) }
                }
            }
        }
    }
}

/** `text` with the email address in it picked out, as the web's sheet shows it. */
private fun withEmail(text: String, email: String, ink: Color) = buildAnnotatedString {
    append(text)
    val at = text.indexOf(email)
    if (at >= 0) addStyle(SpanStyle(color = ink, fontWeight = FontWeight.SemiBold), at, at + email.length)
}

/** The chip showing, filled in the ink (the web's too), so it stands out from the rest over any sky. */
@Composable
private fun chosenChip() = MaterialTheme.colorScheme.let {
    FilterChipDefaults.filterChipColors(selectedContainerColor = it.onSurface, selectedLabelColor = it.background)
}

/**
 * A place added from "Go somewhere else": a tab with an X that removes it.
 * Scrolled into view when it's the one showing, as a new one is.
 */
@Composable
private fun AddedChip(label: String, selected: Boolean, onClick: () -> Unit, onRemove: () -> Unit) {
    val reveal = remember { BringIntoViewRequester() }
    LaunchedEffect(selected) { if (selected) reveal.bringIntoView() }
    val remove = stringResource(R.string.remove_tab, label)
    InputChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label) },
        colors = MaterialTheme.colorScheme.let {
            InputChipDefaults.inputChipColors(selectedContainerColor = it.onSurface, selectedLabelColor = it.background, selectedTrailingIconColor = it.background)
        },
        trailingIcon = {
            Icon(
                painterResource(R.drawable.ic_close),
                contentDescription = remove,
                // A bigger target than the 18 dp X, as tall as the chip.
                modifier = Modifier.size(32.dp).clip(CircleShape).clickable(onClickLabel = remove, role = Role.Button, onClick = onRemove).padding(7.dp),
            )
        },
        modifier = Modifier
            .bringIntoViewRequester(reveal)
            .semantics { customActions = listOf(CustomAccessibilityAction(remove) { onRemove(); true }) },
    )
}

/** Fades the trailing edge out while [scroll] can still go further, so a cut-off row reads as scrollable. */
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
