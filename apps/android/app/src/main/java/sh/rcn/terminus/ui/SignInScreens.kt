package sh.rcn.terminus.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import sh.rcn.terminus.BuildConfig
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.Lang
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row

/** First launch: start straight away, or sign in to an account you already have. */
@Composable
internal fun WelcomeScreen(busy: Boolean, message: String?, onStart: () -> Unit, onSignIn: () -> Unit, onPair: () -> Unit, onLang: (String) -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { Wordmark(MaterialTheme.typography.headlineMedium) }
            LanguageSwitch(onLang)
        }
        Text(stringResource(R.string.tagline), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.welcome_text))
        Spacer(Modifier.height(8.dp))
        Button(onClick = onStart, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) stringResource(R.string.starting) else stringResource(R.string.get_started))
        }
        OutlinedButton(onClick = onSignIn, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.have_account))
        }
        TextButton(onClick = onPair, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text(stringResource(R.string.pair_instead)) }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/privacy".toUri())) }) {
            Text(stringResource(R.string.privacy_link))
        }
    }
}

/**
 * Sign in by email, approved from the email on any device: type the address,
 * then choose the number shown here on the page the email links to.
 */
@Composable
internal fun SignInScreen(state: AccountState, adding: Boolean, onSend: (String) -> Unit, onCode: (String) -> Unit, onChoose: (Boolean) -> Unit, onCancel: () -> Unit) {
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when (val s = state.signIn) {
            is SignIn.Waiting -> Waiting(s, state.busy, onCode, onCancel)
            is SignIn.Choose -> Choose(s, state.busy, onChoose)
            else -> EmailStep(adding, state.busy, onSend, onCancel)
        }
        state.message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

@Composable
private fun EmailStep(adding: Boolean, busy: Boolean, onSend: (String) -> Unit, onCancel: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    val ok = Regex("^[^@\\s]+@[^@\\s]+\\.[a-zA-Z]{2,}$").matches(email.trim())
    Text(if (adding) stringResource(R.string.add_email) else stringResource(R.string.sign_in), style = MaterialTheme.typography.headlineSmall)
    Text(
        if (adding) {
            stringResource(R.string.add_email_why)
        } else {
            stringResource(R.string.sign_in_why)
        },
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text(stringResource(R.string.email)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (ok && !busy) onSend(email) }),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { onSend(email) }, enabled = ok && !busy, modifier = Modifier.fillMaxWidth()) {
        Text(if (busy) stringResource(R.string.sending) else stringResource(R.string.email_me_code))
    }
    TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
}

@Composable
private fun Waiting(s: SignIn.Waiting, busy: Boolean, onCode: (String) -> Unit, onCancel: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Text(stringResource(R.string.check_email), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.sent_code_to, s.email))
    OutlinedTextField(
        value = code,
        onValueChange = { v ->
            val clean = v.filter { it.isLetterOrDigit() }.uppercase().take(6)
            // The sixth character, typed or pasted, sends it.
            val full = clean.length == 6 && code.length < 6
            code = clean
            if (full && !busy) onCode(clean)
        },
        label = { Text(stringResource(R.string.code_from_email)) },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (code.length == 6 && !busy) onCode(code) }),
        textStyle = MaterialTheme.typography.headlineSmall.copy(letterSpacing = 4.sp),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { onCode(code) }, enabled = code.length == 6 && !busy, modifier = Modifier.fillMaxWidth()) {
        Text(if (busy) stringResource(R.string.checking) else stringResource(R.string.sign_in))
    }
    Spacer(Modifier.height(8.dp))
    Hint(stringResource(R.string.other_device_hint))
    val numberLabel = stringResource(R.string.number_to_choose, s.match.toString())
    Text(
        s.match.toString(),
        style = MaterialTheme.typography.displayMedium.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.primary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = numberLabel },
    )
    Hint(stringResource(R.string.code_wait_hint))
    TextButton(onClick = onCancel) { Text(stringResource(R.string.cancel)) }
}

@Composable
private fun Choose(s: SignIn.Choose, busy: Boolean, onChoose: (Boolean) -> Unit) {
    Text(stringResource(R.string.which_setup), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.which_setup_text, s.email))
    Button(onClick = { onChoose(false) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.keep_account))
    }
    OutlinedButton(onClick = { onChoose(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text(stringResource(R.string.replace_with_phone))
    }
    Hint(stringResource(R.string.replace_hint, s.email))
}

/** "English · 中文" on the first screen, before there's an account to keep it in. */
@Composable
private fun LanguageSwitch(onLang: (String) -> Unit) {
    val zh = Lang.current(LocalContext.current) == Lang.ZH
    Row {
        TextButton(onClick = { onLang(Lang.EN) }, enabled = zh) { Text("English") }
        TextButton(onClick = { onLang(Lang.ZH) }, enabled = !zh) { Text("中文") }
    }
}
