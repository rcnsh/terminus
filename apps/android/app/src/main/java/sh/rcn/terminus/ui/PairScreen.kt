package sh.rcn.terminus.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import sh.rcn.terminus.BuildConfig

/** The site as people type it: terminus.rcn.sh, or the beta's. */
private val SITE_HOST = BuildConfig.SITE.removePrefix("https://")

@Composable
internal fun PairScreen(state: UiState, onPair: (String) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Wordmark(MaterialTheme.typography.headlineMedium)
        val ctx = LocalContext.current
        Text("Pair this phone with your account. On a phone that's signed in, go to Settings, then Add a device; or on ${SITE_HOST}/account, choose Pair a device. Then enter the 6-character code here, or scan the QR code with your camera.")
        TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }) {
            Text("Open ${SITE_HOST}/account")
        }
        OutlinedTextField(
            value = code,
            onValueChange = { v -> code = v.filter { it.isLetterOrDigit() }.uppercase().take(6) },
            label = { Text("Pairing code") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { if (code.length == 6) onPair(code) }),
            textStyle = MaterialTheme.typography.headlineSmall.copy(letterSpacing = 4.sp),
            modifier = Modifier.fillMaxWidth(),
        )
        state.pairError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(onClick = { onPair(code) }, enabled = code.length == 6 && !state.pairing, modifier = Modifier.fillMaxWidth()) {
            Text(if (state.pairing) "Pairing…" else "Pair")
        }
    }
}
