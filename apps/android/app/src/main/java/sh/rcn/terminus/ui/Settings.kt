package sh.rcn.terminus.ui

import android.content.Intent
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.layout.PaddingValues
import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Campus
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Destination
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Device
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.SavedPlace
import sh.rcn.terminus.Theme
import sh.rcn.terminus.Trip
import sh.rcn.terminus.WEEKDAYS
import sh.rcn.terminus.dayShort
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.Lang
import sh.rcn.terminus.Clock
import sh.rcn.terminus.L
import kotlin.coroutines.cancellation.CancellationException
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.Role

/** Settings' pages, in the order the list shows them. */
internal enum class SettingsPage(val title: Int) {
    Trips(R.string.heading_your_trips),
    Timetable(R.string.heading_timetable),
    Favourites(R.string.heading_favourites),
    Notifications(R.string.notifications),
    Devices(R.string.heading_devices),
    Language(R.string.heading_language),
    Appearance(R.string.heading_appearance),
    Account(R.string.heading_account),
    // Under the list, as links, rather than in a group.
    About(R.string.about),
    Feedback(R.string.send_feedback),
}

/**
 * Everything the account page has, so the website is optional for daily
 * use: a list of groups, each with a line saying what's set, opening a page
 * that slides in. Back (and the back gesture, which the page follows) returns
 * to the list.
 */
@Composable
internal fun SettingsScreen(
    state: AccountState,
    account: AccountViewModel,
    main: MainViewModel,
    insets: PaddingValues,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
    onClose: () -> Unit,
) {
    LaunchedEffect(Unit) { account.refresh() }
    LaunchedEffect(state.email) { if (state.email != null) account.loadDevices() }
    LaunchedEffect(Unit) { account.loadChoices() }
    LaunchedEffect(Unit) { account.loadCampus() }

    var open by rememberSaveable { mutableStateOf<SettingsPage?>(null) }
    // A NUSMods link shared into the app: straight to Timetable, to import it.
    LaunchedEffect(state.sharedLink) { if (state.sharedLink != null) open = SettingsPage.Timetable }
    // How far a back gesture has gone, for the page to follow it. Kept after
    // the gesture completes, so the page slides away from where it was let go.
    var backProgress by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(open) { if (open != null) backProgress = 0f }
    BackHandler(enabled = open == null, onBack = onClose)
    PredictiveBackHandler(enabled = open != null) { events ->
        try {
            events.collect { backProgress = it.progress }
            open = null
        } catch (e: CancellationException) {
            backProgress = 0f
            throw e
        }
    }

    // Edge to edge, the insets inside, so the list's sky can reach the top.
    val top = insets.calculateTopPadding()
    val bottom = insets.calculateBottomPadding()
    Column(Modifier.fillMaxSize()) {
        state.message?.let {
            Card(Modifier.fillMaxWidth().padding(top = top).padding(horizontal = 16.dp).padding(top = 8.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, modifier = Modifier.weight(1f))
                    TextButton(onClick = account::clearMessage) { Text(stringResource(R.string.ok)) }
                }
            }
        }
        AnimatedContent(
            targetState = open,
            transitionSpec = {
                if (targetState != null) {
                    (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { it } + fadeIn(tween(300)))
                        .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeOut(tween(200)))
                } else {
                    (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeIn(tween(300)))
                        .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { it } + fadeOut(tween(200)))
                }
            },
            modifier = Modifier.weight(1f),
            label = "settings page",
        ) { page ->
            if (page == null) {
                SettingsList(state, main, if (state.message != null) 0.dp else top, bottom) { open = it }
            } else {
                Column(
                    Modifier.fillMaxSize().graphicsLayer {
                        // Following the back gesture: the page shrinks a little and moves towards the edge.
                        val scale = 1f - backProgress * 0.1f
                        scaleX = scale
                        scaleY = scale
                        translationX = backProgress * size.width * 0.15f
                        alpha = 1f - backProgress * 0.3f
                    }.padding(top = if (state.message != null) 0.dp else top, bottom = bottom).padding(horizontal = 16.dp),
                ) {
                    TabHeader {
                        // The arrow sits in the margin, so the title lines up with the list's.
                        IconButton(onClick = { open = null }, modifier = Modifier.offset(x = (-12).dp)) {
                            Icon(painterResource(R.drawable.ic_back), contentDescription = stringResource(R.string.back))
                        }
                        Text(stringResource(page.title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.offset(x = (-12).dp))
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                        SettingsPageContent(page, state, account, main, onAddEmail, onSignedOut)
                        Spacer(Modifier.height(32.dp))
                    }
                }
            }
        }
    }
}

/**
 * Settings at a glance, in three levels: who you are; your day, drawn as a
 * short route (home, classes, pace), each stop opening its page; then the
 * rest as tiles, each saying what's set. Notifications all off shows in
 * amber: it's the setting that changes the most. About is under them.
 * The title and who you are are up in Now's sky (the same hour), which ends
 * on a horizon with a shuttle going by; the rest is on the ground. [top] and
 * [bottom]: the status bar's and the tab bar's room, inside the scrolling.
 */
@Composable
private fun SettingsList(state: AccountState, main: MainViewModel, top: Dp, bottom: Dp, onOpen: (SettingsPage) -> Unit) {
    val ctx = LocalContext.current
    val ui by main.state.collectAsStateWithLifecycle()
    val profile = state.profile
    val scroll = rememberScrollState()
    val sky = rememberSky(scroll, skyPhase(ui))
    val shown = sky.end != null
    val light = sky.palette.lightInk
    NightStatusBar(shown && light)
    val page = MaterialTheme.colorScheme.background
    val measurer = rememberTextMeasurer()
    CompositionLocalProvider(LocalSky provides sky) { Box(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(scroll)
                .onGloballyPositioned { sky.contentTop = it.positionInRoot().y }
                .skyBehind(sky, page, measurer)
                .padding(top = top, bottom = bottom)
                .padding(horizontal = 16.dp),
        ) {
            SkyInk(shown, light) { TabHeader { Text(stringResource(R.string.settings), style = MaterialTheme.typography.titleLarge) } }
            // Who you are, up in the sky.
            SkyHead(56.dp) { AccountTile(state, ui, onOpen) }
            SkyGround()
            SettingsGround(state, ui, profile, onOpen)
        }
        StatusStrip(sky, top, scroll)
    } }
}

/** Who you are: your email (or that you're not signed in) and your devices, opening Account. */
@Composable
private fun AccountTile(state: AccountState, ui: UiState, onOpen: (SettingsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    LinkTile({ onOpen(SettingsPage.Account) }, Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            val email = state.email
            if (email != null) {
                Box(Modifier.size(44.dp).background(c.primary, CircleShape), contentAlignment = Alignment.Center) {
                    Text(email.take(1).uppercase(), color = c.onPrimary, fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                }
            } else {
                BrandMark(Modifier.size(44.dp))
            }
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(email ?: stringResource(R.string.not_signed_in), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                summary(SettingsPage.Devices, state, ui.leaveAlerts, ui.liveUpdates, ui.detectTrips)?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = muted)
        }
    }
}

/** Under the horizon: your day as a route, the tiles, and About. */
@Composable
private fun SettingsGround(state: AccountState, ui: UiState, profile: ProfileDoc?, onOpen: (SettingsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    val muted = c.onSurfaceVariant
    // Your day, as a route.
    Column(
        Modifier.padding(top = 12.dp).fillMaxWidth().background(c.surface, RoundedCornerShape(18.dp))
            .border(1.dp, c.outlineVariant, RoundedCornerShape(18.dp)).padding(top = 14.dp, bottom = 8.dp),
    ) {
        Label(stringResource(R.string.heading_your_day), Modifier.padding(horizontal = 14.dp).semantics { heading() })
        val home = profile?.homeStops?.firstOrNull()?.let { code -> state.campus?.stopName(code) ?: code } ?: stringResource(R.string.no_home_stop)
        val classes = summary(SettingsPage.Timetable, state, ui.leaveAlerts, ui.liveUpdates, ui.detectTrips).orEmpty()
        val pace = profile?.let { stringResource(paceName(it.walkPace)) }.orEmpty()
        DayRoute(
            listOf(
                Triple(home, stringResource(R.string.step_home), SettingsPage.Trips),
                Triple(classes, stringResource(R.string.timetable), SettingsPage.Timetable),
                Triple(pace, stringResource(R.string.walking_pace), SettingsPage.Trips),
            ),
            onOpen,
        )
    }
    // The rest, as tiles.
    TwoColumns(
        listOf(
            SettingsPage.Favourites to R.drawable.ic_heart,
            SettingsPage.Notifications to R.drawable.ic_bell,
            SettingsPage.Language to R.drawable.ic_globe,
            SettingsPage.Appearance to R.drawable.ic_contrast,
            SettingsPage.Devices to R.drawable.ic_devices,
            SettingsPage.Feedback to R.drawable.ic_chat,
        ),
        Modifier.padding(top = 12.dp),
        gap = 10.dp,
    ) { (page, icon), mod ->
        LinkTile({ onOpen(page) }, mod.heightIn(min = 112.dp)) {
            Icon(painterResource(icon), contentDescription = null, tint = c.primary, modifier = Modifier.size(22.dp))
            Spacer(Modifier.weight(1f).heightIn(min = 14.dp))
            Text(stringResource(page.title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            val said = when (page) {
                SettingsPage.Feedback -> stringResource(R.string.feedback_short)
                SettingsPage.Language, SettingsPage.Appearance -> displaySummary(page, state)
                else -> summary(page, state, ui.leaveAlerts, ui.liveUpdates, ui.detectTrips)
            }
            val off = page == SettingsPage.Notifications && !ui.leaveAlerts && !ui.liveUpdates && !ui.detectTrips
            said?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = if (off) c.tertiary else muted, fontWeight = if (off) FontWeight.SemiBold else null, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    // About, as a link under the tiles.
    Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.Center) {
        TextButton(onClick = { onOpen(SettingsPage.About) }) { Text(stringResource(R.string.about)) }
    }
    Spacer(Modifier.height(16.dp))
}

/** Home, classes, pace: three stops on a line, each opening its page. */
@Composable
private fun DayRoute(stops: List<Triple<String, String, SettingsPage>>, onOpen: (SettingsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    Box(Modifier.fillMaxWidth().padding(top = 12.dp)) {
        Canvas(Modifier.matchParentSize()) {
            val cell = size.width / stops.size
            val y = 15.dp.toPx()
            drawLine(c.primary, androidx.compose.ui.geometry.Offset(cell / 2, y), androidx.compose.ui.geometry.Offset(size.width - cell / 2, y), 4.dp.toPx())
        }
        Row(Modifier.fillMaxWidth()) {
            for ((value, label, page) in stops) {
                Column(
                    Modifier.weight(1f).clickable(role = Role.Button) { onOpen(page) }.padding(top = 6.dp, bottom = 8.dp, start = 4.dp, end = 4.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(Modifier.size(18.dp).background(c.surface, CircleShape).border(4.dp, c.primary, CircleShape))
                    Text(value, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp))
                    Text(label, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, maxLines = 1)
                }
            }
        }
    }
}

/** What's set on a page, in a line: the same words the list had. */
@Composable
private fun summary(page: SettingsPage, state: AccountState, leaveAlerts: Boolean, liveUpdates: Boolean, detectTrips: Boolean): String? {
    val profile = state.profile
    return when (page) {
        SettingsPage.Trips -> profile?.let {
            val home = it.homeStops.firstOrNull()?.let { code -> state.campus?.stopName(code) ?: code }
            listOf(home ?: stringResource(R.string.no_home_stop), stringResource(R.string.pace_summary, stringResource(paceName(it.walkPace)))).joinToString(" · ")
        }
        SettingsPage.Timetable -> if (state.needsReimport) stringResource(R.string.reimport_needed) else profile?.let {
            when (val n = it.trips.size + it.manual.size) {
                0 -> stringResource(R.string.no_classes_yet)
                1 -> stringResource(R.string.one_class)
                else -> stringResource(R.string.n_classes, n)
            }
        }
        SettingsPage.Favourites -> profile?.let { p -> p.places.joinToString(", ") { it.label }.ifEmpty { stringResource(R.string.none_yet) } }
        SettingsPage.Notifications -> listOfNotNull(
            if (leaveAlerts) stringResource(R.string.short_leave_alerts) else null,
            if (liveUpdates) stringResource(R.string.short_live) else null,
            if (detectTrips) stringResource(R.string.short_detect) else null,
        ).joinToString(", ").ifEmpty { stringResource(R.string.all_off) }
        SettingsPage.Devices -> when {
            state.email == null -> stringResource(R.string.devices_need_email)
            else -> state.devices?.let { if (it.size == 1) stringResource(R.string.one_device) else stringResource(R.string.n_devices, it.size) }
        }
        SettingsPage.Account -> state.email ?: stringResource(R.string.not_signed_in)
        else -> null
    }
}

/** Language and time, and Appearance: what each is set to. */
@Composable
private fun displaySummary(page: SettingsPage, state: AccountState): String {
    val ctx = LocalContext.current
    return if (page == SettingsPage.Language) {
        listOfNotNull(
            when (Lang.pref(ctx)) {
                Lang.EN -> "English"
                Lang.ZH -> "中文"
                else -> stringResource(R.string.follow_device)
            },
            when (state.profile?.clock) {
                Clock.H12 -> stringResource(R.string.clock_12)
                Clock.H24 -> stringResource(R.string.clock_24)
                else -> null
            },
        ).joinToString(" · ")
    } else {
        "${stringResource(themeName(Theme.pref(ctx)))} · ${stringResource(CardStyle.name(CardStyle.pref(ctx)))}"
    }
}

private fun themeName(theme: String) = when (theme) {
    Theme.LIGHT -> R.string.theme_light
    Theme.DARK -> R.string.theme_dark
    else -> R.string.follow_device
}

private fun paceName(pace: String) = when (pace) {
    "slow" -> R.string.pace_slow
    "fast" -> R.string.pace_fast
    else -> R.string.pace_normal
}

/** One group's settings: the same controls as the single page had, in the same order. */
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
        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
        return
    }
    when (page) {
        SettingsPage.Trips -> {
            if (profile == null) return
            TripsSettings(profile, state, account)
        }
        SettingsPage.Timetable -> {
            if (profile == null) return
            var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: profile.share.orEmpty()) }
            // The semester the link is for has ended: say so above everything else.
            if (state.needsReimport) {
                Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(stringResource(R.string.reimport_title), style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.reimport_text, state.term.orEmpty()), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            TimetableImport(state, account, link) { link = it }
            Classes(profile, state.campus, account)
        }
        SettingsPage.Favourites -> if (profile != null) Favourites(profile, state.campus, account)
        SettingsPage.Notifications -> NotificationSettings(main)
        SettingsPage.Devices -> {
            if (state.email == null) {
                Hint(stringResource(R.string.not_signed_in_hint))
                Button(onClick = onAddEmail, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.add_email)) }
            } else {
                Devices(state, account, onSignedOut)
            }
        }
        SettingsPage.Language -> {
            LanguagePicker(account)
            Spacer(Modifier.height(20.dp))
            ClockPicker(state.profile, account, stringResource(R.string.time_format), auto = true)
            Hint(stringResource(R.string.time_format_hint), Modifier.padding(top = 4.dp))
        }
        SettingsPage.Appearance -> {
            ThemePicker()
            Spacer(Modifier.height(24.dp))
            CardStylePicker()
        }
        SettingsPage.Account -> AccountSection(state, account, main, onAddEmail, onSignedOut)
        SettingsPage.About -> AboutPage()
        SettingsPage.Feedback -> FeedbackPage(state, account)
    }
}

/** What terminus is, that it isn't NUS's, where its data comes from, and links, as rows like the Settings list. */
@Composable
private fun AboutPage() {
    val ctx = LocalContext.current
    val open = { url: String -> ctx.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
    val host = BuildConfig.SITE.removePrefix("https://").removePrefix("http://")
    // Each link's name, where it goes, and that place as shown under the name.
    val links = listOf(
        Triple(R.string.status, "${BuildConfig.SITE}/status", "$host/status"),
        Triple(R.string.privacy, "${BuildConfig.SITE}/privacy", "$host/privacy"),
        Triple(R.string.api_docs, "${BuildConfig.SITE}/docs", "$host/docs"),
        Triple(R.string.source_code, "https://github.com/rcnsh/terminus", "github.com/rcnsh/terminus"),
        Triple(R.string.map_data, "https://www.openstreetmap.org/copyright", "openstreetmap.org"),
        Triple(R.string.aup, "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf", "nus.edu.sg"),
    )
    Text(stringResource(R.string.about_what))
    Hint(stringResource(R.string.about_independent), Modifier.padding(top = 12.dp))
    Hint(stringResource(R.string.about_aup), Modifier.padding(top = 12.dp))
    Hint(stringResource(R.string.about_version, BuildConfig.VERSION_NAME), Modifier.padding(top = 12.dp))
    androidx.compose.material3.OutlinedCard(Modifier.fillMaxWidth().padding(top = 20.dp)) {
        links.forEachIndexed { i, (title, url, where) ->
            if (i > 0) androidx.compose.material3.HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { open(url) }.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(title), style = MaterialTheme.typography.bodyLarge)
                    Text(
                        where,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                // Every one opens in the browser, out of the app.
                Icon(painterResource(R.drawable.ic_open), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
        }
    }
}

/** A note to the operator about anything; a wrong answer is better sent from under the card. */
@Composable
private fun FeedbackPage(state: AccountState, account: AccountViewModel) {
    var note by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = note,
        onValueChange = { note = it.take(1000) },
        label = { Text(stringResource(R.string.feedback_label)) },
        placeholder = { Text(stringResource(R.string.feedback_placeholder)) },
        minLines = 5,
        modifier = Modifier.fillMaxWidth(),
    )
    Hint(stringResource(if (state.email == null) R.string.feedback_no_email else R.string.feedback_with_email), Modifier.padding(top = 8.dp))
    Hint(stringResource(R.string.feedback_wrong_answer), Modifier.padding(top = 4.dp))
    Button(
        onClick = { account.sendFeedback(note) { note = "" } },
        enabled = note.isNotBlank() && !state.busy,
        modifier = Modifier.padding(top = 12.dp),
    ) { Text(stringResource(R.string.send)) }
}

/**
 * Leave alerts, the live notification and noticing when you board: on this
 * phone only. Exact alarms are asked for when either notification is on.
 */
@Composable
private fun NotificationSettings(main: MainViewModel) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val ui by main.state.collectAsStateWithLifecycle()
    // "Alarms & reminders" is allowed in system settings; check again on return.
    var exact by remember { mutableStateOf(LeaveAlerts.canBeExact(ctx)) }
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { exact = LeaveAlerts.canBeExact(ctx) }
    }
    val openSettings = { ctx.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))) }
    NotifyToggle(
        stringResource(R.string.notify_leave),
        stringResource(R.string.notify_leave_hint),
        ui.leaveAlerts, main::setLeaveAlerts, openSettings,
    )
    NotifyToggle(
        stringResource(R.string.live_notification),
        stringResource(R.string.live_notification_hint),
        ui.liveUpdates, main::setLiveUpdates, openSettings,
    )
    DetectToggle(ui.detectTrips, main::setDetectTrips, openSettings)
    if ((ui.leaveAlerts || ui.liveUpdates) && !exact) {
        Hint(stringResource(R.string.exact_off))
        TextButton(onClick = { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } }) { Text(stringResource(R.string.allow_exact)) }
    }
}

/** What you chose for particular classes, each undoable. */
@Composable
internal fun TripChoices(state: AccountState, account: AccountViewModel) {
    if (state.choices.isEmpty()) return
    TripsGroup(stringResource(R.string.your_classes)) {
        state.choices.forEachIndexed { i, c ->
            if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.label ?: stringResource(R.string.class_gone))
                    Hint(if (c.pref == "earlier") stringResource(R.string.one_bus_earlier) else stringResource(R.string.no_reminders))
                }
                TextButton(onClick = { account.undoChoice(c) }) { Text(stringResource(R.string.undo)) }
            }
        }
    }
}

/** How each trip went, kept 35 days for the suggestions; cleared here without touching the rest. */
@Composable
internal fun TripHistory(state: AccountState, account: AccountViewModel) {
    if (state.history == 0) return
    var confirm by remember { mutableStateOf(false) }
    TripsGroup(stringResource(R.string.trip_history), stringResource(R.string.history_kept)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (state.history == 1) stringResource(R.string.trips_recorded_one) else stringResource(R.string.trips_recorded_n, state.history), modifier = Modifier.weight(1f))
            TextButton(onClick = { confirm = true }) { Text(stringResource(R.string.clear_history)) }
        }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.clear_history_title)) },
            text = { Text(stringResource(R.string.clear_history_text)) },
            confirmButton = { TextButton(onClick = { confirm = false; account.clearHistory() }) { Text(stringResource(R.string.clear)) } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun AccountSection(state: AccountState, account: AccountViewModel, main: MainViewModel, onAddEmail: () -> Unit, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var confirm by remember { mutableStateOf<String?>(null) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let(account::exportTo) }
    if (state.email == null) {
        Text(stringResource(R.string.not_signed_in))
        Hint(stringResource(R.string.not_signed_in_hint))
        Button(onClick = onAddEmail, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.add_email)) }
        TextButton(onClick = { export.launch("terminus-export.json") }) { Text(stringResource(R.string.download_data)) }
        TextButton(onClick = { confirm = "delete" }) { Text(stringResource(R.string.delete_account)) }
    } else {
        Text(stringResource(R.string.signed_in_as, state.email))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            TextButton(onClick = { confirm = "signout" }) { Text(stringResource(R.string.sign_out_phone)) }
            TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }) { Text(stringResource(R.string.account_page)) }
        }
        TextButton(onClick = { export.launch("terminus-export.json") }) { Text(stringResource(R.string.download_data)) }
        Hint(stringResource(R.string.account_page_hint))
    }
    when (confirm) {
        "delete" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.delete_account_title)) },
            text = { Text(stringResource(R.string.delete_account_text)) },
            confirmButton = { TextButton(onClick = { confirm = null; account.deleteAccount { main.signedOut(); onSignedOut() } }) { Text(stringResource(R.string.delete)) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
        "signout" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.sign_out_title)) },
            text = { Text(stringResource(R.string.sign_out_text, state.email.orEmpty())) },
            confirmButton = { TextButton(onClick = { confirm = null; main.unpair(); account.reset(); onSignedOut() }) { Text(stringResource(R.string.sign_out)) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun Devices(state: AccountState, account: AccountViewModel, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var removing by remember { mutableStateOf<Device?>(null) }
    val devices = state.devices
    if (devices == null) {
        CircularProgressIndicator(Modifier.size(20.dp))
    } else {
        for (d in devices) {
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name + if (d.current) stringResource(R.string.this_phone) else "")
                    val now = System.currentTimeMillis()
                    val used = if (now - d.lastSeenMs < 60_000) stringResource(R.string.just_now) else android.text.format.DateUtils.getRelativeTimeSpanString(d.lastSeenMs, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Hint(listOfNotNull(platformName(d.platform), stringResource(R.string.used_when, used)).joinToString(" · "))
                }
                TextButton(onClick = { removing = d }) { Text(stringResource(R.string.remove)) }
            }
            HorizontalDivider()
        }
    }
    OutlinedButton(onClick = account::newPairCode, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.add_device)) }
    Hint(stringResource(R.string.add_device_hint))

    removing?.let { d ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.remove_device_title, d.name)) },
            text = { Text(if (d.current) stringResource(R.string.remove_this_phone) else stringResource(R.string.remove_other)) },
            confirmButton = { TextButton(onClick = { removing = null; account.removeDevice(d) { onSignedOut() } }) { Text(stringResource(R.string.remove)) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    state.pairCode?.let { code -> PairCodeDialog(code, account::closePairCode) }
}

private fun platformName(p: String?) = when (p) {
    "android" -> "Android"
    "mac" -> "Mac"
    "ios" -> "iPhone"
    else -> null
}

/** The code to type on a Mac, and a QR code another phone's camera opens. */
@Composable
private fun PairCodeDialog(code: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val link = "${BuildConfig.SITE}/pair?code=$code"
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
                Image(BitmapPainter(qr.asImageBitmap()), contentDescription = stringResource(R.string.qr_desc, code), modifier = Modifier.size(200.dp).padding(8.dp))
                Hint(stringResource(R.string.works_once))
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.done)) } },
        dismissButton = {
            TextButton(onClick = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, L.s(R.string.pair_share_text, code, link))
                ctx.startActivity(Intent.createChooser(send, L.s(R.string.send_pair_code)))
            }) { Text(stringResource(R.string.send)) }
        },
    )
}

/** Black on white with a quiet zone, whatever the theme: cameras read it best. */
private fun qrBitmap(text: String, size: Int): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2))
    val bmp = createBitmap(m.width, m.height)
    for (x in 0 until m.width) for (y in 0 until m.height) bmp[x, y] = if (m[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    return bmp
}

/** Every class, imported or added by hand, by day and time, each with Remove; then adding one by hand. */
@Composable
private fun Classes(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    val time = { m: Int -> if (h12) hhmm12(m) else hhmm(m) }
    val destinations = campus?.destinations.orEmpty()
    // Monday first, as the week reads; the index is the class's place in its own list.
    val order = WEEKDAYS.map { it.first }
    var changing by rememberSaveable { mutableStateOf<String?>(null) }
    val all = (profile.trips.mapIndexed { i, t -> Triple(true, i, t) } + profile.manual.mapIndexed { i, t -> Triple(false, i, t) })
        .sortedWith(compareBy({ order.indexOf(it.third.day) }, { it.third.arriveByMin }))
    if (all.isNotEmpty()) {
        Text(if (all.size == 1) stringResource(R.string.one_class) else stringResource(R.string.n_classes, all.size), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
        for ((imported, i, t) in all) {
            // Tapped, a class opens to change its stop, as on the account page.
            val key = "${if (imported) "t" else "m"}$i"
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { changing = if (changing == key) null else key }, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${dayShort(t.day)} ${time(t.arriveByMin)} · ${t.label}")
                    val about = listOfNotNull(campus?.let { L.s(R.string.stop_suffix, it.stopName(t.to)) }, if (imported) null else stringResource(R.string.added_by_hand))
                    if (about.isNotEmpty()) Hint(about.joinToString(" · "))
                }
                TextButton(onClick = { account.edit { it.removeClass(imported, i) } }) { Text(stringResource(R.string.remove)) }
            }
            if (changing == key) {
                WherePicker(stringResource(R.string.change_stop, t.label), destinations, null) { d ->
                    if (d != null) {
                        account.edit { it.setClassStop(imported, i, if (d.kind == "landmark") d.code else d.stopCode) }
                        changing = null
                    }
                }
            }
        }
    }
    // A favourite at its usual time each week: removable here with the classes.
    val usual = profile.usual.mapNotNull { u -> profile.places.firstOrNull { it.key == u.place }?.let { u to it } }
        .sortedWith(compareBy({ order.indexOf(it.first.day) }, { it.first.atMin }))
    if (usual.isNotEmpty()) {
        Text(stringResource(R.string.every_week), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
        for ((u, place) in usual) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${dayShort(u.day)} ${time(u.atMin)} · ${place.label}")
                    if (campus != null) Hint(stringResource(R.string.stop_suffix, campus.stopName(place.to)))
                }
                TextButton(onClick = { account.edit { it.removeUsual(u) } }) { Text(stringResource(R.string.remove)) }
            }
        }
    }
    var open by rememberSaveable { mutableStateOf(false) }
    if (!open) {
        TextButton(onClick = { open = true; account.loadCampus() }) { Text(stringResource(R.string.add_by_hand)) }
        return
    }
    var day by rememberSaveable { mutableIntStateOf(1) }
    var start by rememberSaveable { mutableStateOf<Int?>(null) }
    var end by rememberSaveable { mutableStateOf<Int?>(null) }
    var label by rememberSaveable { mutableStateOf("") }
    var where by remember { mutableStateOf<Destination?>(null) }
    Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice(stringResource(R.string.day), WEEKDAYS, day, { day = it ?: 1 })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TimeButton(stringResource(R.string.starts), start, { start = it }, Modifier.weight(1f))
                TimeButton(stringResource(R.string.ends), end, { end = it }, Modifier.weight(1f))
            }
            OutlinedTextField(label, { if (it.length <= 60) label = it }, label = { Text(stringResource(R.string.name_eg_gym)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            WherePicker(stringResource(R.string.where), destinations, where) { where = it }
            Row {
                TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = {
                        val s = start ?: return@Button
                        val w = where ?: return@Button
                        account.edit { it.addManual(Trip(day, s, end?.takeIf { e -> e > s }, w.stopCode, label.trim(), "")) }
                        open = false
                        start = null; end = null; label = ""; where = null
                    },
                    enabled = start != null && where != null && label.isNotBlank(),
                ) { Text(stringResource(R.string.add)) }
            }
        }
    }
}

@Composable
private fun Favourites(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    Hint(stringResource(R.string.favourites_hint))
    // A stop's name, or a food court's (favourites and classes can go to one).
    val stopName = { code: String ->
        campus?.stops?.firstOrNull { it.code == code }?.name ?: campus?.destinations?.firstOrNull { it.code == code && it.kind == "landmark" }?.label ?: code
    }
    var note by remember { mutableStateOf<String?>(null) }
    for (p in profile.places) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(p.label)
                // Where it goes, when the name doesn't already say (a building's stop, or a name from before favourites).
                if (campus != null && p.label != stopName(p.to)) Hint(stringResource(R.string.stop_suffix, stopName(p.to)))
            }
            TextButton(onClick = { account.edit { it.removePlace(p.key) } }) { Text(stringResource(R.string.remove)) }
        }
    }
    if (profile.places.size >= 12) return
    // The stops your classes go to come first, each saying which classes use it.
    val favourite = profile.places.map { it.to }.toSet()
    val timetable = (profile.trips + profile.manual).groupBy { it.to }
        .filterKeys { it !in favourite }
        .map { (to, classes) -> Destination(to, stopName(to), to, "timetable", detail = classes.map { it.label.substringBefore(" @ ") }.distinct().joinToString(", ")) }
        .sortedBy { it.label }
    Spacer(Modifier.height(8.dp))
    WherePicker(stringResource(R.string.add_favourite), campus?.destinations.orEmpty(), null, timetable) { d ->
        if (d == null) return@WherePicker
        // No name to type: it's called what was picked, short, as it reads on a button.
        val to = if (d.kind == "landmark") d.code else d.stopCode
        val same = profile.places.firstOrNull { it.to == to }
        if (same != null) {
            note = L.s(R.string.already_favourite, same.label)
        } else {
            note = null
            account.edit { it.addPlace(if (d.kind == "building" || d.kind == "room") d.code else d.label, to) }
        }
    }
    note?.let { Hint(it) }
    LaunchedEffect(Unit) { account.loadCampus() }
}

/** Light, dark or the phone's own setting, on this phone only. */
@Composable
private fun ThemePicker() {
    val ctx = LocalContext.current
    Choice(
        stringResource(R.string.theme),
        listOf(Theme.AUTO, Theme.LIGHT, Theme.DARK).map { it to stringResource(themeName(it)) },
        Theme.pref(ctx),
        { it?.let { pref -> Theme.set(ctx, pref) } },
    )
    Hint(stringResource(R.string.theme_hint), Modifier.padding(top = 4.dp))
}

/**
 * 12- or 24-hour times for the account, each with an example time. In
 * Settings, `auto` (the phone's own) is a choice too; in setup the phone's
 * style is shown picked until another is.
 */
@Composable
internal fun ClockPicker(profile: ProfileDoc?, account: AccountViewModel, label: String, auto: Boolean) {
    val ctx = LocalContext.current
    val pref = profile?.clock ?: Clock.AUTO
    val options = listOfNotNull(
        if (auto) Clock.AUTO to stringResource(R.string.follow_device) else null,
        Clock.H12 to stringResource(R.string.with_example, stringResource(R.string.clock_12), stringResource(R.string.clock_12_eg)),
        Clock.H24 to stringResource(R.string.with_example, stringResource(R.string.clock_24), "18:36"),
    )
    val shown = if (auto || pref != Clock.AUTO) pref else if (hour12(ctx)) Clock.H12 else Clock.H24
    Choice(label, options, shown, { it?.let(account::setClock) })
}

/** Follow the phone, English or 中文 (phase 10). The languages are named in themselves. */
@Composable
internal fun LanguagePicker(account: AccountViewModel) {
    val ctx = LocalContext.current
    Choice(
        stringResource(R.string.language),
        listOf(Lang.AUTO to stringResource(R.string.follow_device), Lang.EN to "English", Lang.ZH to "中文"),
        Lang.pref(ctx),
        { it?.let(account::setLang) },
    )
    Hint(stringResource(R.string.language_hint), Modifier.padding(top = 4.dp))
}

