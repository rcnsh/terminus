package sh.rcn.terminus.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import sh.rcn.terminus.Store
import sh.rcn.terminus.nusmodsLink
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Target

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()
    private val account: AccountViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreation (rotation, theme change) must not re-apply the link
        // that opened the app and yank the user back to that view.
        if (savedInstanceState == null) handle(intent)
        vm.checkForUpdate(BuildConfig.VERSION_NAME)
        sh.rcn.terminus.Push.register(this)
        setContent { TerminusTheme { App(vm, account) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Widget chips and app shortcuts open the app on the plan, a place or nearby departures. */
    private fun handle(intent: Intent?) {
        // Share in NUSMods, then terminus: the timetable link, to import.
        if (intent?.action == Intent.ACTION_SEND) {
            nusmodsLink(intent.getStringExtra(Intent.EXTRA_TEXT))?.let(account::shared)
            return
        }
        val data = intent?.data ?: return
        // https://terminus.rcn.sh/pair?code=… from the account page's QR code.
        if (data.scheme == "https" && data.path?.startsWith("/pair") == true) {
            val code = data.getQueryParameter("code")?.filter { it.isLetterOrDigit() }?.uppercase()
            if (code != null && code.length == 6 && !vm.state.value.paired) vm.checkPairLink(code)
            return
        }
        if (data.scheme != "terminus") return
        // From a long-press shortcut (the widget's chips send no action): tell
        // the launcher, which ranks the shortcuts people use.
        if (intent.action == Intent.ACTION_VIEW) {
            val id = when (data.host) { "place" -> "place:${data.lastPathSegment}"; "plan" -> "next"; else -> data.host }
            id?.let { androidx.core.content.pm.ShortcutManagerCompat.reportShortcutUsed(this, it) }
        }
        when (data.host) {
            "plan" -> vm.select(Target.Plan)
            "place" -> data.lastPathSegment?.let { vm.select(Target.SavedPlace(it)) }
            "nearby" -> vm.showNearby()
        }
    }

    companion object {
        /** Distinct URIs, so each widget chip gets its own PendingIntent. */
        fun intentFor(ctx: Context, place: String? = null, nearby: Boolean = false): Intent =
            Intent(ctx, MainActivity::class.java).apply {
                data = when {
                    place != null -> "terminus://place/${Uri.encode(place)}".toUri()
                    nearby -> "terminus://nearby".toUri()
                    else -> "terminus://plan".toUri()
                }
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
    }
}

@Composable
private fun TerminusTheme(content: @Composable () -> Unit) {
    // The Surface sets the default text colour to onBackground. Without it,
    // any Text with no explicit colour is black, invisible in dark mode.
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) BrandDark else BrandLight) {
        Surface(color = MaterialTheme.colorScheme.background, content = content)
    }
}

/** Which screen is up, apart from the answer. */
private enum class Screen { Main, Settings, SignIn, Pair }

@Composable
private fun App(vm: MainViewModel, account: AccountViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val acct by account.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val store = remember { Store(ctx) }
    var screen by rememberSaveable { mutableStateOf(Screen.Main) }
    var setup by rememberSaveable { mutableStateOf(store.needsSetup) }
    val signedIn = {
        setup = store.needsSetup
        screen = Screen.Main
        vm.signedIn()
    }
    val signedOut = {
        account.reset()
        setup = false
        screen = Screen.Main
    }
    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 16.dp),
    ) {
        when {
            screen == Screen.SignIn -> {
                BackHandler { account.cancelSignIn(); screen = if (state.paired) Screen.Settings else Screen.Main }
                SignInScreen(
                    acct,
                    adding = state.paired,
                    onSend = { account.sendSignIn(it, signedIn) },
                    onCode = { account.enterCode(it, signedIn) },
                    onChoose = { keepPhone -> account.choose(keepPhone, signedIn) },
                    onCancel = { account.cancelSignIn(); screen = if (state.paired) Screen.Settings else Screen.Main },
                )
            }
            !state.paired && screen == Screen.Pair -> {
                BackHandler { screen = Screen.Main }
                PairScreen(state, vm::pair)
            }
            !state.paired -> WelcomeScreen(
                busy = acct.busy,
                message = acct.message ?: state.pairError,
                onStart = { account.start { store.needsSetup = true; signedIn() } },
                onSignIn = { account.beginSignIn(); screen = Screen.SignIn },
                onPair = { screen = Screen.Pair },
            )
            setup -> OnboardingScreen(acct, account, vm) { setup = false; vm.load(restart = true) }
            screen == Screen.Settings -> SettingsScreen(
                acct, account, vm,
                onAddEmail = { account.beginSignIn(); screen = Screen.SignIn },
                onSignedOut = signedOut,
                onClose = { screen = Screen.Main; vm.load(restart = true) },
            )
            else -> MainScreen(state, vm, onSettings = { screen = Screen.Settings })
        }
    }
    // A timetable shared from NUSMods once set up: import it after a yes.
    acct.sharedLink?.let { link ->
        if (state.paired && !setup) {
            AlertDialog(
                onDismissRequest = account::dismissShared,
                title = { Text("Import this timetable?") },
                text = { Text("It replaces the classes imported before. Classes you added by hand stay.") },
                confirmButton = { TextButton(onClick = { account.import(link); screen = Screen.Settings }) { Text("Import") } },
                dismissButton = { TextButton(onClick = account::dismissShared) { Text("Cancel") } },
            )
        }
    }
    state.pendingPair?.let { p ->
        AlertDialog(
            onDismissRequest = vm::dismissPairLink,
            title = { Text("Pair this phone?") },
            text = { Text("This link pairs this phone with ${p.account}. Only continue if that's your account.") },
            confirmButton = { TextButton(onClick = { vm.pair(p.code) }) { Text("Pair") } },
            dismissButton = { TextButton(onClick = vm::dismissPairLink) { Text("Cancel") } },
        )
    }
}
