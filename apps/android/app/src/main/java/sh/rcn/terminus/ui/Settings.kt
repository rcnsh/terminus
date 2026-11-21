package sh.rcn.terminus.ui

import android.content.Intent
import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Campus
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Clock
import sh.rcn.terminus.CrashReports
import sh.rcn.terminus.Destination
import sh.rcn.terminus.Device
import sh.rcn.terminus.DeviceKind
import sh.rcn.terminus.L
import sh.rcn.terminus.Lang
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.NewToNus
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.R
import sh.rcn.terminus.RemovedPlace
import sh.rcn.terminus.Servers
import sh.rcn.terminus.Store
import sh.rcn.terminus.Theme
import sh.rcn.terminus.TimetableClass
import sh.rcn.terminus.WEEKDAYS
import sh.rcn.terminus.dayShort
import sh.rcn.terminus.hour12
import sh.rcn.terminus.id
import sh.rcn.terminus.widget.NearbyShared
import sh.rcn.terminus.widget.redrawWidgets

internal enum class SettingsPage(val title: Int) {
    Trips(R.string.heading_your_trips),
    Timetable(R.string.heading_timetable),
    Favourites(R.string.heading_favourites),
    Notifications(R.string.notifications),
    Devices(R.string.heading_devices),
    Language(R.string.heading_language),
    Appearance(R.string.heading_appearance),
    Account(R.string.heading_account),
    About(R.string.about),
    Feedback(R.string.send_feedback),
}

@Composable
internal fun SettingsScreen(
    state: AccountState,
    account: AccountViewModel,
    main: MainViewModel,
    insets: PaddingValues,
    toList: Flow<Unit>,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
    onClose: () -> Unit,
) {
    LifecycleResumeEffect(Unit) {
        account.refresh()
        onPauseOrDispose {}
    }
    LifecycleResumeEffect(state.email) {
        if (state.email != null) account.loadDevices()
        onPauseOrDispose {}
    }
    LaunchedEffect(Unit) { account.loadChoices() }
    LaunchedEffect(Unit) { account.loadCampus() }

    var open by rememberSaveable { mutableStateOf<SettingsPage?>(null) }
    LaunchedEffect(state.sharedLink) { if (state.sharedLink != null) open = SettingsPage.Timetable }
    LaunchedEffect(Unit) { toList.collect { open = null } }
    val wide = windowWidth() == Width.Wide
    BackHandler(enabled = wide || open == null, onBack = onClose)

    val top = insets.calculateTopPadding()
    val bottom = insets.calculateBottomPadding()
    val notices = LocalNotices.current
    LaunchedEffect(state.message) {
        val said = state.message ?: return@LaunchedEffect
        notices?.showSnackbar(Notice(said, duration = SnackbarDuration.Long))
        account.clearMessage()
    }
    val page: @Composable (SettingsPage, Boolean) -> Unit = { page, back ->
        SettingsPagePane(page, top, bottom, back = if (back) ({ open = null }) else null) {
            SettingsPageContent(page, state, account, main, onAddEmail, onSignedOut)
        }
    }
    val scrolls = rememberPaneScrolls()
    scrolls.keep(setOfNotNull(LIST, (if (wide) open ?: SettingsPage.Trips else open)?.name))
    if (wide) {
        val shown = open ?: SettingsPage.Trips
        val skies = remember { PaneSkies() }
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(Widths.PANE.dp).fillMaxHeight()) {
                CompositionLocalProvider(LocalSkyPane provides remember(skies) { SkyPane(skies, leading = true) }) {
                    Keeps(scrolls, LIST) { SettingsList(state, main, top, bottom, chosen = shown) { open = it } }
                }
            }
            VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Box(Modifier.weight(1f).fillMaxHeight()) {
                CompositionLocalProvider(LocalSkyPane provides remember(skies) { SkyPane(skies, leading = false) }) {
                    key(shown) { Keeps(scrolls, shown.name) { page(shown, false) } }
                }
            }
        }
        return
    }
    Column(Modifier.fillMaxSize()) {
        PageStack(listOfNotNull(open), onBack = { open = null }, Modifier.weight(1f)) { shown ->
            if (shown == null) Keeps(scrolls, LIST) { SettingsList(state, main, top, bottom) { open = it } }
            else Keeps(scrolls, shown.name) { page(shown, true) }
        }
    }
}

private const val LIST = "list"

@Composable
private fun SettingsPagePane(page: SettingsPage, top: Dp, bottom: Dp, back: (() -> Unit)?, content: @Composable () -> Unit) {
    Column(Modifier.fillMaxSize().padding(bottom = bottom)) {
        val phase = skyPhase()
        val scroll = rememberPaneScroll()
        Box(Modifier.weight(1f)) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                if (back != null) SkyBand(phase, top) { BackHeader(stringResource(page.title), back) }
                else TitleBand(stringResource(page.title), phase, top, page = true)
                Column(Modifier.column().padding(horizontal = 16.dp)) {
                    content()
                    Spacer(Modifier.height(32.dp))
                }
            }
            StatusStrip(phase, top, scroll)
        }
    }
}

@Composable
private fun SettingsList(
    state: AccountState,
    main: MainViewModel,
    top: Dp,
    bottom: Dp,
    chosen: SettingsPage? = null,
    onOpen: (SettingsPage) -> Unit,
) {
    val ui by main.state.collectAsStateWithLifecycle()
    val profile = state.profile
    val phase = skyPhase()
    val scroll = rememberPaneScroll()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(bottom = bottom)) {
            TitleBand(stringResource(R.string.settings), phase, top)
            Column(Modifier.column().padding(horizontal = 16.dp)) {
                Spacer(Modifier.height(12.dp))
                AccountTile(state, ui, chosen == SettingsPage.Account, onOpen)
                SettingsGround(state, ui, profile, chosen, onOpen)
            }
        }
        StatusStrip(phase, top, scroll)
    }
}

@Composable
private fun AccountTile(state: AccountState, ui: UiState, chosen: Boolean, onOpen: (SettingsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    LinkTile({ onOpen(SettingsPage.Account) }, Modifier.fillMaxWidth().chosenCard(chosen, 18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val email = state.email
            if (email != null) {
                Initial(email, 44.dp, 18.sp)
            } else {
                BrandMark(Modifier.size(44.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(
                    email ?: stringResource(R.string.not_signed_in),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                summary(SettingsPage.Devices, state, ui)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = muted)
        }
    }
}

@Composable
private fun Initial(email: String, size: Dp, fontSize: TextUnit) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.size(size).background(c.primary, CircleShape), contentAlignment = Alignment.Center) {
        Text(email.take(1).uppercase(), color = c.onPrimary, fontWeight = FontWeight.ExtraBold, fontSize = fontSize)
    }
}

private val GROUPS =
    listOf(
        listOf(
            SettingsPage.Trips to R.drawable.ic_pin,
            SettingsPage.Timetable to R.drawable.ic_calendar,
            SettingsPage.Favourites to R.drawable.ic_heart,
            SettingsPage.Notifications to R.drawable.ic_bell,
        ),
        listOf(
            SettingsPage.Language to R.drawable.ic_globe,
            SettingsPage.Appearance to R.drawable.ic_contrast,
            SettingsPage.Devices to R.drawable.ic_devices,
        ),
        listOf(SettingsPage.Feedback to R.drawable.ic_chat),
    )

@Composable
private fun SettingsGround(state: AccountState, ui: UiState, profile: ProfileDoc?, chosen: SettingsPage?, onOpen: (SettingsPage) -> Unit) {
    val stacked = chosen != null
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    val todo = { page: SettingsPage ->
        profile != null &&
            when (page) {
                SettingsPage.Trips -> profile.homeStops.isEmpty()
                SettingsPage.Timetable -> state.needsReimport || profile.trips.size + profile.manual.size == 0
                else -> false
            }
    }
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (group in GROUPS) {
            Group(null) {
                group.forEachIndexed { i, (page, icon) ->
                    if (i > 0) RowDivider()
                    val on = page == chosen
                    Row(
                        Modifier.fillMaxWidth()
                            .chosen(on)
                            .clickable(role = Role.Button) { onOpen(page) }
                            .heightIn(min = 56.dp)
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Box(
                            Modifier.size(32.dp).background(c.primaryContainer, RoundedCornerShape(9.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(painterResource(icon), contentDescription = null, tint = c.primary, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(14.dp))
                        val said =
                            when (page) {
                                SettingsPage.Feedback -> null
                                SettingsPage.Language,
                                SettingsPage.Appearance -> displaySummary(page, state)
                                else -> summary(page, state, ui)
                            }
                        val off = page == SettingsPage.Notifications && !ui.leaveAlerts && !ui.liveUpdates
                        val ask = todo(page)
                        val value: @Composable (Modifier, TextAlign) -> Unit = { modifier, align ->
                            Text(
                                said.orEmpty(),
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (off) c.tertiary else if (ask) c.primary else muted,
                                fontWeight = if (off || ask) FontWeight.SemiBold else null,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                textAlign = align,
                                modifier = modifier,
                            )
                        }
                        if (stacked) {
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(page.title), style = MaterialTheme.typography.bodyLarge, maxLines = 1)
                                if (!said.isNullOrEmpty()) value(Modifier, TextAlign.Start)
                            }
                        } else {
                            Text(stringResource(page.title), style = MaterialTheme.typography.bodyLarge, maxLines = 1)
                            Spacer(Modifier.width(12.dp))
                            value(Modifier.weight(1f), TextAlign.End)
                        }
                        Spacer(Modifier.width(4.dp))
                        Icon(
                            painterResource(R.drawable.ic_chevron),
                            contentDescription = null,
                            tint = muted,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        }
    }
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.Center) {
        val on = chosen == SettingsPage.About
        TextButton(onClick = { onOpen(SettingsPage.About) }, modifier = Modifier.chosen(on)) {
            Text(stringResource(R.string.about))
        }
    }
    Spacer(Modifier.height(16.dp))
}

@Composable
private fun summary(page: SettingsPage, state: AccountState, ui: UiState): String? {
    val profile = state.profile
    return when (page) {
        SettingsPage.Trips ->
            profile?.let {
                val home = it.homeStops.firstOrNull()?.let { code -> state.campus?.stopName(code) ?: code }
                if (home == null) stringResource(R.string.choose_your_stop)
                else "$home · ${stringResource(R.string.pace_summary, stringResource(paceName(it.walkPace)))}"
            }
        SettingsPage.Timetable ->
            if (state.needsReimport) stringResource(R.string.reimport_needed)
            else
                profile?.let {
                    val n = it.trips.size + it.manual.size
                    if (n == 0) stringResource(R.string.import_from_nusmods) else classCount(n)
                }
        SettingsPage.Favourites ->
            profile?.let { p ->
                p.places.joinToString(stringResource(R.string.list_sep)) { it.label }.ifEmpty { stringResource(R.string.none_yet) }
            }
        SettingsPage.Notifications ->
            listOfNotNull(
                    if (ui.leaveAlerts) stringResource(R.string.short_leave_alerts) else null,
                    if (ui.liveUpdates) stringResource(R.string.short_live) else null,
                )
                .joinToString(stringResource(R.string.list_sep))
                .ifEmpty { stringResource(R.string.all_off) }
        SettingsPage.Devices ->
            when {
                state.email == null -> stringResource(R.string.devices_need_email)
                else -> state.devices?.let { deviceCount(it.size) }
            }
        SettingsPage.Account -> state.email ?: stringResource(R.string.not_signed_in)
        else -> null
    }
}

@Composable
private fun classCount(n: Int): String =
    when (n) {
        0 -> stringResource(R.string.no_classes_yet)
        1 -> stringResource(R.string.one_class)
        else -> stringResource(R.string.n_classes, n)
    }

@Composable
private fun deviceCount(n: Int): String = if (n == 1) stringResource(R.string.one_device) else stringResource(R.string.n_devices, n)

@Composable
private fun displaySummary(page: SettingsPage, state: AccountState): String {
    val ctx = LocalContext.current
    return if (page == SettingsPage.Language) {
        listOfNotNull(
                when (Lang.pref(ctx)) {
                    Lang.EN -> "English"
                    Lang.ZH -> "中文"
                    else -> stringResource(DeviceKind.word(R.string.follow_device))
                },
                when (state.profile?.clock) {
                    Clock.H12 -> stringResource(R.string.clock_12)
                    Clock.H24 -> stringResource(R.string.clock_24)
                    else -> null
                },
            )
            .joinToString(" · ")
    } else {
        listOfNotNull(
                stringResource(themeName(Theme.pref(ctx))),
                stringResource(CardStyle.name(CardStyle.pref(ctx))),
                stringResource(R.string.new_to_nus).takeIf { NewToNus.on(ctx) },
            )
            .joinToString(" · ")
    }
}

private fun themeName(theme: String) =
    when (theme) {
        Theme.LIGHT -> R.string.theme_light
        Theme.DARK -> R.string.theme_dark
        else -> DeviceKind.word(R.string.follow_device)
    }

private fun paceName(pace: String) =
    when (pace) {
        "slow" -> R.string.pace_slow
        "fast" -> R.string.pace_fast
        else -> R.string.pace_normal
    }

@Composable
private fun SettingsSkeleton() {
    Skeleton(stringResource(R.string.checking)) {
        Groups {
            Column {
                TextBar(MaterialTheme.typography.labelMedium, Modifier.padding(start = 4.dp, bottom = 8.dp), width = 96.dp)
                Group(null) {
                    for (i in 0 until 3) {
                        if (i > 0) RowDivider()
                        Column(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp)) {
                            TextBar(MaterialTheme.typography.bodyLarge, fraction = barFraction(i) - 0.2f)
                            TextBar(MaterialTheme.typography.bodyMedium, fraction = barFraction(i, 1))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsPageContent(
    page: SettingsPage,
    state: AccountState,
    account: AccountViewModel,
    main: MainViewModel,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val profile = state.profile
    val needsProfile = page in setOf(SettingsPage.Trips, SettingsPage.Timetable, SettingsPage.Favourites)
    if (needsProfile && profile == null) {
        SettingsSkeleton()
        return
    }
    when (page) {
        SettingsPage.Trips -> {
            if (profile == null) return
            TripsSettings(profile, state, account)
        }
        SettingsPage.Timetable ->
            Groups {
                if (profile == null) return@Groups
                var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: profile.share.orEmpty()) }
                if (state.needsReimport) {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(stringResource(R.string.reimport_title), style = MaterialTheme.typography.titleSmall)
                            Text(stringResource(R.string.reimport_text, state.term.orEmpty()), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                Group(stringResource(R.string.heading_from_nusmods), stringResource(R.string.nusmods_hint)) {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                        TimetableImport(state, account, link, inSettings = true) { link = it }
                    }
                }
                Classes(profile, state.campus, account)
            }
        SettingsPage.Favourites -> if (profile != null) Groups { Favourites(profile, state.campus, account) }
        SettingsPage.Notifications -> Groups { NotificationSettings(main) }
        SettingsPage.Devices ->
            Groups {
                if (state.email == null) {
                    Hint(stringResource(DeviceKind.word(R.string.not_signed_in_hint)))
                    InkButton(stringResource(R.string.add_email), onAddEmail)
                } else {
                    Devices(state, account, main, onSignedOut)
                }
            }
        SettingsPage.Language ->
            Groups {
                LanguagePicker(account)
                Group(stringResource(R.string.time_format), stringResource(DeviceKind.word(R.string.time_format_hint_auto))) {
                    ClockPills(state.profile, account)
                }
            }
        SettingsPage.Appearance ->
            Groups {
                ThemePicker()
                CardStylePicker()
                NearbyWidgetSettings()
            }
        SettingsPage.Account -> Groups { AccountSection(state, account, main, onAddEmail, onSignedOut) }
        SettingsPage.About -> Groups { AboutPage() }
        SettingsPage.Feedback -> Groups { FeedbackPage(state, account, onAddEmail) }
    }
}

@Composable
private fun AboutPage() {
    val ctx = LocalContext.current
    var developer by remember { mutableStateOf(Servers.menuUnlocked(ctx)) }
    var taps by remember { mutableIntStateOf(0) }
    val host = BuildConfig.SITE.removePrefix("https://").removePrefix("http://")
    val links =
        listOf(
            Triple(R.string.get_apps, BuildConfig.LINK_BASE, host),
            Triple(R.string.status, "${BuildConfig.LINK_BASE}/status", "$host/status"),
            Triple(R.string.privacy, "${BuildConfig.LINK_BASE}/privacy", "$host/privacy"),
            Triple(R.string.api_docs, "${BuildConfig.LINK_BASE}/docs", "$host/docs"),
            Triple(R.string.source_code, "https://github.com/rcnsh/terminus", "github.com/rcnsh/terminus"),
            Triple(R.string.map_data, "https://www.openstreetmap.org/copyright", "openstreetmap.org"),
            Triple(R.string.aup, "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf", "nus.edu.sg"),
        )
    Column(Modifier.padding(horizontal = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandMark(Modifier.size(44.dp))
            Column(Modifier.padding(start = 12.dp)) {
                Text("terminus", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Hint(
                    stringResource(R.string.about_version, BuildConfig.VERSION_NAME),
                    Modifier.clickable(interactionSource = null, indication = null) {
                        if (developer) return@clickable
                        taps++
                        if (taps >= Servers.UNLOCK_TAPS) {
                            Servers.unlockMenu(ctx)
                            developer = true
                            android.widget.Toast.makeText(ctx, L.s(R.string.developer_on), android.widget.Toast.LENGTH_SHORT).show()
                        }
                    },
                )
            }
        }
        Text(stringResource(R.string.about_what), modifier = Modifier.padding(top = 14.dp))
        Hint(stringResource(R.string.about_independent), Modifier.padding(top = 10.dp))
    }
    Group(stringResource(R.string.heading_more), stringResource(R.string.about_aup)) {
        links.forEachIndexed { i, (title, url, where) ->
            if (i > 0) RowDivider()
            LinkRow(stringResource(title), { ctx.openWeb(url) }, sub = where, away = true)
        }
    }
    if (developer) DeveloperGroups()
}

private const val FEEDBACK_MAX = 1000
private const val FEEDBACK_NEAR = 900

@Composable
private fun FeedbackPage(state: AccountState, account: AccountViewModel, onAddEmail: () -> Unit) {
    val email = state.email
    if (email == null) {
        Group(stringResource(R.string.feedback_needs_email), stringResource(R.string.feedback_needs_email_hint)) {
            InkButton(stringResource(R.string.add_email), onAddEmail, Modifier.fillMaxWidth().padding(16.dp))
        }
        return
    }
    var note by rememberSaveable { mutableStateOf("") }
    val c = MaterialTheme.colorScheme
    val count by animateColorAsState(if (note.length >= FEEDBACK_NEAR) c.tertiary else c.onSurfaceVariant, label = "count")
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Group(null) {
            Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.feedback_from), style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant)
                Spacer(Modifier.width(12.dp))
                Text(
                    email,
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            }
            RowDivider()
            TextField(
                value = note,
                onValueChange = { note = it.take(FEEDBACK_MAX) },
                placeholder = { Text(stringResource(R.string.feedback_placeholder)) },
                minLines = 6,
                maxLines = 10,
                colors =
                    TextFieldDefaults.colors(
                        focusedContainerColor = Color.Transparent,
                        unfocusedContainerColor = Color.Transparent,
                        disabledContainerColor = Color.Transparent,
                        focusedIndicatorColor = Color.Transparent,
                        unfocusedIndicatorColor = Color.Transparent,
                        disabledIndicatorColor = Color.Transparent,
                    ),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = L.s(R.string.feedback_label) },
            )
            RowDivider()
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "${note.length} / $FEEDBACK_MAX",
                    style = MaterialTheme.typography.labelMedium,
                    color = count,
                    modifier = Modifier.weight(1f),
                )
                InkButton(
                    stringResource(R.string.send),
                    { account.sendFeedback(note) { note = "" } },
                    enabled = note.isNotBlank() && !state.busy,
                )
            }
        }
        Group(null) {
            Row(Modifier.padding(16.dp)) {
                Icon(
                    painterResource(R.drawable.ic_chat),
                    contentDescription = null,
                    tint = c.onSurfaceVariant,
                    modifier = Modifier.padding(top = 2.dp).size(20.dp),
                )
                Column(Modifier.padding(start = 12.dp)) {
                    Text(
                        stringResource(R.string.feedback_wrong_title),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                    )
                    Hint(stringResource(R.string.feedback_wrong_hint), Modifier.padding(top = 2.dp))
                }
            }
        }
    }
}

@Composable
private fun NotificationSettings(main: MainViewModel) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ui by main.state.collectAsStateWithLifecycle()
    var exact by remember { mutableStateOf(LeaveAlerts.canBeExact(ctx)) }
    val blocked = {
        val store = Store(ctx)
        (store.leaveAlerts && !LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)) ||
            (store.liveUpdates && !LeaveAlerts.canNotify(ctx, LiveService.CHANNEL))
    }
    var off by remember { mutableStateOf(blocked()) }
    var nearbyWidget by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            exact = LeaveAlerts.canBeExact(ctx)
            off = blocked()
            nearbyWidget = NearbyShared.wanted(ctx)
        }
    }
    val openSettings = { ctx.openAppSettings() }
    if (off) Column { Refused(stringResource(R.string.notifications_off), openSettings, inCard = false) }
    Group(stringResource(R.string.heading_before_class), stringResource(R.string.notify_leave_more)) {
        NotifyToggle(
            stringResource(R.string.notify_leave),
            stringResource(R.string.notify_leave_short),
            ui.leaveAlerts,
            main::setLeaveAlerts,
            openSettings,
            inCard = true,
            channel = LeaveAlerts.CHANNEL,
        )
    }
    Group(stringResource(R.string.heading_during_trip), stringResource(R.string.during_trip_hint)) {
        NotifyToggle(
            stringResource(R.string.live_notification),
            stringResource(R.string.live_notification_short),
            ui.liveUpdates,
            main::setLiveUpdates,
            openSettings,
            inCard = true,
            channel = LiveService.CHANNEL,
        )
    }
    if ((ui.leaveAlerts || ui.liveUpdates || nearbyWidget) && !exact) {
        Column {
            Hint(stringResource(R.string.exact_off), Modifier.padding(horizontal = 4.dp))
            TextButton(onClick = { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } }) {
                Text(stringResource(R.string.allow_exact))
            }
        }
    }
}

@Composable
internal fun TripChoices(state: AccountState, account: AccountViewModel) {
    if (state.choices.isEmpty()) return
    Group(stringResource(R.string.your_classes)) {
        state.choices.forEachIndexed { i, c ->
            if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(c.label ?: stringResource(R.string.class_gone))
                    Hint(if (c.pref == "earlier") stringResource(R.string.one_bus_earlier) else stringResource(R.string.no_reminders))
                }
                RemoveButton({ account.undoChoice(c) }, stringResource(R.string.undo))
            }
        }
    }
}

@Composable
internal fun TripHistory(state: AccountState, account: AccountViewModel) {
    if (state.history == 0) return
    var confirm by remember { mutableStateOf(false) }
    Group(stringResource(R.string.trip_history), stringResource(R.string.history_kept)) {
        Row(
            Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                if (state.history == 1) stringResource(R.string.trips_recorded_one)
                else stringResource(R.string.trips_recorded_n, state.history),
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { confirm = true }) { Text(stringResource(R.string.clear_history)) }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.clear_history_title)) },
            text = { Text(stringResource(R.string.clear_history_text)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirm = false
                        account.clearHistory()
                    }
                ) {
                    Text(stringResource(R.string.clear))
                }
            },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun AccountSection(
    state: AccountState,
    account: AccountViewModel,
    main: MainViewModel,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val ctx = LocalContext.current
    val c = MaterialTheme.colorScheme
    var confirm by remember { mutableStateOf<String?>(null) }
    val export =
        rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let(account::exportTo) }
    val email = state.email
    if (email == null) {
        Group(stringResource(R.string.not_signed_in), stringResource(DeviceKind.word(R.string.not_signed_in_hint))) {
            InkButton(stringResource(R.string.add_email), onAddEmail, Modifier.fillMaxWidth().padding(16.dp))
        }
    } else {
        Group(stringResource(R.string.heading_signed_in)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Initial(email, 40.dp, 17.sp)
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(
                        email,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    state.devices?.let { Hint(deviceCount(it.size)) }
                }
                OutlinedButton(onClick = { confirm = "signout" }) { Text(stringResource(R.string.sign_out)) }
            }
        }
    }
    Group(stringResource(R.string.heading_your_data)) {
        LinkRow(stringResource(R.string.download_data), { export.launch("terminus-export.json") })
        if (email != null) {
            RowDivider()
            LinkRow(
                stringResource(R.string.account_page),
                { ctx.openWeb("${BuildConfig.LINK_BASE}/account") },
                sub = stringResource(R.string.account_page_sub),
                away = true,
            )
        }
        RowDivider()
        var crashReports by remember { mutableStateOf(CrashReports.enabled(ctx)) }
        FieldRow(
            stringResource(R.string.crash_reports),
            Modifier.toggleable(value = crashReports, role = Role.Switch) { on ->
                CrashReports.setEnabled(ctx, on)
                crashReports = on
            },
            sub = stringResource(R.string.crash_reports_hint),
        ) {
            Switch(checked = crashReports, onCheckedChange = null)
        }
    }
    Group(null) {
        if (email == null) {
            LinkRow(stringResource(R.string.delete_account), { confirm = "delete" }, color = c.error)
        } else {
            LinkRow(
                stringResource(R.string.delete_account),
                { ctx.openWeb("${BuildConfig.LINK_BASE}/account") },
                away = true,
                color = c.error,
            )
        }
    }
    when (confirm) {
        "delete" ->
            AlertDialog(
                onDismissRequest = { confirm = null },
                title = { Text(stringResource(R.string.delete_account_title)) },
                text = { Text(stringResource(R.string.delete_account_text)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirm = null
                            account.deleteAccount {
                                main.signedOut()
                                onSignedOut()
                            }
                        }
                    ) {
                        Text(stringResource(R.string.delete))
                    }
                },
                dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
            )
        "signout" ->
            AlertDialog(
                onDismissRequest = { confirm = null },
                title = { Text(stringResource(DeviceKind.word(R.string.sign_out_title))) },
                text = { Text(stringResource(R.string.sign_out_text, email.orEmpty())) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirm = null
                            main.unpair()
                            account.reset()
                            onSignedOut()
                        }
                    ) {
                        Text(stringResource(R.string.sign_out))
                    }
                },
                dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
            )
    }
}

internal fun deviceIcon(d: Device): Int =
    when {
        d.watch -> R.drawable.ic_device_watch
        d.platform == "mac" -> R.drawable.ic_device_mac
        else -> R.drawable.ic_device_phone
    }

@Composable
private fun Devices(state: AccountState, account: AccountViewModel, main: MainViewModel, onSignedOut: () -> Unit) {
    var removing by remember { mutableStateOf<Device?>(null) }
    val devices = state.devices
    if (devices == null) {
        CircularProgressIndicator(Modifier.size(20.dp))
    } else if (devices.isNotEmpty()) {
        Group(stringResource(R.string.heading_your_devices)) {
            devices.forEachIndexed { i, d ->
                if (i > 0) RowDivider()
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        painterResource(deviceIcon(d)),
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(end = 12.dp).size(24.dp),
                    )
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                d.name,
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.Medium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f, fill = false),
                            )
                            if (d.current) Tag(stringResource(DeviceKind.word(R.string.this_phone_tag)))
                        }
                        val now = System.currentTimeMillis()
                        val used =
                            if (now - d.lastSeenMs < 60_000) stringResource(R.string.just_now)
                            else
                                android.text.format.DateUtils.getRelativeTimeSpanString(
                                    d.lastSeenMs,
                                    now,
                                    android.text.format.DateUtils.MINUTE_IN_MILLIS,
                                )
                        Hint(listOfNotNull(d.platformName, stringResource(R.string.used_when, used)).joinToString(" · "))
                    }
                    RemoveButton({ removing = d })
                }
            }
        }
    }
    Column {
        InkButton(stringResource(R.string.add_device), account::newPairCode, Modifier.fillMaxWidth())
        Hint(stringResource(R.string.add_device_hint), Modifier.padding(start = 4.dp, end = 4.dp, top = 6.dp))
    }

    removing?.let { d ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.remove_device_title, d.name)) },
            text = {
                Text(if (d.current) stringResource(DeviceKind.word(R.string.remove_this_phone)) else stringResource(R.string.remove_other))
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        removing = null
                        account.removeDevice(d) {
                            main.signedOut()
                            onSignedOut()
                        }
                    }
                ) {
                    Text(stringResource(R.string.remove))
                }
            },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    state.pairCode?.let { code -> PairCodeDialog(code, account::closePairCode) }
}

@Composable
private fun Tag(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier =
            Modifier.padding(start = 8.dp)
                .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(6.dp))
                .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun PairCodeDialog(code: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val link = "${BuildConfig.LINK_BASE}/pair?code=$code"
    val qr = remember(link) { qrBitmap(link, 480) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(stringResource(R.string.add_device)) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.on_mac_enter))
                Text(
                    "${code.take(3)} ${code.drop(3)}",
                    style = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = 4.sp),
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                Text(stringResource(R.string.or_scan))
                Image(
                    BitmapPainter(qr.asImageBitmap()),
                    contentDescription = stringResource(R.string.qr_desc, code),
                    modifier = Modifier.size(200.dp).padding(8.dp),
                )
                Hint(stringResource(R.string.works_once))
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.done)) } },
        dismissButton = {
            TextButton(
                onClick = {
                    val send =
                        Intent(Intent.ACTION_SEND)
                            .setType("text/plain")
                            .putExtra(Intent.EXTRA_TEXT, L.s(R.string.pair_share_text, code, link))
                    ctx.startActivity(Intent.createChooser(send, L.s(R.string.send_pair_code)))
                }
            ) {
                Text(stringResource(R.string.send))
            }
        },
    )
}

private fun qrBitmap(text: String, size: Int): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2))
    val bmp = createBitmap(m.width, m.height)
    for (x in 0 until m.width) for (y in 0 until m.height) bmp[x, y] =
        if (m[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    return bmp
}

@Composable
private fun Classes(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    val time = { m: Int -> minuteClock(m, h12) }
    val destinations = campus?.destinations.orEmpty()
    val order = WEEKDAYS.map { it.first }
    var changing by rememberSaveable { mutableStateOf<String?>(null) }
    var open by rememberSaveable { mutableStateOf(false) }
    val all =
        (profile.trips.mapIndexed { i, t -> Triple(true, i, t) } + profile.manual.mapIndexed { i, t -> Triple(false, i, t) }).sortedWith(
            compareBy({ order.indexOf(it.third.day) }, { it.third.arriveByMin })
        )
    Group(classCount(all.size)) {
        for ((imported, i, t) in all) {
            val key = "${if (imported) "t" else "m"}$i"
            val seen = profile.classAt(imported, i)
            val expanded = changing == key
            val state = stringResource(if (expanded) R.string.a11y_expanded else R.string.a11y_collapsed)
            Row(
                Modifier.fillMaxWidth()
                    .clickable(role = Role.Button, onClickLabel = stringResource(R.string.a11y_change_stop, t.label)) {
                        changing = if (expanded) null else key
                    }
                    .semantics { stateDescription = state }
                    .padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("${dayShort(t.day)} ${time(t.arriveByMin)} · ${t.label}", style = MaterialTheme.typography.bodyLarge)
                    val about =
                        listOfNotNull(
                            campus?.let { L.s(R.string.stop_suffix, it.stopName(t.to)) },
                            if (imported) null else stringResource(R.string.added_by_hand),
                        )
                    if (about.isNotEmpty()) Hint(about.joinToString(" · "))
                }
                RemoveButton({ if (seen != null) account.edit { it.removeClass(imported, i, seen) } })
            }
            if (changing == key) {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    WherePicker(stringResource(R.string.change_stop, t.label), destinations, null) { d ->
                        if (d != null && seen != null) {
                            account.edit { it.setClassStop(imported, i, seen, if (d.kind == "landmark") d.code else d.stopCode) }
                            changing = null
                        }
                    }
                }
            }
            RowDivider()
        }
        AddRow(stringResource(R.string.add_by_hand)) {
            open = !open
            if (open) account.loadCampus()
        }
        if (open) {
            RowDivider()
            AddClass(destinations, account, profile.limits.label) { open = false }
        }
    }
    val usual =
        profile.usual
            .mapNotNull { u -> profile.places.firstOrNull { it.key == u.place }?.let { u to it } }
            .sortedWith(compareBy({ order.indexOf(it.first.day) }, { it.first.atMin }))
    if (usual.isNotEmpty()) {
        Group(stringResource(R.string.every_week)) {
            usual.forEachIndexed { n, (u, place) ->
                if (n > 0) RowDivider()
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("${dayShort(u.day)} ${time(u.atMin)} · ${place.label}", style = MaterialTheme.typography.bodyLarge)
                        if (campus != null) Hint(stringResource(R.string.stop_suffix, campus.stopName(place.to)))
                    }
                    RemoveButton({ account.edit { it.removeUsual(u) } })
                }
            }
        }
    }
}

@Composable
private fun AddClass(destinations: List<Destination>, account: AccountViewModel, maxLabel: Int, onDone: () -> Unit) {
    var day by rememberSaveable { mutableIntStateOf(1) }
    var start by rememberSaveable { mutableStateOf<Int?>(null) }
    var end by rememberSaveable { mutableStateOf<Int?>(null) }
    var label by rememberSaveable { mutableStateOf("") }
    var where by remember { mutableStateOf<Destination?>(null) }
    val reveal = remember { BringIntoViewRequester() }
    LaunchedEffect(Unit) {
        withFrameNanos {}
        reveal.bringIntoView()
    }
    Column(Modifier.bringIntoViewRequester(reveal).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Choice(stringResource(R.string.day), WEEKDAYS, day, { day = it ?: 1 })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TimeButton(stringResource(R.string.starts), start, { start = it }, Modifier.weight(1f))
            TimeButton(stringResource(R.string.ends), end, { end = it }, Modifier.weight(1f))
        }
        OutlinedTextField(
            label,
            { if (it.length <= maxLabel) label = it },
            label = { Text(stringResource(R.string.name_eg_gym)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        WherePicker(stringResource(R.string.where), destinations, where) { where = it }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onDone) { Text(stringResource(R.string.cancel)) }
            Spacer(Modifier.weight(1f))
            InkButton(
                stringResource(R.string.add),
                {
                    val s = start
                    val w = where
                    if (s != null && w != null) {
                        account.edit {
                            it.addManual(
                                TimetableClass(
                                    day,
                                    s,
                                    end?.takeIf { e -> e > s },
                                    if (w.kind == "landmark") w.code else w.stopCode,
                                    label.trim(),
                                    "",
                                )
                            )
                        }
                        onDone()
                    }
                },
                enabled = start != null && where != null && label.isNotBlank(),
            )
        }
    }
}

@Composable
private fun Favourites(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    val stopName = { code: String ->
        campus?.stops?.firstOrNull { it.code == code }?.name
            ?: campus?.destinations?.firstOrNull { it.code == code && it.kind == "landmark" }?.label
            ?: code
    }
    var note by remember { mutableStateOf<String?>(null) }
    val drawn = rememberDrawn()
    var leaving by remember { mutableStateOf(setOf<String>()) }
    var picked by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val notices = LocalNotices.current
    Group(stringResource(R.string.heading_your_favourites), note ?: stringResource(R.string.favourites_hint)) {
        for (p in profile.places) {
            key(p.key) {
                FoldRow(shown = p.key !in leaving, arriving = drawn) {
                    Column {
                        Row(
                            Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(p.label, style = MaterialTheme.typography.bodyLarge)
                                if (campus != null && p.label != stopName(p.to)) Hint(stringResource(R.string.stop_suffix, stopName(p.to)))
                            }
                            RemoveButton({
                                if (p.key in leaving) return@RemoveButton
                                leaving = leaving + p.key
                                scope.afterFold {
                                    var removed: RemovedPlace? = null
                                    account.edit { removed = it.removePlaceAt(p.to) }
                                    leaving = leaving - p.key
                                    val r = removed ?: return@afterFold
                                    scope.launch {
                                        val undo =
                                            notices?.showSnackbar(
                                                Notice(L.s(R.string.favourite_removed, r.label), actionLabel = L.s(R.string.undo))
                                            )
                                        if (undo == SnackbarResult.ActionPerformed) account.edit { it.restorePlace(r) }
                                    }
                                }
                            })
                        }
                        RowDivider()
                    }
                }
            }
        }
        if (profile.places.size < profile.limits.places) {
            val favourite = profile.places.map { it.to }.toSet()
            val timetable =
                (profile.trips + profile.manual)
                    .groupBy { it.to }
                    .filterKeys { it !in favourite }
                    .map { (to, classes) ->
                        Destination(
                            to,
                            stopName(to),
                            to,
                            "timetable",
                            detail = classes.map { it.label.substringBefore(" @ ") }.distinct().joinToString(L.s(R.string.list_sep)),
                        )
                    }
                    .sortedBy { it.label }
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                WherePicker(stringResource(R.string.add_favourite), campus?.destinations.orEmpty(), null, timetable, leaving = picked) { d
                    ->
                    if (d == null || picked != null) return@WherePicker
                    val to = if (d.kind == "landmark") d.code else d.stopCode
                    val same = profile.places.firstOrNull { it.to == to }
                    if (same != null) {
                        note = L.s(R.string.already_favourite, same.label)
                        return@WherePicker
                    }
                    note = null
                    val add = { account.edit { it.addPlace(if (d.kind == "building" || d.kind == "room") d.code else d.label, to) } }
                    if (timetable.none { it.id == d.id }) return@WherePicker add()
                    picked = d.id
                    scope.afterFold {
                        add()
                        picked = null
                    }
                }
            }
        }
    }
    LaunchedEffect(Unit) { account.loadCampus() }
}

@Composable
private fun NearbyWidgetSettings() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val on = NewToNus.on(ctx)
    var exact by remember { mutableStateOf(LeaveAlerts.canBeExact(ctx)) }
    LifecycleResumeEffect(Unit) {
        exact = LeaveAlerts.canBeExact(ctx)
        onPauseOrDispose {}
    }
    Group(stringResource(R.string.nearby_widget), stringResource(DeviceKind.word(R.string.new_to_nus_hint))) {
        FieldRow(
            stringResource(R.string.widget_minutes),
            Modifier.clickable { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } },
            sub = stringResource(if (exact) R.string.widget_minutes_on else R.string.widget_minutes_off),
        ) {
            if (!exact)
                OutlinedButton(onClick = { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } }) {
                    Text(stringResource(R.string.allow))
                }
        }
        RowDivider()
        FieldRow(
            stringResource(R.string.new_to_nus),
            Modifier.toggleable(value = on, role = Role.Switch) {
                NewToNus.set(ctx, it)
                scope.launch { redrawWidgets(ctx) }
            },
            sub = stringResource(R.string.new_to_nus_sub),
        ) {
            Switch(checked = on, onCheckedChange = null)
        }
    }
}

@Composable
private fun ThemePicker() {
    val ctx = LocalContext.current
    var pref by remember { mutableStateOf(Theme.pref(ctx)) }
    Group(stringResource(R.string.theme), stringResource(DeviceKind.word(R.string.theme_hint))) {
        Pills(
            listOf(
                Theme.AUTO to stringResource(R.string.auto),
                Theme.LIGHT to stringResource(R.string.theme_light),
                Theme.DARK to stringResource(R.string.theme_dark),
            ),
            pref,
            {
                Theme.set(ctx, it)
                pref = it
            },
            Modifier.padding(16.dp),
        )
    }
}

@Composable
private fun ClockPills(profile: ProfileDoc?, account: AccountViewModel) {
    Pills(
        listOf(
            Clock.AUTO to stringResource(R.string.auto),
            Clock.H12 to stringResource(R.string.clock_12),
            Clock.H24 to stringResource(R.string.clock_24),
        ),
        profile?.clock ?: Clock.AUTO,
        account::setClock,
        Modifier.padding(16.dp),
    )
}

@Composable
private fun LanguagePicker(account: AccountViewModel) {
    val ctx = LocalContext.current
    Group(stringResource(R.string.language), stringResource(R.string.language_hint)) {
        Pills(
            listOf(Lang.AUTO to stringResource(R.string.auto), Lang.EN to "English", Lang.ZH to "中文"),
            Lang.pref(ctx),
            account::setLang,
            Modifier.padding(16.dp),
        )
    }
}
