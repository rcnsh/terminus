package sh.rcn.terminus.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.intl.LocaleList
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.coerceIn
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.CODE_LENGTH
import sh.rcn.terminus.Lang
import sh.rcn.terminus.R
import sh.rcn.terminus.codeEdit

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
                // Said as soon as it shows: it's why nothing happened.
                message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 12.dp).semantics { liveRegion = LiveRegionMode.Assertive }) }
                Button(onClick = onStart, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text(if (busy) stringResource(R.string.starting) else stringResource(R.string.get_started))
                }
                Text(
                    stringResource(R.string.welcome_caption),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
                OutlinedButton(onClick = onSignIn, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp)) {
                    Text(stringResource(R.string.have_account))
                }
                Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onPair) { Text(stringResource(R.string.pair_instead)) }
                    TextButton(onClick = { ctx.openWeb("${BuildConfig.SITE}/privacy") }) {
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
internal val LIVERY = listOf(
    "A1" to 0xFFD32F2F, "A2" to 0xFFD9A000, "D1" to 0xFFEC4FA0, "D2" to 0xFF8E44C9,
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
 * then the code from the email, or choose the number shown here on the page
 * the email links to. As Settings' pages: the title in a band of the sky
 * ([phase]), with a back arrow that cancels, then the plain page.
 */
@Composable
internal fun SignInScreen(
    state: AccountState,
    adding: Boolean,
    phase: Phase,
    onSend: (String) -> Unit,
    onCode: (String) -> Unit,
    onChoose: (Boolean) -> Unit,
    onDifferentEmail: () -> Unit,
    onEdit: () -> Unit,
    onCancel: () -> Unit,
) {
    val s = state.signIn
    val title = when (s) {
        is SignIn.Waiting -> R.string.check_email
        is SignIn.Choose -> R.string.which_setup
        else -> if (adding) R.string.add_email else R.string.sign_in
    }
    // Edge to edge, so the band reaches the top; the keyboard pushes the page up.
    Column(Modifier.fillMaxSize().imePadding()) {
        SkyBand(phase, WindowInsets.statusBars.asPaddingValues().calculateTopPadding()) {
            BackHeader(stringResource(title), onCancel)
        }
        Column(
            Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom))
                .padding(horizontal = 16.dp),
        ) {
            Groups {
                when (s) {
                    // Editing what went wrong takes its message away ([onEdit]).
                    is SignIn.Waiting -> Waiting(s, state.busy, state.message, onCode, onDifferentEmail, onEdit)
                    is SignIn.Choose -> Choose(s, state.busy, state.message, onChoose)
                    else -> EmailStep(adding, state.busy, state.message, onSend, onEdit)
                }
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

/** The main button, across the page, and what went wrong under it. */
@Composable
private fun Action(text: String, enabled: Boolean, message: String?, onClick: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        InkButton(text, onClick, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = enabled)
        message?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 4.dp).semantics { liveRegion = LiveRegionMode.Assertive }) }
    }
}

/** A simple local@domain.tld: enough to catch a typo before anything is sent. */
internal fun looksLikeEmail(s: String) = Regex("^[^@\\s]+@[^@\\s]+\\.[a-zA-Z]{2,}$").matches(s.trim())

@Composable
private fun EmailStep(adding: Boolean, busy: Boolean, message: String?, onSend: (String) -> Unit, onEdit: () -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    val ok = looksLikeEmail(email)
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Group(stringResource(R.string.your_email), stringResource(if (adding) R.string.add_email_why else R.string.sign_in_why)) {
        OutlinedTextField(
            value = email,
            onValueChange = {
                if (it != email && message != null) onEdit()
                email = it
            },
            // A label, so the field keeps its name once something's typed.
            label = { Text(stringResource(R.string.email_label)) },
            placeholder = { Text(stringResource(R.string.email_example)) },
            isError = message != null,
            singleLine = true,
            shape = RoundedCornerShape(12.dp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { if (ok && !busy) onSend(email) }),
            modifier = Modifier.fillMaxWidth().padding(12.dp).focusRequester(focus).semantics { if (message != null) error(message) },
        )
    }
    Action(stringResource(if (busy) R.string.sending else R.string.email_me_code), ok && !busy, message) { onSend(email) }
}

@Composable
private fun ColumnScope.Waiting(s: SignIn.Waiting, busy: Boolean, message: String?, onCode: (String) -> Unit, onDifferentEmail: () -> Unit, onEdit: () -> Unit) {
    var field by rememberSaveable(stateSaver = TextFieldValue.Saver) { mutableStateOf(TextFieldValue()) }
    val code = field.text
    Group(stringResource(R.string.code_from_email), stringResource(R.string.code_sent_hint, s.email)) {
        CodeBoxes(
            field,
            onChange = { next ->
                // The sixth character, typed or pasted, sends it.
                val full = next.text.length == CODE_LENGTH && code.length < CODE_LENGTH
                if (next.text != code && message != null) onEdit()
                field = next
                if (full && !busy) onCode(next.text)
            },
            onDone = { if (code.length == CODE_LENGTH && !busy) onCode(code) },
            modifier = Modifier.padding(12.dp),
        )
    }
    Action(stringResource(if (busy) R.string.checking else R.string.sign_in), code.length == CODE_LENGTH && !busy, message) { onCode(code) }
    // Or approve it from the email on another device, by the number shown here.
    Group(stringResource(R.string.other_device_title)) {
        FieldRow(stringResource(R.string.other_device_row), sub = stringResource(R.string.signs_in_itself)) {
            val numberLabel = stringResource(R.string.number_to_choose, s.match.toString())
            Box(
                Modifier
                    .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(14.dp))
                    .heightIn(min = 52.dp)
                    .widthIn(min = 64.dp)
                    .padding(horizontal = 12.dp)
                    .semantics { contentDescription = numberLabel },
                contentAlignment = Alignment.Center,
            ) {
                Text(s.match.toString(), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            }
        }
    }
    TextButton(
        onClick = onDifferentEmail,
        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
        modifier = Modifier.align(Alignment.CenterHorizontally),
    ) { Text(stringResource(R.string.different_email)) }
}

/**
 * The code from the email in six boxes. One text field takes the keys,
 * pastes and deletes, drawn as the boxes: each character typed fills the
 * next box, a pasted code spreads over all six ([codeEdit]), and the box
 * that's next is outlined in the ink.
 */
@Composable
private fun CodeBoxes(field: TextFieldValue, onChange: (TextFieldValue) -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    val focus = remember { FocusRequester() }
    var focused by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val label = stringResource(R.string.code_from_email)
    BasicTextField(
        value = field,
        onValueChange = { v ->
            val code = codeEdit(field.text, v.text)
            // Kept as typed while the keyboard's text is already clean, so it isn't
            // interrupted mid-word; otherwise the cleaned code. The cursor stays at the end.
            onChange(if (code == v.text) v.copy(selection = TextRange(code.length)) else TextFieldValue(code, TextRange(code.length)))
        },
        singleLine = true,
        textStyle = TextStyle(color = Color.Transparent),
        cursorBrush = SolidColor(Color.Transparent),
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.Characters,
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Ascii,
            imeAction = ImeAction.Done,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone() }),
        modifier = modifier.fillMaxWidth().focusRequester(focus).onFocusChanged { focused = it.isFocused }.semantics { contentDescription = label },
        decorationBox = { inner ->
            Box {
                // The field itself, unseen behind the boxes: it's what long-press Paste reaches.
                Box(Modifier.matchParentSize()) { inner() }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (i in 0 until CODE_LENGTH) {
                        val next = focused && i == minOf(field.text.length, CODE_LENGTH - 1)
                        Box(
                            Modifier
                                .weight(1f)
                                .height(52.dp)
                                .background(c.background, RoundedCornerShape(12.dp))
                                .border(if (next) 2.dp else 1.5.dp, if (next) c.onSurface else c.outlineVariant, RoundedCornerShape(12.dp)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(field.text.getOrNull(i)?.toString().orEmpty(), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun Choose(s: SignIn.Choose, busy: Boolean, message: String?, onChoose: (Boolean) -> Unit) {
    Text(stringResource(R.string.which_setup_text, s.email), modifier = Modifier.padding(horizontal = 4.dp))
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Action(stringResource(R.string.keep_account), !busy, message) { onChoose(false) }
        OutlinedButton(onClick = { onChoose(true) }, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.replace_with_phone))
        }
        Hint(stringResource(R.string.replace_hint, s.email), Modifier.padding(horizontal = 4.dp))
    }
}

/**
 * "English · 中文" on the first screen, before there's an account to keep it
 * in. The one in use is the selected one, in the ink; each name is marked
 * as its own language, so a screen reader says it in that voice.
 */
@Composable
private fun LanguageSwitch(onLang: (String) -> Unit) {
    val zh = Lang.current(LocalContext.current) == Lang.ZH
    Row(Modifier.selectableGroup()) {
        for ((lang, name, tag) in listOf(Triple(Lang.EN, "English", "en"), Triple(Lang.ZH, "中文", "zh-Hans"))) {
            val on = (lang == Lang.ZH) == zh
            TextButton(
                onClick = { if (!on) onLang(lang) },
                colors = ButtonDefaults.textButtonColors(contentColor = if (on) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary),
                modifier = Modifier.semantics { selected = on },
            ) {
                Text(AnnotatedString(name, SpanStyle(localeList = LocaleList(tag))), fontWeight = if (on) FontWeight.SemiBold else null)
            }
        }
    }
}
