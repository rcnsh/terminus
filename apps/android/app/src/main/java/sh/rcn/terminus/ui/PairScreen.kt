package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.R

/** The site as people type it: terminus.run, or the beta's. */
private val SITE_HOST = BuildConfig.SITE.removePrefix("https://")

private const val CODE_LENGTH = 6

/**
 * Pair with a code from a signed-in phone or the account page. The code is
 * the screen: six split-flap tiles that fill as it's typed, like a departure
 * board settling. Where to find the code sits under it, and Pair at the foot,
 * above the keyboard.
 */
@Composable
internal fun PairScreen(state: UiState, onPair: (String) -> Unit, onBack: () -> Unit) {
    val ctx = LocalContext.current
    var code by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            IconButton(onClick = onBack, modifier = Modifier.padding(top = 4.dp).offset(x = (-12).dp)) {
                Icon(painterResource(R.drawable.ic_back), contentDescription = stringResource(R.string.back))
            }
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
            Text(stringResource(R.string.pair_sub), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
            val label = stringResource(R.string.pairing_code)
            BasicTextField(
                value = code,
                onValueChange = { v ->
                    val clean = v.filter { it.isLetterOrDigit() }.uppercase().take(CODE_LENGTH)
                    // The sixth character, typed or pasted, pairs.
                    val full = clean.length == CODE_LENGTH && code.length < CODE_LENGTH
                    code = clean
                    if (full && !state.pairing) onPair(clean)
                },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { if (code.length == CODE_LENGTH) onPair(code) }),
                modifier = Modifier.fillMaxWidth().padding(top = 28.dp).focusRequester(focus).semantics { contentDescription = label },
                decorationBox = { field ->
                    Box {
                        // The field itself is there for the keyboard and the cursor; the tiles show what's typed.
                        Box(Modifier.alpha(0f)) { field() }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally)) {
                            for (i in 0 until CODE_LENGTH) Flap(code.getOrNull(i), current = i == code.length, Modifier.weight(1f).widthIn(max = 56.dp))
                        }
                    }
                },
            )
            state.pairError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
            Row(Modifier.fillMaxWidth().padding(top = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                WhereCard(R.drawable.ic_shortcut, stringResource(R.string.pair_on_phone), stringResource(R.string.pair_on_phone_how), Modifier.weight(1f))
                WhereCard(R.drawable.ic_open, stringResource(R.string.pair_on_web), stringResource(R.string.pair_on_web_how, SITE_HOST), Modifier.weight(1f)) {
                    ctx.openWeb("${BuildConfig.SITE}/account")
                }
            }
            Hint(stringResource(R.string.pair_scan), Modifier.padding(top = 14.dp))
            Spacer(Modifier.height(16.dp))
        }
        Button(
            onClick = { onPair(code) },
            enabled = code.length == CODE_LENGTH && !state.pairing,
            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp).height(52.dp),
        ) { Text(if (state.pairing) stringResource(R.string.pairing) else stringResource(R.string.pair)) }
    }
}

/** One character of the code on a split-flap tile: dark in light and dark, as the boards are. */
@Composable
private fun Flap(char: Char?, current: Boolean, modifier: Modifier) {
    val shape = RoundedCornerShape(9.dp)
    val edge = if (current) MaterialTheme.colorScheme.primary else Color(0xFF34302B)
    Box(
        modifier
            .aspectRatio(0.72f)
            .background(if (char == null) Brush.verticalGradient(listOf(EMPTY, EMPTY)) else Brush.verticalGradient(0f to FLAP_TOP, 0.49f to FLAP_TOP, 0.49f to SEAM, 0.51f to SEAM, 0.51f to FLAP_BOTTOM), shape)
            .border(if (current) 2.dp else 1.dp, edge, shape),
        contentAlignment = Alignment.Center,
    ) {
        if (char != null) {
            Text(char.toString(), color = Color(0xFFF2EFEB), fontFamily = FontFamily.Monospace, fontWeight = FontWeight.ExtraBold, fontSize = 32.sp)
        } else if (current) {
            Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 14.dp).size(width = 18.dp, height = 3.dp).background(MaterialTheme.colorScheme.primary, RoundedCornerShape(2.dp)))
        }
    }
}

private val FLAP_TOP = Color(0xFF24211E)
private val FLAP_BOTTOM = Color(0xFF1C1A17)
private val SEAM = Color(0xFF0A0908)
private val EMPTY = Color(0xFF151311)

/** Where to find a code: on a phone, or on the web (which opens it). */
@Composable
private fun WhereCard(icon: Int, title: String, how: String, modifier: Modifier, onClick: (() -> Unit)? = null) {
    LinkTile(onClick, modifier) {
        Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 8.dp))
        Text(how, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
    }
}
