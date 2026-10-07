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
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.L
import sh.rcn.terminus.Lang
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.nusmodsLink

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val account: AccountViewModel by viewModels()
    private val map: MapViewModel by viewModels()

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
        sh.rcn.terminus.Push.register(this)
        setContent { TerminusTheme { App(vm, account, map) } }
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
        // In the front during a trip: the live notification can follow it by location from here on.
        sh.rcn.terminus.LiveService.watch(this)
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
        // https://terminus.rcn.sh/pair?code=… (or the beta's) from the account page's QR code.
        if (data.scheme == "https" && data.host == BuildConfig.SITE.toUri().host && data.path?.startsWith("/pair") == true) {
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
private enum class Tab { Now, Map, Settings }

@Composable
private fun App(vm: MainViewModel, account: AccountViewModel, map: MapViewModel) {
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
    // Signed in and set up: Now · Map · Settings along the bottom.
    if (state.paired && !setup && screen == Screen.Main) {
        Tabs(tab, { tab = it }, vm, account, map, acct, onAddEmail = { account.beginSignIn(); screen = Screen.SignIn }, onSignedOut = signedOut)
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
    } else Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 16.dp),
    ) {
        when {
            screen == Screen.SignIn -> {
                BackHandler { account.cancelSignIn(); screen = Screen.Main }
                SignInScreen(
                    acct,
                    adding = state.paired,
                    onSend = { account.sendSignIn(it, signedIn) },
                    onCode = { account.enterCode(it, signedIn) },
                    onChoose = { keepPhone -> account.choose(keepPhone, signedIn) },
                    onCancel = { account.cancelSignIn(); screen = Screen.Main },
                )
            }
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
 * Now · Map · Settings. Settings sits inside the safe area; Now scrolls
 * under the status bar (its sky reaches the top), and the map runs under
 * it, with its pills below it.
 */
@Composable
private fun Tabs(
    tab: Tab,
    onTab: (Tab) -> Unit,
    vm: MainViewModel,
    account: AccountViewModel,
    map: MapViewModel,
    acct: AccountState,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbars = remember { SnackbarHostState() }
    RemovedBar(state.removed, state.removeError, snackbars, vm)
    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) { NoticeBar(it) } },
        bottomBar = {
            NavigationBar {
                for ((t, label, icon) in listOf(
                    Triple(Tab.Now, R.string.tab_now, R.drawable.ic_tab_now),
                    Triple(Tab.Map, R.string.tab_map, R.drawable.ic_tab_map),
                    Triple(Tab.Settings, R.string.settings, R.drawable.ic_tab_settings),
                )) {
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = {
                            if (t == Tab.Now && tab != Tab.Now) vm.load(restart = true)
                            onTab(t)
                        },
                        icon = { Icon(painterResource(icon), contentDescription = null) },
                        label = { Text(stringResource(label)) },
                    )
                }
            }
        },
    ) { inner ->
        // Back from Map or Settings goes to Now, as from any other tab bar.
        BackHandler(enabled = tab != Tab.Now) { onTab(Tab.Now); vm.load(restart = true) }
        // Switching tabs fades through (out, then in with a slight zoom), and
        // Now and Map keep their saved state while they're away: where Now
        // was scrolled to, where the map was looking. Settings starts again
        // from its list, not the page it was left on.
        val saved = rememberSaveableStateHolder()
        LaunchedEffect(tab) { if (tab != Tab.Settings) saved.removeState(Tab.Settings.name) }
        AnimatedContent(targetState = tab, transitionSpec = { fadeThrough() }, label = "tab") { t ->
            saved.SaveableStateProvider(t.name) {
                when (t) {
                    Tab.Map -> Box(Modifier.fillMaxSize().padding(bottom = inner.calculateBottomPadding())) {
                        // The account's places, for "Save as place" on a stop.
                        LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                        MapScreen(
                            map,
                            onGoThere = { code, name ->
                                vm.select(Target.Code(code, name))
                                onTab(Tab.Now)
                            },
                            places = PlacesForMap(
                                savedAs = { code -> acct.profile?.places?.firstOrNull { it.to == code }?.label },
                                full = { (acct.profile?.places?.size ?: 0) >= MAX_PLACES },
                                save = { code, name -> account.edit { it.addPlace(name, code) } },
                            ),
                        )
                    }
                    // Edge to edge too, the insets inside, so the list's sky can reach the top.
                    Tab.Settings -> Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                        SettingsScreen(
                            acct, account, vm, inner,
                            onAddEmail = onAddEmail,
                            onSignedOut = onSignedOut,
                            onClose = { onTab(Tab.Now); vm.load(restart = true) },
                        )
                    }
                    // Edge to edge, the insets inside its scrolling, so the sky can reach the top.
                    Tab.Now -> Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                        // A stop tapped in Nearby: open on the map, with its sheet.
                        MainScreen(state, vm, insets = inner, onOpenStop = { code -> map.showStop(code); onTab(Tab.Map) })
                    }
                }
            }
        }
    }
}

/**
 * After a swipe off Today: "GEA1000 removed from today · Undo" in a bar at
 * the foot of the screen, above the tabs, for a few seconds (NoticeBar); and
 * why a swipe didn't take, the same way, marked in red. A second swipe
 * replaces the bar.
 */
@Composable
private fun RemovedBar(removed: DayItem?, error: String?, host: SnackbarHostState, vm: MainViewModel) {
    val undo = stringResource(R.string.undo)
    LaunchedEffect(removed?.key) {
        val item = removed ?: return@LaunchedEffect
        val result = host.showSnackbar(Notice(L.s(R.string.taken_off_today, item.shortName()), actionLabel = undo))
        if (result == SnackbarResult.ActionPerformed) vm.undoRemove() else vm.dismissRemoved(item.key)
    }
    LaunchedEffect(error) {
        if (error == null) return@LaunchedEffect
        host.showSnackbar(Notice(error, error = true))
        vm.dismissRemoveError()
    }
}

/** Material's fade through, between tabs: the old one fades out quickly, the new one fades in with a slight zoom. */
private fun fadeThrough(): ContentTransform =
    (fadeIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing)) + scaleIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing), initialScale = 0.92f))
        .togetherWith(fadeOut(tween(90, easing = FastOutLinearInEasing)))

/** The account's limit on saved places (PROFILE_LIMITS.places in the API). */
private const val MAX_PLACES = 12

/** Android 12 has no per-app language: the activity starts again in the chosen one (Lang.wrap). */
private fun recreateOn12(ctx: Context) {
    if (android.os.Build.VERSION.SDK_INT < 33) (ctx as? android.app.Activity)?.recreate()
}
