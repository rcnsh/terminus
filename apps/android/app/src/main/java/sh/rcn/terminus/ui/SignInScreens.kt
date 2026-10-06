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
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.net.toUri
import sh.rcn.terminus.BuildConfig
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.Lang
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path

/**
 * First launch: start straight away, or sign in to an account you already
 * have. A bus's livery sweeps across the top, a stripe in each service's
 * colour, with the mark where the fleet number would be. It runs edge to
 * edge, so this screen keeps the insets itself instead of the host's padding.
 */
@Composable
internal fun WelcomeScreen(busy: Boolean, message: String?, onStart: () -> Unit, onSignIn: () -> Unit, onPair: () -> Unit, onLang: (String) -> Unit) {
    val ctx = LocalContext.current
    val bg = MaterialTheme.colorScheme.background
    BoxWithConstraints(Modifier.fillMaxSize().safeDrawingPadding()) {
        // The livery grows with the screen, so a tall phone isn't left with a gap.
        val livery = (maxHeight * 0.4f).coerceIn(240.dp, 360.dp)
        // At least the screen's height, so the buttons sit at the bottom
        // under the thumb, and scrolls when large text needs more.
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).heightIn(min = maxHeight),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.End) { LanguageSwitch(onLang) }
            Box(Modifier.fillMaxWidth().height(livery)) {
                Livery(Modifier.matchParentSize())
                Box(Modifier.align(Alignment.BottomCenter).background(bg, RoundedCornerShape(30.dp)).padding(6.dp)) {
                    BrandMark(Modifier.size(92.dp).shadow(16.dp, RoundedCornerShape(24.dp)))
                }
            }
            Box(Modifier.padding(top = 16.dp)) { Wordmark(MaterialTheme.typography.displaySmall.copy(fontSize = 46.sp, letterSpacing = (-1).sp)) }
            Text(
                stringResource(R.string.tagline),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(horizontal = 40.dp, vertical = 8.dp),
            )
            Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LIVERY.forEach { (svc, color) -> BusBadge(svc, color, 13.sp, pad = 7.dp) }
            }
            Spacer(Modifier.height(32.dp))
            Spacer(Modifier.weight(1f))
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 12.dp)) }
                Button(onClick = onStart, enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text(if (busy) stringResource(R.string.starting) else stringResource(R.string.get_started))
                }
                Text(
                    stringResource(R.string.welcome_caption),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                OutlinedButton(onClick = onSignIn, enabled = !busy, modifier = Modifier.fillMaxWidth().height(52.dp)) {
                    Text(stringResource(R.string.have_account))
                }
                Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onPair) { Text(stringResource(R.string.pair_instead)) }
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/privacy".toUri())) }) {
                        Text(stringResource(R.string.privacy), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

/**
 * The services as NUS paints them, for the livery. The API's ROUTE_COLORS
 * (campus.ts) is the source, and every other screen takes the colours from
 * /campus; this one shows before there's an account to ask with.
 */
private val LIVERY = listOf(
    "A1" to 0xFFE53935, "A2" to 0xFFD9A000, "D1" to 0xFFEC4FA0, "D2" to 0xFF8E44C9,
    "K" to 0xFF2B9AD6, "R1" to 0xFFF57C1F, "R2" to 0xFF34A853, "P" to 0xFF8A939C,
)

/**
 * The stripes down a bus's side, rising to the right: one per service (P's
 * grey would dull it), then a gap and a thin line in the accent. They're
 * sized by the height they're given, and the rise is capped so a tablet's
 * wide screen gets a flatter band, not a steeper cut.
 */
@Composable
private fun Livery(modifier: Modifier) {
    val accent = MaterialTheme.colorScheme.primary
    Canvas(modifier.clipToBounds()) {
        val rise = minOf(size.width * 0.25f, 110.dp.toPx())
        val unit = size.height / 300f
        // The band's lower edge, a fifth of the way up in the middle: the mark sits on it.
        val left = size.height - 60 * unit + rise / 2
        val right = left - rise
        // A strip between two heights above the lower edge. Each overlaps the
        // next by a pixel, so no hairline of background shows between them.
        fun strip(from: Float, to: Float, color: Color) = drawPath(
            Path().apply {
                moveTo(0f, left - from); lineTo(size.width, right - from)
                lineTo(size.width, right - to - 1f); lineTo(0f, left - to - 1f); close()
            },
            color,
        )
        strip(0f, 6 * unit, accent)
        val stripe = 20 * unit
        var at = 16 * unit
        LIVERY.filter { it.first != "P" }.asReversed().forEach { (_, color) ->
            strip(at, at + stripe, Color(color))
            at += stripe
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
