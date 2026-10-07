package sh.rcn.terminus.ui

import android.content.Intent
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.drawscope.Stroke
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
import androidx.compose.animation.animateColorAsState
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.ui.graphics.Color
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.SeekableTransitionState
import androidx.compose.animation.core.rememberTransition
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
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
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
 * to the list, as does tapping the Settings tab again ([toList]).
 */
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
    LaunchedEffect(Unit) { account.refresh() }
    LaunchedEffect(state.email) { if (state.email != null) account.loadDevices() }
    LaunchedEffect(Unit) { account.loadChoices() }
    LaunchedEffect(Unit) { account.loadCampus() }

    var open by rememberSaveable { mutableStateOf<SettingsPage?>(null) }
    // A NUSMods link shared into the app: straight to Timetable, to import it.
    LaunchedEffect(state.sharedLink) { if (state.sharedLink != null) open = SettingsPage.Timetable }
    LaunchedEffect(Unit) { toList.collect { open = null } }
    // The list and its pages are one transition that a back gesture can
    // seek, as Android's own apps do: the list is drawn under the page from
    // the start, sliding and fading in as the page goes, rather than the
    // page moving over nothing. Let go, and it carries on from there.
    val pages = remember { SeekableTransitionState(open) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(open) { pages.animateTo(open) }
    // How far a back gesture has gone, for the page to shrink as it follows.
    // Kept after the gesture completes, so it leaves at the size it was let go.
    var backProgress by remember { mutableFloatStateOf(0f) }
    LaunchedEffect(open) { if (open != null) backProgress = 0f }
    BackHandler(enabled = open == null, onBack = onClose)
    PredictiveBackHandler(enabled = open != null) { events ->
        val page = open
        try {
            events.collect {
                backProgress = it.progress
                pages.seekTo(it.progress, targetState = null)
            }
            open = null
        } catch (e: CancellationException) {
            backProgress = 0f
            scope.launch { pages.animateTo(page) }
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
        rememberTransition(pages, label = "settings page").AnimatedContent(
            transitionSpec = {
                if (targetState != null) {
                    (slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { it } + fadeIn(tween(300)))
                        .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeOut(tween(200)))
                } else {
                    // Back: the page stays solid as it slides off, so a back gesture
                    // holds a page, not a ghost of one; the list fades up behind it.
                    ((slideInHorizontally(tween(300, easing = FastOutSlowInEasing)) { -it / 4 } + fadeIn(tween(300)))
                        .togetherWith(slideOutHorizontally(tween(300, easing = FastOutSlowInEasing)) { it }))
                        .apply { targetContentZIndex = -1f }
                }
            },
            modifier = Modifier.weight(1f),
        ) { page ->
            if (page == null) {
                SettingsList(state, main, if (state.message != null) 0.dp else top, bottom) { open = it }
            } else {
                Column(
                    Modifier.fillMaxSize().graphicsLayer {
                        // Following the back gesture (the transition slides it): the page
                        // shrinks a little into a card with rounded corners and a shadow,
                        // lifted off the list behind it.
                        val scale = 1f - backProgress * 0.1f
                        scaleX = scale
                        scaleY = scale
                        if (backProgress > 0f) {
                            shape = RoundedCornerShape((backProgress * 5f).coerceAtMost(1f) * 28.dp.toPx())
                            clip = true
                            shadowElevation = 8.dp.toPx()
                        }
                    }.background(MaterialTheme.colorScheme.background).padding(bottom = bottom),
                ) {
                    // The title in a slim band of the list's sky; the page itself plain.
                    SkyBand(skyPhase(), if (state.message != null) 0.dp else top) {
                        TabHeader {
                            // The arrow sits in the margin, so the title lines up with the list's.
                            IconButton(onClick = { open = null }, modifier = Modifier.offset(x = (-12).dp)) {
                                Icon(painterResource(R.drawable.ic_back), contentDescription = stringResource(R.string.back))
                            }
                            Text(stringResource(page.title), style = MaterialTheme.typography.titleLarge, modifier = Modifier.offset(x = (-12).dp))
                        }
                    }
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
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
 * route down the card (home stop, classes, hours, pace), each stop a row
 * opening its page, what isn't set yet in the accent; then the
 * rest as tiles, each saying what's set. Notifications all off shows in
 * amber: it's the setting that changes the most. About is under them.
 * The title is in the same slim band of the sky as each page's, so opening
 * one doesn't change the top; the list is plain under it and scrolls, as a
 * page does. [top] and [bottom]: the status bar's and the tab bar's room.
 */
@Composable
private fun SettingsList(state: AccountState, main: MainViewModel, top: Dp, bottom: Dp, onOpen: (SettingsPage) -> Unit) {
    val ui by main.state.collectAsStateWithLifecycle()
    val profile = state.profile
    Column(Modifier.fillMaxSize()) {
        SkyBand(skyPhase(), top) {
            TabHeader { Text(stringResource(R.string.settings), style = MaterialTheme.typography.titleLarge) }
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(bottom = bottom)
                .padding(horizontal = 16.dp),
        ) {
            Spacer(Modifier.height(12.dp))
            AccountTile(state, ui, onOpen)
            Spacer(Modifier.height(20.dp))
            SettingsGround(state, ui, profile, onOpen)
        }
    }
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
    // Your day, as a route on its side: each stop a row opening its page.
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier.padding(top = 12.dp).fillMaxWidth().clip(shape).background(c.surface)
            .border(1.dp, c.outlineVariant, shape).padding(top = 14.dp, bottom = 4.dp),
    ) {
        Label(stringResource(R.string.heading_your_day), Modifier.padding(horizontal = 14.dp).semantics { heading() })
        val h12 = hour12(LocalContext.current)
        val time = { m: Int -> if (h12) hhmm12(m) else hhmm(m) }
        val home = profile?.homeStops?.firstOrNull()?.let { code -> state.campus?.stopName(code) ?: code }
        val classes = profile?.let { it.trips.size + it.manual.size }
        DayRoute(
            listOf(
                DayStop(stringResource(R.string.home_stop), home ?: stringResource(R.string.choose_your_stop), home == null && profile != null, SettingsPage.Trips),
                DayStop(
                    stringResource(R.string.timetable),
                    if (classes == 0 && !state.needsReimport) stringResource(R.string.import_from_nusmods) else summary(SettingsPage.Timetable, state, ui.leaveAlerts, ui.liveUpdates, ui.detectTrips).orEmpty(),
                    classes == 0 || state.needsReimport,
                    SettingsPage.Timetable,
                ),
                DayStop(stringResource(R.string.show_buses_between), profile?.let { "${time(it.dayStartMin)} – ${time(it.dayEndMin)}" }.orEmpty(), false, SettingsPage.Trips),
                DayStop(stringResource(R.string.walking_pace), profile?.let { stringResource(paceName(it.walkPace)) }.orEmpty(), false, SettingsPage.Trips),
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

/** One stop on the day's route: what it is, what's set ([todo]: nothing yet, in the accent), and the page it opens. */
private data class DayStop(val label: String, val value: String, val todo: Boolean, val page: SettingsPage)

/**
 * Your day's stops down a line, each a row with a chevron like the rest of
 * Settings, so they read as things to tap. The line runs dot to dot: from
 * the first dot down, and into the last.
 */
@Composable
private fun DayRoute(stops: List<DayStop>, onOpen: (SettingsPage) -> Unit) {
    val c = MaterialTheme.colorScheme
    Column(Modifier.padding(top = 4.dp)) {
        stops.forEachIndexed { i, stop ->
            Row(
                Modifier.fillMaxWidth().height(IntrinsicSize.Min).clickable(role = Role.Button) { onOpen(stop.page) }.padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Canvas(Modifier.width(16.dp).fillMaxHeight()) {
                    val x = size.width / 2
                    val y = size.height / 2
                    val w = 3.dp.toPx()
                    if (i > 0) drawLine(c.primary, Offset(x, 0f), Offset(x, y), w)
                    if (i < stops.lastIndex) drawLine(c.primary, Offset(x, y), Offset(x, size.height), w)
                    val r = 7.dp.toPx()
                    drawCircle(c.surface, r, Offset(x, y))
                    drawCircle(c.primary, r - 1.75.dp.toPx(), Offset(x, y), style = Stroke(3.5.dp.toPx()))
                }
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f).padding(vertical = 10.dp)) {
                            Text(stop.label, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                stop.value,
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                color = if (stop.todo) c.primary else c.onSurface,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = c.onSurfaceVariant)
                    }
                    if (i < stops.lastIndex) RowDivider()
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
        SettingsPage.Timetable -> Groups {
            if (profile == null) return@Groups
            var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: profile.share.orEmpty()) }
            // The semester the link is for has ended: say so above everything else.
            if (state.needsReimport) {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Text(stringResource(R.string.reimport_title), style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.reimport_text, state.term.orEmpty()), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            Group(stringResource(R.string.heading_from_nusmods), stringResource(R.string.nusmods_hint)) {
                Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) { TimetableImport(state, account, link, inSettings = true) { link = it } }
            }
            Classes(profile, state.campus, account)
        }
        SettingsPage.Favourites -> if (profile != null) Groups { Favourites(profile, state.campus, account) }
        SettingsPage.Notifications -> Groups { NotificationSettings(main) }
        SettingsPage.Devices -> Groups {
            if (state.email == null) {
                Hint(stringResource(R.string.not_signed_in_hint))
                InkButton(stringResource(R.string.add_email), onAddEmail)
            } else {
                Devices(state, account, onSignedOut)
            }
        }
        SettingsPage.Language -> Groups {
            LanguagePicker(account)
            Group(stringResource(R.string.time_format), stringResource(R.string.time_format_hint_auto)) {
                ClockPills(state.profile, account)
            }
        }
        SettingsPage.Appearance -> Groups {
            ThemePicker()
            CardStylePicker()
        }
        SettingsPage.Account -> Groups { AccountSection(state, account, main, onAddEmail, onSignedOut) }
        SettingsPage.About -> Groups { AboutPage() }
        SettingsPage.Feedback -> Groups { FeedbackPage(state, account, onAddEmail) }
    }
}

/** The app's mark, name and version; what it is, that it isn't NUS's, and where its data comes from; then its links. */
@Composable
private fun AboutPage() {
    val ctx = LocalContext.current
    val open = { url: String -> ctx.startActivity(Intent(Intent.ACTION_VIEW, url.toUri())) }
    val host = BuildConfig.SITE.removePrefix("https://").removePrefix("http://")
    // Each link's name, where it goes, and that place as shown under the name.
    val links = listOf(
        Triple(R.string.get_apps, BuildConfig.SITE, host),
        Triple(R.string.status, "${BuildConfig.SITE}/status", "$host/status"),
        Triple(R.string.privacy, "${BuildConfig.SITE}/privacy", "$host/privacy"),
        Triple(R.string.api_docs, "${BuildConfig.SITE}/docs", "$host/docs"),
        Triple(R.string.source_code, "https://github.com/rcnsh/terminus", "github.com/rcnsh/terminus"),
        Triple(R.string.map_data, "https://www.openstreetmap.org/copyright", "openstreetmap.org"),
        Triple(R.string.aup, "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf", "nus.edu.sg"),
    )
    Column(Modifier.padding(horizontal = 4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BrandMark(Modifier.size(44.dp))
            Column(Modifier.padding(start = 12.dp)) {
                Text("terminus", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                Hint(stringResource(R.string.about_version, BuildConfig.VERSION_NAME))
            }
        }
        Text(stringResource(R.string.about_what), modifier = Modifier.padding(top = 14.dp))
        Hint(stringResource(R.string.about_independent), Modifier.padding(top = 10.dp))
    }
    // Every one opens in the browser, out of the app.
    Group(stringResource(R.string.heading_more), stringResource(R.string.about_aup)) {
        links.forEachIndexed { i, (title, url, where) ->
            if (i > 0) RowDivider()
            LinkRow(stringResource(title), { open(url) }, sub = where, away = true)
        }
    }
}

/** The longest note the server takes; the counter turns amber from [FEEDBACK_NEAR]. */
private const val FEEDBACK_MAX = 1000
private const val FEEDBACK_NEAR = 900

/**
 * A note to the operator about anything, laid out as a message: who it's
 * from, the note, then a counter and Send. Only an account with an email can
 * send one, so there's someone to reply to; without one, the page asks for an
 * email instead. A wrong answer is better sent from under the card, so the
 * card below says so.
 */
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
                Text(email, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            RowDivider()
            // The note is the card's body: no box of its own, and it scrolls inside past ten lines.
            TextField(
                value = note,
                onValueChange = { note = it.take(FEEDBACK_MAX) },
                placeholder = { Text(stringResource(R.string.feedback_placeholder)) },
                minLines = 6,
                maxLines = 10,
                colors = TextFieldDefaults.colors(
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
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${note.length} / $FEEDBACK_MAX", style = MaterialTheme.typography.labelMedium, color = count, modifier = Modifier.weight(1f))
                InkButton(
                    stringResource(R.string.send),
                    { account.sendFeedback(note) { note = "" } },
                    enabled = note.isNotBlank() && !state.busy,
                )
            }
        }
        Group(null) {
            Row(Modifier.padding(16.dp)) {
                Icon(painterResource(R.drawable.ic_chat), contentDescription = null, tint = c.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp).size(20.dp))
                Column(Modifier.padding(start = 12.dp)) {
                    Text(stringResource(R.string.feedback_wrong_title), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
                    Hint(stringResource(R.string.feedback_wrong_hint), Modifier.padding(top = 2.dp))
                }
            }
        }
    }
}

/**
 * Leave alerts, the live notification and noticing when you board: on this
 * phone only, in two groups (before class, during a trip), each row with a
 * short line and the details under the group. Exact alarms are asked for
 * when either notification is on.
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
    Group(stringResource(R.string.heading_before_class), stringResource(R.string.notify_leave_more)) {
        NotifyToggle(
            stringResource(R.string.notify_leave),
            stringResource(R.string.notify_leave_short),
            ui.leaveAlerts, main::setLeaveAlerts, openSettings, inCard = true,
        )
    }
    Group(stringResource(R.string.heading_during_trip), stringResource(R.string.during_trip_hint)) {
        NotifyToggle(
            stringResource(R.string.live_notification),
            stringResource(R.string.live_notification_short),
            ui.liveUpdates, main::setLiveUpdates, openSettings, inCard = true,
        )
        RowDivider()
        DetectToggle(ui.detectTrips, main::setDetectTrips, openSettings, hint = stringResource(R.string.detect_short), inCard = true)
    }
    if ((ui.leaveAlerts || ui.liveUpdates) && !exact) {
        Column {
            Hint(stringResource(R.string.exact_off), Modifier.padding(horizontal = 4.dp))
            TextButton(onClick = { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } }) { Text(stringResource(R.string.allow_exact)) }
        }
    }
}

/** What you chose for particular classes, each undoable. */
@Composable
internal fun TripChoices(state: AccountState, account: AccountViewModel) {
    if (state.choices.isEmpty()) return
    Group(stringResource(R.string.your_classes)) {
        state.choices.forEachIndexed { i, c ->
            if (i > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.label ?: stringResource(R.string.class_gone))
                    Hint(if (c.pref == "earlier") stringResource(R.string.one_bus_earlier) else stringResource(R.string.no_reminders))
                }
                RemoveButton({ account.undoChoice(c) }, stringResource(R.string.undo))
            }
        }
    }
}

/** How each trip went, kept 35 days for the suggestions; cleared here without touching the rest. */
@Composable
internal fun TripHistory(state: AccountState, account: AccountViewModel) {
    if (state.history == 0) return
    var confirm by remember { mutableStateOf(false) }
    Group(stringResource(R.string.trip_history), stringResource(R.string.history_kept)) {
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

/**
 * Who you're signed in as, with Sign out; your data; the account page for
 * API keys and signing out everywhere (the web's alone); then Delete account
 * on its own at the foot, the only red on any page.
 */
@Composable
private fun AccountSection(state: AccountState, account: AccountViewModel, main: MainViewModel, onAddEmail: () -> Unit, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    val c = MaterialTheme.colorScheme
    var confirm by remember { mutableStateOf<String?>(null) }
    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri -> uri?.let(account::exportTo) }
    val email = state.email
    if (email == null) {
        Group(stringResource(R.string.not_signed_in), stringResource(R.string.not_signed_in_hint)) {
            InkButton(stringResource(R.string.add_email), onAddEmail, Modifier.fillMaxWidth().padding(16.dp))
        }
    } else {
        Group(stringResource(R.string.heading_signed_in)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(40.dp).background(c.primary, CircleShape), contentAlignment = Alignment.Center) {
                    Text(email.take(1).uppercase(), color = c.onPrimary, fontWeight = FontWeight.ExtraBold, fontSize = 17.sp)
                }
                Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                    Text(email, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    state.devices?.let { Hint(if (it.size == 1) stringResource(R.string.one_device) else stringResource(R.string.n_devices, it.size)) }
                }
                OutlinedButton(onClick = { confirm = "signout" }) { Text(stringResource(R.string.sign_out)) }
            }
        }
    }
    Group(stringResource(R.string.heading_your_data)) {
        LinkRow(stringResource(R.string.download_data), { export.launch("terminus-export.json") })
        if (email != null) {
            RowDivider()
            LinkRow(stringResource(R.string.account_page), { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }, sub = stringResource(R.string.account_page_sub), away = true)
        }
    }
    // An account with an email is deleted from the account page, signed in on the web (the server insists).
    Group(null) {
        if (email == null) {
            LinkRow(stringResource(R.string.delete_account), { confirm = "delete" }, color = c.error)
        } else {
            LinkRow(stringResource(R.string.delete_account), { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }, away = true, color = c.error)
        }
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
            text = { Text(stringResource(R.string.sign_out_text, email.orEmpty())) },
            confirmButton = { TextButton(onClick = { confirm = null; main.unpair(); account.reset(); onSignedOut() }) { Text(stringResource(R.string.sign_out)) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** Your devices, each removable (this phone signs out), then Add a device. */
@Composable
private fun Devices(state: AccountState, account: AccountViewModel, onSignedOut: () -> Unit) {
    var removing by remember { mutableStateOf<Device?>(null) }
    val devices = state.devices
    if (devices == null) {
        CircularProgressIndicator(Modifier.size(20.dp))
    } else if (devices.isNotEmpty()) {
        Group(stringResource(R.string.heading_your_devices)) {
            devices.forEachIndexed { i, d ->
                if (i > 0) RowDivider()
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(d.name, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            if (d.current) Tag(stringResource(R.string.this_phone_tag))
                        }
                        val now = System.currentTimeMillis()
                        val used = if (now - d.lastSeenMs < 60_000) stringResource(R.string.just_now) else android.text.format.DateUtils.getRelativeTimeSpanString(d.lastSeenMs, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                        Hint(listOfNotNull(platformName(d.platform), stringResource(R.string.used_when, used)).joinToString(" · "))
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
            text = { Text(if (d.current) stringResource(R.string.remove_this_phone) else stringResource(R.string.remove_other)) },
            confirmButton = { TextButton(onClick = { removing = null; account.removeDevice(d) { onSignedOut() } }) { Text(stringResource(R.string.remove)) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
    state.pairCode?.let { code -> PairCodeDialog(code, account::closePairCode) }
}

/** A small grey label beside a name: "This phone". */
@Composable
private fun Tag(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 8.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
    )
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

/**
 * Every class, imported or added by hand, by day and time, each with Remove,
 * in one card ending in "+ Add a class or commitment by hand"; then any
 * favourites at their usual time each week.
 */
@Composable
private fun Classes(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    val time = { m: Int -> if (h12) hhmm12(m) else hhmm(m) }
    val destinations = campus?.destinations.orEmpty()
    // Monday first, as the week reads; the index is the class's place in its own list.
    val order = WEEKDAYS.map { it.first }
    var changing by rememberSaveable { mutableStateOf<String?>(null) }
    var open by rememberSaveable { mutableStateOf(false) }
    val all = (profile.trips.mapIndexed { i, t -> Triple(true, i, t) } + profile.manual.mapIndexed { i, t -> Triple(false, i, t) })
        .sortedWith(compareBy({ order.indexOf(it.third.day) }, { it.third.arriveByMin }))
    val count = when (all.size) {
        0 -> stringResource(R.string.no_classes_yet)
        1 -> stringResource(R.string.one_class)
        else -> stringResource(R.string.n_classes, all.size)
    }
    Group(count) {
        for ((imported, i, t) in all) {
            // Tapped, a class opens to change its stop, as on the web.
            val key = "${if (imported) "t" else "m"}$i"
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { changing = if (changing == key) null else key }.padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("${dayShort(t.day)} ${time(t.arriveByMin)} · ${t.label}", style = MaterialTheme.typography.bodyLarge)
                    val about = listOfNotNull(campus?.let { L.s(R.string.stop_suffix, it.stopName(t.to)) }, if (imported) null else stringResource(R.string.added_by_hand))
                    if (about.isNotEmpty()) Hint(about.joinToString(" · "))
                }
                RemoveButton({ account.edit { it.removeClass(imported, i) } })
            }
            if (changing == key) {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp)) {
                    WherePicker(stringResource(R.string.change_stop, t.label), destinations, null) { d ->
                        if (d != null) {
                            account.edit { it.setClassStop(imported, i, if (d.kind == "landmark") d.code else d.stopCode) }
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
            AddClass(destinations, account) { open = false }
        }
    }
    // A favourite at its usual time each week: removable here with the classes.
    val usual = profile.usual.mapNotNull { u -> profile.places.firstOrNull { it.key == u.place }?.let { u to it } }
        .sortedWith(compareBy({ order.indexOf(it.first.day) }, { it.first.atMin }))
    if (usual.isNotEmpty()) {
        Group(stringResource(R.string.every_week)) {
            usual.forEachIndexed { n, (u, place) ->
                if (n > 0) RowDivider()
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
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

/** A class or commitment by hand: its day, times, name and where, under the classes. */
@Composable
private fun AddClass(destinations: List<Destination>, account: AccountViewModel, onDone: () -> Unit) {
    var day by rememberSaveable { mutableIntStateOf(1) }
    var start by rememberSaveable { mutableStateOf<Int?>(null) }
    var end by rememberSaveable { mutableStateOf<Int?>(null) }
    var label by rememberSaveable { mutableStateOf("") }
    var where by remember { mutableStateOf<Destination?>(null) }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Choice(stringResource(R.string.day), WEEKDAYS, day, { day = it ?: 1 })
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TimeButton(stringResource(R.string.starts), start, { start = it }, Modifier.weight(1f))
            TimeButton(stringResource(R.string.ends), end, { end = it }, Modifier.weight(1f))
        }
        OutlinedTextField(label, { if (it.length <= 60) label = it }, label = { Text(stringResource(R.string.name_eg_gym)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
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
                        account.edit { it.addManual(Trip(day, s, end?.takeIf { e -> e > s }, w.stopCode, label.trim(), "")) }
                        onDone()
                    }
                },
                enabled = start != null && where != null && label.isNotBlank(),
            )
        }
    }
}

/** Your favourites in one card, each with Remove, ending in the search to add one. */
@Composable
private fun Favourites(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    // A stop's name, or a food court's (favourites and classes can go to one).
    val stopName = { code: String ->
        campus?.stops?.firstOrNull { it.code == code }?.name ?: campus?.destinations?.firstOrNull { it.code == code && it.kind == "landmark" }?.label ?: code
    }
    var note by remember { mutableStateOf<String?>(null) }
    Group(stringResource(R.string.heading_your_favourites), note ?: stringResource(R.string.favourites_hint)) {
        for (p in profile.places) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(p.label, style = MaterialTheme.typography.bodyLarge)
                    // Where it goes, when the name doesn't already say (a building's stop, or a name from before favourites).
                    if (campus != null && p.label != stopName(p.to)) Hint(stringResource(R.string.stop_suffix, stopName(p.to)))
                }
                RemoveButton({ account.edit { it.removePlace(p.key) } })
            }
            RowDivider()
        }
        if (profile.places.size < 12) {
            // The stops your classes go to come first, each saying which classes use it.
            val favourite = profile.places.map { it.to }.toSet()
            val timetable = (profile.trips + profile.manual).groupBy { it.to }
                .filterKeys { it !in favourite }
                .map { (to, classes) -> Destination(to, stopName(to), to, "timetable", detail = classes.map { it.label.substringBefore(" @ ") }.distinct().joinToString(", ")) }
                .sortedBy { it.label }
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
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
            }
        }
    }
    LaunchedEffect(Unit) { account.loadCampus() }
}

/** Auto, light or dark, on this phone only. */
@Composable
private fun ThemePicker() {
    val ctx = LocalContext.current
    // Read again when it changes, so the pill moves before the theme does.
    var pref by remember { mutableStateOf(Theme.pref(ctx)) }
    Group(stringResource(R.string.theme), stringResource(R.string.theme_hint)) {
        Pills(
            listOf(Theme.AUTO to stringResource(R.string.auto), Theme.LIGHT to stringResource(R.string.theme_light), Theme.DARK to stringResource(R.string.theme_dark)),
            pref,
            { Theme.set(ctx, it); pref = it },
            Modifier.padding(16.dp),
        )
    }
}

/** Auto (the phone's own), 12- or 24-hour, for the account. */
@Composable
private fun ClockPills(profile: ProfileDoc?, account: AccountViewModel) {
    Pills(
        listOf(Clock.AUTO to stringResource(R.string.auto), Clock.H12 to stringResource(R.string.clock_12), Clock.H24 to stringResource(R.string.clock_24)),
        profile?.clock ?: Clock.AUTO,
        account::setClock,
        Modifier.padding(16.dp),
    )
}

/** Auto (the phone's), English or 中文 (phase 10). The languages are named in themselves. */
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
