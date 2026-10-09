package sh.rcn.terminus.ui

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.MutableSharedFlow
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Lang
import sh.rcn.terminus.R
import sh.rcn.terminus.Servers
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.nusmodsLink

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val account: AccountViewModel by viewModels()
    private val map: MapViewModel by viewModels()
    private val buses: BusesViewModel by viewModels()

    // Android 12 has no per-app language: the chosen one is applied here (Lang).
    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    /** The dark mode and language the screen was last drawn in, to tell which one changed. */
    private var shown: Configuration? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        shown = Configuration(resources.configuration)
        // A recreation (rotation) must not re-apply the link
        // that opened the app and yank the user back to that view.
        if (savedInstanceState == null) handle(intent)
        vm.checkForUpdate(BuildConfig.VERSION_NAME)
        setContent { TerminusTheme { App(vm, account, map, buses) } }
    }

    /**
     * Light or dark, or the language, changed (in Settings or the phone's):
     * the activity stays and Compose redraws in it, with no blank screen
     * between. What recreating it did besides is done here.
     */
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val before = shown
        shown = Configuration(newConfig)
        if (before == null) return
        val night = Configuration.UI_MODE_NIGHT_MASK
        // The navigation bar's icons, light or dark, are set once by enableEdgeToEdge.
        if (before.uiMode and night != newConfig.uiMode and night) enableEdgeToEdge()
        // The answer and the day are written by the server in the app's language.
        if (before.locales != newConfig.locales) {
            vm.load(restart = true)
            vm.loadDay()
        }
    }

    override fun onResume() {
        super.onResume()
        // Notifications blocked or allowed in the phone's settings meanwhile;
        // push asked for, or sent again when due (Push.sync).
        vm.recheckNotifications()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** App shortcuts and notifications open the app on the plan, a place or nearby departures. */
    private fun handle(intent: Intent?) {
        // Share in NUSMods, then terminus: the timetable link, to import.
        if (intent?.action == Intent.ACTION_SEND) {
            nusmodsLink(intent.getStringExtra(Intent.EXTRA_TEXT))?.let(account::shared)
            return
        }
        val data = intent?.data ?: return
        // https://terminus.run/pair?code=… (or the beta's, or either's old
        // address) from the account page's QR code.
        if (data.scheme == "https" && data.host in Servers.siteHosts && data.path?.startsWith("/pair") == true) {
            val code = data.getQueryParameter("code")?.filter { it.isLetterOrDigit() }?.uppercase()
            if (code != null && code.length == 6 && !vm.state.value.paired) vm.checkPairLink(code)
            return
        }
        if (data.scheme != "terminus") return
        // From a long-press shortcut (notifications send no action): tell
        // the launcher, which ranks the shortcuts people use.
        if (intent.action == Intent.ACTION_VIEW) {
            val id = when (data.host) { "place" -> "place:${data.lastPathSegment}"; "plan" -> "next"; else -> data.host }
            id?.let { androidx.core.content.pm.ShortcutManagerCompat.reportShortcutUsed(this, it) }
        }
        when (data.host) {
            "plan" -> vm.select(Target.Plan)
            "place" -> data.lastPathSegment?.let { vm.select(Target.SavedPlace(it)) }
            "nearby" -> vm.showNearby()
            // A stop or place looked up, from the widget showing it.
            // Only from this app's own widgets: another app could otherwise add
            // places with names of its choosing (the activity is exported).
            "to" -> if (intent.getStringExtra(EXTRA_KEY) == Store(this).intentKey) {
                data.lastPathSegment?.let { vm.select(Target.Code(it, (data.getQueryParameter("label") ?: it).take(MAX_LABEL))) }
            }
        }
    }

    companion object {
        private const val EXTRA_KEY = "sh.rcn.terminus.KEY"
        private const val MAX_LABEL = 40

        /** Distinct URIs, so each shortcut gets its own intent. */
        fun intentFor(ctx: Context, place: String? = null, nearby: Boolean = false, to: String? = null, label: String? = null): Intent =
            Intent(ctx, MainActivity::class.java).apply {
                data = when {
                    place != null -> "terminus://place/${Uri.encode(place)}".toUri()
                    nearby -> "terminus://nearby".toUri()
                    to != null -> "terminus://to/${Uri.encode(to)}?label=${Uri.encode(label ?: to)}".toUri()
                    else -> "terminus://plan".toUri()
                }
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_KEY, Store(ctx).intentKey)
            }
    }
}

@Composable
private fun TerminusTheme(content: @Composable () -> Unit) {
    // The Surface sets the default text colour to onBackground. Without it,
    // any Text with no explicit colour is black, invisible in dark mode.
    MaterialTheme(colorScheme = fading(if (isSystemInDarkTheme()) BrandDark else BrandLight)) {
        Surface(color = MaterialTheme.colorScheme.background, content = content)
    }
}

/** The colours, fading from light to dark or back rather than swapping in one frame. */
@Composable
private fun fading(to: ColorScheme): ColorScheme {
    @Composable
    fun Color.fade() = animateColorAsState(this, tween(350), label = "theme").value
    return to.copy(
        primary = to.primary.fade(), onPrimary = to.onPrimary.fade(),
        primaryContainer = to.primaryContainer.fade(), onPrimaryContainer = to.onPrimaryContainer.fade(),
        secondary = to.secondary.fade(), onSecondary = to.onSecondary.fade(),
        secondaryContainer = to.secondaryContainer.fade(), onSecondaryContainer = to.onSecondaryContainer.fade(),
        tertiary = to.tertiary.fade(), onTertiary = to.onTertiary.fade(),
        error = to.error.fade(), onError = to.onError.fade(),
        background = to.background.fade(), onBackground = to.onBackground.fade(),
        surface = to.surface.fade(), onSurface = to.onSurface.fade(),
        surfaceVariant = to.surfaceVariant.fade(), onSurfaceVariant = to.onSurfaceVariant.fade(),
        surfaceContainerHighest = to.surfaceContainerHighest.fade(), surfaceContainerHigh = to.surfaceContainerHigh.fade(),
        surfaceContainer = to.surfaceContainer.fade(), surfaceContainerLow = to.surfaceContainerLow.fade(),
        outline = to.outline.fade(), outlineVariant = to.outlineVariant.fade(),
        inverseSurface = to.inverseSurface.fade(), inverseOnSurface = to.inverseOnSurface.fade(), inversePrimary = to.inversePrimary.fade(),
    )
}

/** Which screen is up, apart from the tabs. */
private enum class Screen { Main, SignIn, Pair }

/** The bottom bar's tabs, once set up. */
private enum class Tab { Now, Buses, Map, Settings }

@Composable
private fun App(vm: MainViewModel, account: AccountViewModel, map: MapViewModel, buses: BusesViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val acct by account.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val store = remember { Store(ctx) }
    var screen by rememberSaveable { mutableStateOf(Screen.Main) }
    var tab by rememberSaveable { mutableStateOf(Tab.Now) }
    var setup by rememberSaveable { mutableStateOf(store.needsSetup) }
    val signedIn = {
        setup = store.needsSetup
        screen = Screen.Main
        tab = Tab.Now
        vm.signedIn()
    }
    val signedOut = {
        account.reset()
        setup = false
        screen = Screen.Main
        tab = Tab.Now
    }
    // Paired with a code: off the Pair screen, to the account's setup if it
    // needs one, else the tabs. Left on it, the app fell through to setup and
    // Skip setup couldn't leave, since the screen was still Pair.
    LaunchedEffect(state.paired) {
        if (state.paired && screen == Screen.Pair) {
            setup = store.needsSetup
            screen = Screen.Main
        }
    }
    // Signed in and set up: Now · Buses · Map · Settings along the bottom.
    if (state.paired && !setup && screen == Screen.Main) {
        Tabs(tab, { tab = it }, vm, account, map, buses, acct, onAddEmail = { account.beginSignIn(); screen = Screen.SignIn }, onSignedOut = signedOut)
    } else if (!state.paired && screen == Screen.Main) {
        // Edge to edge for its livery: it keeps the insets itself.
        WelcomeScreen(
            busy = acct.busy,
            message = acct.message ?: state.pairError,
            onStart = { account.start { store.needsSetup = true; signedIn() } },
            onSignIn = { account.beginSignIn(); screen = Screen.SignIn },
            onPair = { screen = Screen.Pair },
            onLang = { pref -> Lang.set(ctx, pref); recreateOn12(ctx) },
        )
    } else if (screen == Screen.SignIn) {
        // Edge to edge for its band of the sky: it keeps the insets itself.
        BackHandler { account.cancelSignIn(); screen = Screen.Main }
        SignInScreen(
            acct,
            adding = state.paired,
            phase = skyPhase(),
            onSend = { account.sendSignIn(it, signedIn) },
            onCode = { account.enterCode(it, signedIn) },
            onChoose = { keepPhone -> account.choose(keepPhone, signedIn) },
            onDifferentEmail = account::differentEmail,
            onEdit = account::clearMessage,
            onCancel = { account.cancelSignIn(); screen = Screen.Main },
        )
    } else Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 16.dp),
    ) {
        when {
            !state.paired && screen == Screen.Pair -> {
                BackHandler { screen = Screen.Main }
                PairScreen(state, vm::pair, onBack = { screen = Screen.Main })
            }
            else -> OnboardingScreen(acct, account, vm) { setup = false; vm.load(restart = true) }
        }
    }
    // A language chosen here or on another device: Android 13+ redraws in it by itself.
    LaunchedEffect(acct.langChanged) {
        if (acct.langChanged) {
            account.langShown()
            recreateOn12(ctx)
        }
    }
    // A timetable shared from NUSMods once set up: import it after a yes.
    acct.sharedLink?.let { link ->
        if (state.paired && !setup) {
            AlertDialog(
                onDismissRequest = account::dismissShared,
                title = { Text(stringResource(R.string.import_timetable_title)) },
                text = { Text(stringResource(R.string.import_timetable_text)) },
                confirmButton = { TextButton(onClick = { account.import(link); tab = Tab.Settings }) { Text(stringResource(R.string.import_action)) } },
                dismissButton = { TextButton(onClick = account::dismissShared) { Text(stringResource(R.string.cancel)) } },
            )
        }
    }
    state.pendingPair?.let { p ->
        AlertDialog(
            onDismissRequest = vm::dismissPairLink,
            title = { Text(stringResource(R.string.pair_phone_title)) },
            text = { Text(stringResource(R.string.pair_phone_text, p.account)) },
            confirmButton = { TextButton(onClick = { vm.pair(p.code) }) { Text(stringResource(R.string.pair)) } },
            dismissButton = { TextButton(onClick = vm::dismissPairLink) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/**
 * Now · Buses · Map · Settings. Settings sits inside the safe area; Now
 * scrolls under the status bar (its sky reaches the top), and the map runs
 * under it, with its pills below it. Buses keeps inside the safe area.
 */
@Composable
private fun Tabs(
    tab: Tab,
    onTab: (Tab) -> Unit,
    vm: MainViewModel,
    account: AccountViewModel,
    map: MapViewModel,
    buses: BusesViewModel,
    acct: AccountState,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbars = remember { SnackbarHostState() }
    // Settings tapped while already on it: back to its list of all settings.
    val settingsAgain = remember { MutableSharedFlow<Unit>(extraBufferCapacity = 1) }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) { NoticeBar(it) } },
        bottomBar = {
            NavigationBar {
                for ((t, label, icon) in listOf(
                    Triple(Tab.Now, R.string.tab_now, R.drawable.ic_tab_now),
                    Triple(Tab.Buses, R.string.tab_buses, R.drawable.ic_tab_buses),
                    Triple(Tab.Map, R.string.tab_map, R.drawable.ic_tab_map),
                    Triple(Tab.Settings, R.string.settings, R.drawable.ic_tab_settings),
                )) {
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = {
                            if (t == Tab.Now && tab != Tab.Now) vm.load(restart = true)
                            if (t == Tab.Settings && tab == Tab.Settings) settingsAgain.tryEmit(Unit)
                            // Buses tapped while on it: back to its home, from a line or a stop.
                            if (t == Tab.Buses && tab == Tab.Buses) buses.home()
                            // Map tapped while on it: the whole campus, nothing open or chosen.
                            if (t == Tab.Map && tab == Tab.Map) map.home()
                            onTab(t)
                        },
                        icon = { Icon(painterResource(icon), contentDescription = null) },
                        label = { Text(stringResource(label)) },
                    )
                }
            }
        },
    ) { inner ->
        // Back from Buses, Map or Settings goes to Now, as from any other tab bar.
        BackHandler(enabled = tab != Tab.Now) { onTab(Tab.Now); vm.load(restart = true) }
        // Switching tabs fades through (out, then in with a slight zoom), and
        // each tab keeps its saved state while it's away: where Now and
        // Settings were scrolled to, which page of Settings was open, where
        // the map was looking.
        val saved = rememberSaveableStateHolder()
        AnimatedContent(targetState = tab, transitionSpec = { fadeThrough() }, label = "tab") { t ->
            saved.SaveableStateProvider(t.name) {
                when (t) {
                    Tab.Map -> Box(Modifier.fillMaxSize().padding(bottom = inner.calculateBottomPadding())) {
                        // The account's places, for "Save as place" on a stop.
                        LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                        // Before the stop sheet asks, so its board has them too.
                        map.publicBuses = acct.profile?.publicBuses == true
                        MapScreen(
                            map,
                            onGoThere = { code, name ->
                                vm.select(Target.Code(code, name))
                                onTab(Tab.Now)
                            },
                            places = PlacesForMap(
                                savedAs = { code -> acct.profile?.places?.firstOrNull { it.to == code }?.label },
                                full = { acct.profile.let { p -> (p?.places?.size ?: 0) >= (p?.limits ?: sh.rcn.terminus.Limits.DEFAULT).places } },
                                save = { code, name -> account.edit { it.addPlace(name, code) } },
                            ),
                            onShowList = { svc, stop ->
                                buses.home()
                                when {
                                    stop != null -> buses.open(BusRoute.Stop(stop))
                                    svc != null -> buses.open(BusRoute.Line(svc, null))
                                }
                                onTab(Tab.Buses)
                            },
                        )
                    }
                    Tab.Buses -> Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                        // The pinned stops are the profile's.
                        LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                        BusesScreen(
                            buses,
                            insets = inner,
                            pins = acct.profile?.pinnedStops.orEmpty(),
                            publicBuses = acct.profile?.publicBuses == true,
                            pinLimit = (acct.profile?.limits ?: sh.rcn.terminus.Limits.DEFAULT).pinnedStops,
                            onPin = { code -> account.edit { it.pinnedStops = sh.rcn.terminus.Pins.toggle(it.pinnedStops, code, it.limits.pinnedStops) } },
                            onShowOnMap = { svc ->
                                map.show(svc)
                                onTab(Tab.Map)
                            },
                        )
                    }
                    // Edge to edge too, the insets inside, so the list's sky can reach the top.
                    Tab.Settings -> Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                        // Its pages offer Undo in the same bar as Today's.
                        CompositionLocalProvider(LocalNotices provides snackbars) {
                            SettingsScreen(
                                acct, account, vm, inner,
                                toList = settingsAgain,
                                onAddEmail = onAddEmail,
                                onSignedOut = onSignedOut,
                                onClose = { onTab(Tab.Now); vm.load(restart = true) },
                            )
                        }
                    }
                    // Edge to edge, the insets inside its scrolling, so the sky can reach the top.
                    Tab.Now -> Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                        // A stop tapped in Nearby: open on the map, with its sheet.
                        MainScreen(state, vm, insets = inner, email = acct.email, onAddEmail = onAddEmail, onOpenStop = { code -> map.showStop(code); onTab(Tab.Map) })
                    }
                }
            }
        }
    }
}

/** Material's fade through, between tabs: the old one fades out quickly, the new one fades in with a slight zoom. */
private fun fadeThrough(): ContentTransform =
    (fadeIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing)) + scaleIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing), initialScale = 0.92f))
        .togetherWith(fadeOut(tween(90, easing = FastOutLinearInEasing)))

/** Android 12 has no per-app language: the activity starts again in the chosen one (Lang.wrap). */
private fun recreateOn12(ctx: Context) {
    if (android.os.Build.VERSION.SDK_INT < 33) (ctx as? android.app.Activity)?.recreate()
}
