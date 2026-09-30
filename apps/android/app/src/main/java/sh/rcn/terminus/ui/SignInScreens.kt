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

/** First launch: start straight away, or sign in to an account you already have. */
@Composable
internal fun WelcomeScreen(busy: Boolean, message: String?, onStart: () -> Unit, onSignIn: () -> Unit, onPair: () -> Unit) {
    val ctx = LocalContext.current
    Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Wordmark(MaterialTheme.typography.headlineMedium)
        Text("When to leave for class, not just when the bus comes.", style = MaterialTheme.typography.titleMedium)
        Text("Setting up takes about a minute: where you live, your NUSMods timetable, and how fast you walk. No account or email needed.")
        Spacer(Modifier.height(8.dp))
        Button(onClick = onStart, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) "Starting…" else "Get started")
        }
        OutlinedButton(onClick = onSignIn, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
            Text("I have an account: sign in")
        }
        TextButton(onClick = onPair, modifier = Modifier.align(Alignment.CenterHorizontally)) { Text("Pair with a code instead") }
        message?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Spacer(Modifier.height(8.dp))
        TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "https://terminus.rcn.sh/privacy".toUri())) }) {
            Text("Privacy: what's kept, and for how long")
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
    Text(if (adding) "Add your email" else "Sign in", style = MaterialTheme.typography.headlineSmall)
    Text(
        if (adding) {
            "Keeps your setup if you lose this phone, and lets you use it on your Mac or the web. Nothing else changes."
        } else {
            "Use the email you signed up with. We'll email you a code to type here."
        },
    )
    OutlinedTextField(
        value = email,
        onValueChange = { email = it },
        label = { Text("Email") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { if (ok && !busy) onSend(email) }),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { onSend(email) }, enabled = ok && !busy, modifier = Modifier.fillMaxWidth()) {
        Text(if (busy) "Sending…" else "Email me a code")
    }
    TextButton(onClick = onCancel) { Text("Cancel") }
}

@Composable
private fun Waiting(s: SignIn.Waiting, busy: Boolean, onCode: (String) -> Unit, onCancel: () -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Text("Check your email", style = MaterialTheme.typography.headlineSmall)
    Text("We sent a code to ${s.email}. Type it here:")
    OutlinedTextField(
        value = code,
        onValueChange = { v -> code = v.filter { it.isLetterOrDigit() }.uppercase().take(6) },
        label = { Text("Code from the email") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (code.length == 6 && !busy) onCode(code) }),
        textStyle = MaterialTheme.typography.headlineSmall.copy(letterSpacing = 4.sp),
        modifier = Modifier.fillMaxWidth(),
    )
    Button(onClick = { onCode(code) }, enabled = code.length == 6 && !busy, modifier = Modifier.fillMaxWidth()) {
        Text(if (busy) "Checking…" else "Sign in")
    }
    Spacer(Modifier.height(8.dp))
    Hint("Reading your email on another device? Open the link in it, and when it asks, choose:")
    Text(
        s.match.toString(),
        style = MaterialTheme.typography.displayMedium.copy(fontWeight = FontWeight.Bold),
        color = MaterialTheme.colorScheme.primary,
        textAlign = TextAlign.Center,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = "The number to choose: ${s.match}" },
    )
    Hint("This phone signs in by itself once you do. No email after a minute? Check spam. It works for 15 minutes.")
    TextButton(onClick = onCancel) { Text("Cancel") }
}

@Composable
private fun Choose(s: SignIn.Choose, busy: Boolean, onChoose: (Boolean) -> Unit) {
    Text("Which setup?", style = MaterialTheme.typography.headlineSmall)
    Text("${s.email} already has a timetable and settings, and so does this phone. Keep one:")
    Button(onClick = { onChoose(false) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text("Keep my account's setup")
    }
    OutlinedButton(onClick = { onChoose(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
        Text("Replace it with this phone's")
    }
    Hint("Replacing changes it on every device signed in to ${s.email}.")
}
