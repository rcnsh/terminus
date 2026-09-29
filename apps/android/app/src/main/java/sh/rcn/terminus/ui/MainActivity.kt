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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Target

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreation (rotation, theme change) must not re-apply the link
        // that opened the app and yank the user back to that view.
        if (savedInstanceState == null) handle(intent)
        vm.checkForUpdate(BuildConfig.VERSION_NAME)
        setContent { TerminusTheme { App(vm) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Widget chips open the app on a place or on nearby departures. */
    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        // https://terminus.rcn.sh/pair?code=… from the account page's QR code.
        if (data.scheme == "https" && data.path?.startsWith("/pair") == true) {
            val code = data.getQueryParameter("code")?.filter { it.isLetterOrDigit() }?.uppercase()
            if (code != null && code.length == 6 && !vm.state.value.paired) vm.checkPairLink(code)
            return
        }
        if (data.scheme != "terminus") return
        when (data.host) {
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

@Composable
private fun App(vm: MainViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    Column(
        Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 16.dp),
    ) {
        if (!state.paired) PairScreen(state, vm::pair) else MainScreen(state, vm)
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
