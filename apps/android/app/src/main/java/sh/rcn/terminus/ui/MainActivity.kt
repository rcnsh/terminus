package sh.rcn.terminus.ui

import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
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
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineBreak
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.DeviceKind
import sh.rcn.terminus.L
import sh.rcn.terminus.Lang
import sh.rcn.terminus.R
import sh.rcn.terminus.RemovedPlace
import sh.rcn.terminus.Servers
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.nusmodsLink

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val account: AccountViewModel by viewModels()
    private val map: MapViewModel by viewModels()
    private val buses: BusesViewModel by viewModels()

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Lang.wrap(base))

    private var linkTab by mutableStateOf<Tab?>(null)

    private var shown: Configuration? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        keepUpright(resources.configuration)
        enableEdgeToEdge()
        shown = Configuration(resources.configuration)
        if (savedInstanceState == null) handle(intent)
        vm.checkForUpdate(BuildConfig.VERSION_NAME)
        setContent { TerminusTheme { ProvideWindowWidth { App(vm, account, map, buses, linkTab) { linkTab = null } } } }
    }

    private fun keepUpright(c: Configuration) {
        val want =
            if (Widths.upright(c.smallestScreenWidthDp)) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        if (requestedOrientation != want) requestedOrientation = want
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        keepUpright(newConfig)
        val before = shown
        shown = Configuration(newConfig)
        if (before == null) return
        val night = Configuration.UI_MODE_NIGHT_MASK
        if (before.uiMode and night != newConfig.uiMode and night) enableEdgeToEdge()
        if (before.locales != newConfig.locales) {
            vm.load(restart = true)
            vm.loadDay()
        }
    }

    override fun onResume() {
        super.onResume()
        vm.recheckNotifications()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        if (intent?.action == Intent.ACTION_SEND) {
            nusmodsLink(intent.getStringExtra(Intent.EXTRA_TEXT))?.let(account::shared)
            return
        }
        val data = intent?.data ?: return
        if (data.scheme == "https" && data.host in Servers.siteHosts && data.path?.startsWith("/pair") == true) {
            val code = data.getQueryParameter("code")?.filter { it.isLetterOrDigit() }?.uppercase()
            if (code != null && code.length == 6 && !vm.state.value.paired) vm.checkPairLink(code)
            return
        }
        if (data.scheme != "terminus") return
        if (intent.action == Intent.ACTION_VIEW) {
            val id =
                when (data.host) {
                    "place" -> data.lastPathSegment?.let { "place:$it" }
                    "plan" -> "next"
                    else -> data.host
                }
            id?.let { androidx.core.content.pm.ShortcutManagerCompat.reportShortcutUsed(this, it) }
        }
        val target =
            when (data.host) {
                "plan" -> Target.Plan
                "place" -> data.lastPathSegment?.let { Target.SavedPlace(it) }
                "to" ->
                    data.lastPathSegment
                        ?.takeIf { intent.getStringExtra(EXTRA_KEY) == Store(this).intentKey }
                        ?.let { Target.Code(it, (data.getQueryParameter("label") ?: it).take(MAX_LABEL)) }
                else -> null
            }
        target?.let(vm::select)
        if (target != null || data.host == "nearby") linkTab = Tab.ofLink(data.host)
    }

    companion object {
        private const val EXTRA_KEY = "sh.rcn.terminus.KEY"
        private const val MAX_LABEL = 40

        fun intentFor(ctx: Context, place: String? = null, nearby: Boolean = false, to: String? = null, label: String? = null): Intent =
            Intent(ctx, MainActivity::class.java).apply {
                data =
                    when {
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
    MaterialTheme(colorScheme = fading(if (isSystemInDarkTheme()) BrandDark else BrandLight), typography = TerminusType) {
        Surface(color = MaterialTheme.colorScheme.background, content = content)
    }
}

private val TerminusType =
    Typography().run {
        fun TextStyle.digits() = copy(fontFeatureSettings = "tnum")
        fun TextStyle.heading() = digits().copy(lineBreak = LineBreak.Heading)
        fun TextStyle.body() = digits().copy(lineBreak = LineBreak.Paragraph)
        Typography(
            displayLarge = displayLarge.heading(),
            displayMedium = displayMedium.heading(),
            displaySmall = displaySmall.heading(),
            headlineLarge = headlineLarge.heading(),
            headlineMedium = headlineMedium.heading(),
            headlineSmall = headlineSmall.heading(),
            titleLarge = titleLarge.heading(),
            titleMedium = titleMedium.heading(),
            titleSmall = titleSmall.heading(),
            bodyLarge = bodyLarge.body(),
            bodyMedium = bodyMedium.body(),
            bodySmall = bodySmall.body(),
            labelLarge = labelLarge.digits(),
            labelMedium = labelMedium.digits(),
            labelSmall = labelSmall.digits(),
        )
    }

@Composable
private fun fading(to: ColorScheme): ColorScheme {
    @Composable fun Color.fade() = animateColorAsState(this, tween(350), label = "theme").value
    return to.copy(
        primary = to.primary.fade(),
        onPrimary = to.onPrimary.fade(),
        primaryContainer = to.primaryContainer.fade(),
        onPrimaryContainer = to.onPrimaryContainer.fade(),
        secondary = to.secondary.fade(),
        onSecondary = to.onSecondary.fade(),
        secondaryContainer = to.secondaryContainer.fade(),
        onSecondaryContainer = to.onSecondaryContainer.fade(),
        tertiary = to.tertiary.fade(),
        onTertiary = to.onTertiary.fade(),
        error = to.error.fade(),
        onError = to.onError.fade(),
        background = to.background.fade(),
        onBackground = to.onBackground.fade(),
        surface = to.surface.fade(),
        onSurface = to.onSurface.fade(),
        surfaceVariant = to.surfaceVariant.fade(),
        onSurfaceVariant = to.onSurfaceVariant.fade(),
        surfaceContainerHighest = to.surfaceContainerHighest.fade(),
        surfaceContainerHigh = to.surfaceContainerHigh.fade(),
        surfaceContainer = to.surfaceContainer.fade(),
        surfaceContainerLow = to.surfaceContainerLow.fade(),
        outline = to.outline.fade(),
        outlineVariant = to.outlineVariant.fade(),
        inverseSurface = to.inverseSurface.fade(),
        inverseOnSurface = to.inverseOnSurface.fade(),
        inversePrimary = to.inversePrimary.fade(),
    )
}

private enum class Screen {
    Main,
    SignIn,
    Pair,
}

@Composable
private fun App(
    vm: MainViewModel,
    account: AccountViewModel,
    map: MapViewModel,
    buses: BusesViewModel,
    linkTab: Tab?,
    onLinkTab: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val acct by account.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val store = remember { Store(ctx) }
    var screen by rememberSaveable { mutableStateOf(Screen.Main) }
    var tab by rememberSaveable { mutableStateOf(linkTab ?: Tab.Now) }
    LaunchedEffect(linkTab) {
        if (linkTab != null) {
            tab = linkTab
            onLinkTab()
        }
    }
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
    LaunchedEffect(state.paired) {
        if (state.paired && screen == Screen.Pair) {
            setup = store.needsSetup
            screen = Screen.Main
        }
    }
    LaunchedEffect(state.paired, state.fetchedAt) {
        if (state.paired && store.setupUnknown) account.settleSetup()
    }
    LaunchedEffect(acct.setupDue, state.paired, screen) {
        if (acct.setupDue && state.paired && screen == Screen.Main) {
            setup = true
            account.setupShown()
        }
    }
    if (state.paired && !setup && screen == Screen.Main) {
        Tabs(
            tab,
            { tab = it },
            vm,
            account,
            map,
            buses,
            acct,
            onAddEmail = {
                account.beginSignIn()
                screen = Screen.SignIn
            },
            onSignedOut = signedOut,
        )
    } else if (!state.paired && screen == Screen.Main) {
        WelcomeScreen(
            busy = acct.busy,
            message = acct.message ?: state.pairError,
            onStart = { account.start { signedIn() } },
            onSignIn = {
                account.beginSignIn()
                screen = Screen.SignIn
            },
            onPair = { screen = Screen.Pair },
            onLang = { pref ->
                Lang.set(ctx, pref)
                recreateOn12(ctx)
            },
        )
    } else if (screen == Screen.SignIn) {
        BackHandler {
            account.cancelSignIn()
            screen = Screen.Main
        }
        SignInScreen(
            acct,
            adding = state.paired,
            phase = skyPhase(),
            onSend = { account.sendSignIn(it, signedIn) },
            onCode = { account.enterCode(it, signedIn) },
            onChoose = { keepPhone -> account.choose(keepPhone, signedIn) },
            onDifferentEmail = account::differentEmail,
            onEdit = account::clearMessage,
            onCancel = {
                account.cancelSignIn()
                screen = Screen.Main
            },
        )
    } else
        Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().column().padding(horizontal = 16.dp)) {
            when {
                !state.paired && screen == Screen.Pair -> {
                    BackHandler { screen = Screen.Main }
                    PairScreen(state, vm::pair, onBack = { screen = Screen.Main })
                }
                else ->
                    OnboardingScreen(acct, account, vm) {
                        setup = false
                        vm.load(restart = true)
                    }
            }
        }
    LaunchedEffect(acct.langChanged) {
        if (acct.langChanged) {
            account.langShown()
            recreateOn12(ctx)
        }
    }
    LaunchedEffect(acct.langSaved) {
        if (acct.langSaved > 0) {
            vm.load(restart = true)
            vm.loadDay(restart = true)
        }
    }
    acct.sharedLink?.let { link ->
        if (state.paired && !setup) {
            AlertDialog(
                onDismissRequest = account::dismissShared,
                title = { Text(stringResource(R.string.import_timetable_title)) },
                text = { Text(stringResource(R.string.import_timetable_text)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            account.import(link)
                            tab = Tab.Settings
                        }
                    ) {
                        Text(stringResource(R.string.import_action))
                    }
                },
                dismissButton = { TextButton(onClick = account::dismissShared) { Text(stringResource(R.string.cancel)) } },
            )
        }
    }
    state.pendingPair?.let { p ->
        AlertDialog(
            onDismissRequest = vm::dismissPairLink,
            title = { Text(stringResource(DeviceKind.word(R.string.pair_phone_title))) },
            text = { Text(stringResource(DeviceKind.word(R.string.pair_phone_text), p.account)) },
            confirmButton = { TextButton(onClick = { vm.pair(p.code) }) { Text(stringResource(R.string.pair)) } },
            dismissButton = { TextButton(onClick = vm::dismissPairLink) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

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
    val scope = rememberCoroutineScope()
    val settingsAgain = remember { MutableSharedFlow<Unit>(extraBufferCapacity = 1) }
    val pins = acct.profile?.pinnedStops.orEmpty()
    val pinsKnown = acct.profile != null
    val pinLimit = (acct.profile?.limits ?: sh.rcn.terminus.Limits.DEFAULT).pinnedStops
    val onPin = { code: String ->
        val on = code !in account.state.value.profile?.pinnedStops.orEmpty()
        account.edit { it.pinnedStops = sh.rcn.terminus.Pins.set(it.pinnedStops, code, on, it.limits.pinnedStops) }
    }
    val openStops = { route: BusRoute? ->
        buses.home()
        route?.let(buses::open)
        onTab(Tab.Buses)
    }
    val tabs =
        listOf(
            Triple(Tab.Now, R.string.tab_now, R.drawable.ic_tab_now),
            Triple(Tab.Nearby, R.string.chip_nearby, R.drawable.ic_tab_nearby),
            Triple(Tab.Buses, R.string.tab_buses, R.drawable.ic_tab_buses),
            Triple(Tab.Map, R.string.tab_map, R.drawable.ic_tab_map),
            Triple(Tab.Settings, R.string.settings, R.drawable.ic_tab_settings),
        )
    val choose = { t: Tab ->
        if (t == Tab.Now && tab != Tab.Now) vm.load(restart = true)
        if (t == Tab.Settings && tab == Tab.Settings) settingsAgain.tryEmit(Unit)
        if (t == Tab.Buses && tab == Tab.Buses) buses.home()
        if (t == Tab.Map && tab == Tab.Map) map.home()
        onTab(t)
    }
    val rail = windowWidth().rail
    Scaffold(
        snackbarHost = { SnackbarHost(snackbars) { NoticeBar(it) } },
        bottomBar = {
            if (!rail)
                NavigationBar {
                    for ((t, label, icon) in tabs) {
                        NavigationBarItem(
                            selected = tab == t,
                            onClick = { choose(t) },
                            icon = { Icon(painterResource(icon), contentDescription = null) },
                            label = { Text(stringResource(label)) },
                        )
                    }
                }
        },
    ) { inner ->
        Row(Modifier.fillMaxSize()) {
            if (rail)
                Box {
                    NavigationRail(
                        windowInsets =
                            WindowInsets.systemBars
                                .union(WindowInsets.displayCutout)
                                .only(WindowInsetsSides.Vertical + WindowInsetsSides.Start)
                    ) {
                        for ((t, label, icon) in tabs) {
                            NavigationRailItem(
                                selected = tab == t,
                                onClick = { choose(t) },
                                icon = { Icon(painterResource(icon), contentDescription = null) },
                                label = { Text(stringResource(label)) },
                                modifier = Modifier.padding(vertical = 2.dp),
                            )
                        }
                    }
                    val strip = StatusSky.color
                    val statusTop = WindowInsets.statusBars.getTop(LocalDensity.current).toFloat()
                    if (strip != null) Box(Modifier.matchParentSize().drawBehind { drawRect(strip, size = Size(size.width, statusTop)) })
                }
            Box(
                Modifier.weight(1f)
                    .fillMaxHeight()
                    .then(
                        if (rail)
                            Modifier.windowInsetsPadding(
                                WindowInsets.systemBars.union(WindowInsets.displayCutout).only(WindowInsetsSides.End)
                            )
                        else Modifier
                    )
            ) {
                BackHandler(enabled = tab != Tab.Now) {
                    onTab(Tab.Now)
                    vm.load(restart = true)
                }
                val saved = rememberSaveableStateHolder()
                AnimatedContent(targetState = tab, transitionSpec = { fadeThrough() }, label = "tab") { t ->
                    saved.SaveableStateProvider(t.name) {
                        when (t) {
                            Tab.Map ->
                                Box(Modifier.fillMaxSize().padding(bottom = if (rail) 0.dp else inner.calculateBottomPadding())) {
                                    LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                                    val publicBuses = acct.profile?.publicBuses == true
                                    SideEffect { map.publicBuses = publicBuses }
                                    MapScreen(
                                        map,
                                        onGoThere = { code, name ->
                                            vm.select(Target.Code(code, name))
                                            onTab(Tab.Now)
                                        },
                                        places =
                                            PlacesForMap(
                                                savedAs = { code -> acct.profile?.places?.firstOrNull { it.to == code }?.label },
                                                full = {
                                                    acct.profile.let { p ->
                                                        (p?.places?.size ?: 0) >= (p?.limits ?: sh.rcn.terminus.Limits.DEFAULT).places
                                                    }
                                                },
                                                save = { code, name -> account.edit { it.addPlace(name, code) } },
                                                remove = { code ->
                                                    var removed: RemovedPlace? = null
                                                    account.edit { removed = it.removePlaceAt(code) }
                                                    removed?.let { r ->
                                                        scope.launch {
                                                            val undo =
                                                                snackbars.showSnackbar(
                                                                    Notice(
                                                                        L.s(R.string.favourite_removed, r.label),
                                                                        actionLabel = L.s(R.string.undo),
                                                                    )
                                                                )
                                                            if (undo == SnackbarResult.ActionPerformed) account.edit { it.restorePlace(r) }
                                                        }
                                                    }
                                                },
                                            ),
                                        bottomInset = if (rail) inner.calculateBottomPadding() else 0.dp,
                                        onShowList = { svc, stop ->
                                            openStops(
                                                when {
                                                    stop != null -> BusRoute.Stop(stop)
                                                    svc != null -> BusRoute.Line(svc, null)
                                                    else -> null
                                                }
                                            )
                                        },
                                    )
                                }
                            Tab.Buses ->
                                Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                                    LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                                    BusesScreen(
                                        buses,
                                        insets = inner,
                                        pins = pins,
                                        pinsKnown = pinsKnown,
                                        publicBuses = acct.profile?.publicBuses == true,
                                        pinLimit = pinLimit,
                                        onPin = onPin,
                                        onShowOnMap = { svc ->
                                            map.show(svc)
                                            onTab(Tab.Map)
                                        },
                                    )
                                }
                            Tab.Settings ->
                                Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                                    CompositionLocalProvider(LocalNotices provides snackbars) {
                                        SettingsScreen(
                                            acct,
                                            account,
                                            vm,
                                            inner,
                                            toList = settingsAgain,
                                            onAddEmail = onAddEmail,
                                            onSignedOut = onSignedOut,
                                            onClose = {
                                                onTab(Tab.Now)
                                                vm.load(restart = true)
                                            },
                                        )
                                    }
                                }
                            Tab.Now ->
                                Box(Modifier.fillMaxSize().consumeWindowInsets(inner).imePadding()) {
                                    LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                                    MainScreen(state, vm, insets = inner, email = acct.email, onAddEmail = onAddEmail)
                                }
                            Tab.Nearby ->
                                Box(Modifier.fillMaxSize().consumeWindowInsets(inner)) {
                                    LaunchedEffect(Unit) { if (acct.profile == null) account.refresh() }
                                    NearbyScreen(
                                        state,
                                        vm,
                                        insets = inner,
                                        act =
                                            NearbyActions(
                                                pins,
                                                pinsKnown,
                                                pinLimit,
                                                onPin,
                                                openStop = { openStops(BusRoute.Stop(it)) },
                                                openLine = { svc, stop -> openStops(BusRoute.Line(svc, stop)) },
                                            ),
                                    )
                                }
                        }
                    }
                }
            }
        }
    }
}

private fun fadeThrough(): ContentTransform =
    (fadeIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing)) +
            scaleIn(tween(210, delayMillis = 90, easing = LinearOutSlowInEasing), initialScale = 0.92f))
        .togetherWith(fadeOut(tween(90, easing = FastOutLinearInEasing)))

private fun recreateOn12(ctx: Context) {
    if (android.os.Build.VERSION.SDK_INT < 33) (ctx as? android.app.Activity)?.recreate()
}
