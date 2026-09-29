package sh.rcn.terminus.ui

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.R
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Target
import sh.rcn.terminus.widget.clock

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreation (rotation, theme change) must not re-apply the link
        // that opened the app and yank the user back to that view.
        if (savedInstanceState == null) handle(intent)
        vm.checkForUpdate(BuildConfig.VERSION_NAME)
        setContent { NusbusTheme { App(vm) } }
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
                    place != null -> Uri.parse("terminus://place/${Uri.encode(place)}")
                    nearby -> Uri.parse("terminus://nearby")
                    else -> Uri.parse("terminus://plan")
                }
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
    }
}

@Composable
private fun NusbusTheme(content: @Composable () -> Unit) {
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

@Composable
private fun PairScreen(state: UiState, onPair: (String) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Wordmark(MaterialTheme.typography.headlineMedium)
        val ctx = LocalContext.current
        Text("Pair this phone with your account. Sign in at terminus.rcn.sh/account, choose Pair a device, then enter the 6-character code here or scan the QR code with your camera.")
        TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://terminus.rcn.sh/account"))) }) {
            Text("Open terminus.rcn.sh/account")
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

@Composable
private fun MainScreen(state: UiState, vm: MainViewModel) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    // After two refusals Android stops showing the dialog, and the button
    // would do nothing. Then the only way is the app's settings page.
    var blocked by rememberSaveable { mutableStateOf(false) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
        val activity = ctx as? android.app.Activity
        blocked = !hasLocation && activity?.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) == false
        vm.load()
    }
    val openSettings = { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))) }

    // Keep the answer fresh while the app is on screen; the API's own cache
    // is 15 s, so polling faster than that would show nothing new.
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                vm.load()
                delay(30_000)
            }
        }
    }

    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { Wordmark(MaterialTheme.typography.titleLarge) }
            var confirmUnpair by remember { mutableStateOf(false) }
            TextButton(onClick = { confirmUnpair = true }) { Text("Unpair") }
            if (confirmUnpair) {
                AlertDialog(
                    onDismissRequest = { confirmUnpair = false },
                    title = { Text("Unpair this phone?") },
                    text = { Text("The app and widget stop showing your timetable. You can pair again with a new code from the account page.") },
                    confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.unpair() }) { Text("Unpair") } },
                    dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
                )
            }
        }

        state.update?.let { v ->
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("terminus $v is out", modifier = Modifier.weight(1f))
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://terminus.rcn.sh/download/android"))) }) { Text("Update") }
                }
            }
        }

        if (!hasLocation) {
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("Allow location so answers start from the stop you're nearest. Without it, terminus assumes you're where your last class was, or at home.")
                    if (blocked) {
                        TextButton(onClick = openSettings) { Text("Open settings to allow location") }
                    } else {
                        TextButton(onClick = {
                            askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        }) { Text("Allow location") }
                    }
                }
            }
        } else if (!Locator.hasBackground(ctx)) {
            Text(
                "The widget follows your timetable when it refreshes in the background. For it to use your location too, set location to \"Allow all the time\".",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = openSettings) { Text("Open settings") }
        }

        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = !state.showNearby && state.target == Target.Plan, onClick = { vm.select(Target.Plan) }, label = { Text("Next") })
            for (p in state.places) {
                FilterChip(
                    selected = !state.showNearby && state.target == Target.SavedPlace(p.key),
                    onClick = { vm.select(Target.SavedPlace(p.key)) },
                    label = { Text(p.label) },
                )
            }
            (state.target as? Target.Code)?.let { t ->
                FilterChip(selected = !state.showNearby, onClick = { vm.select(t) }, label = { Text(t.label) })
            }
            FilterChip(selected = state.showNearby, onClick = vm::showNearby, label = { Text("Nearby") })
        }
        Spacer(Modifier.height(12.dp))

        // A minimum height keeps the chips and search from jumping as views
        // switch or data arrives.
        Box(Modifier.fillMaxWidth().heightIn(min = 180.dp)) {
            if (state.showNearby) NearbyList(state.nearby, state.loading) else AnswerCard(state.answer, state.loading)
        }

        val footer = listOfNotNull(
            state.error,
            state.fetchedAt?.let { "Updated ${clock(ctx, it)}" },
        ).joinToString(" · ")
        Row(Modifier.padding(top = 8.dp).height(20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(12.dp).semantics { contentDescription = "Refreshing" }, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(footer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(16.dp))
        NotifyToggle(
            "Notify me when to leave for class",
            "A heads-up 5 minutes before you need to set off.",
            state.leaveAlerts, vm::setLeaveAlerts, openSettings,
        )
        NotifyToggle(
            "Live notification during your day",
            "Keeps the next bus and a countdown in your notifications, and the widget up to date. Uses a lot of battery: it checks for new times every 30 seconds while your day is on.",
            state.liveUpdates, vm::setLiveUpdates, openSettings,
        )

        Spacer(Modifier.height(16.dp))
        Search(state, vm)
        Spacer(Modifier.height(24.dp))
    }
}

/** Asks for notification permission on the way to "on", and says so when it's refused. */
@Composable
private fun NotifyToggle(title: String, hint: String, on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refused = !granted
        if (granted) onChange(true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = on,
                role = Role.Switch,
                onValueChange = { want ->
                    when {
                        !want -> onChange(false)
                        LeaveAlerts.canNotify(ctx) -> onChange(true)
                        else -> ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(
                hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
    if (refused && !on) {
        Text("Notifications are off for terminus.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = openSettings) { Text("Open settings") }
    }
}

@Composable
private fun AnswerCard(answer: NextAnswer?, loading: Boolean) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (answer == null) {
                Text(if (loading) "Checking…" else "No answer yet", style = MaterialTheme.typography.titleLarge)
                return@Column
            }
            if (answer.mode == "rest") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_moon), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(answer.label, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                }
                Text(answer.detail)
                Text("No buses until your day starts. Tap a place or Nearby to check one anyway.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                return@Column
            }
            val heading = when {
                answer.mode == "nearby" -> "Nearby"
                answer.why == "gap-home" -> "${answer.destLabel} · long gap"
                else -> answer.destLabel
            }
            if (!answer.isClassPlan) heading?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (answer.arrived) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Text(answer.label, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
                }
                Text(answer.detail)
                return@Column
            }
            if (answer.isClassPlan) {
                ClassPlan(answer)
                return@Column
            }
            val ctx = LocalContext.current
            Text(answer.clockLabel { clock(ctx, it) }, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Countdown(answer)
            Text(answer.detail)
            LeaveLine(answer)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                answer.timingText?.let { Pill(it, timingColor(answer.timingStatus)) }
                crowdWord(answer.crowd)?.let { Pill(it, MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            // The alternative is already at the end of `detail`.
            qualityNote(answer.quality)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    }
}

/**
 * A class: when to leave is the headline, the bus that goes with it and when
 * it gets you there underneath, and the next bus as the "or go now" option.
 * Every arrival sits next to the bus it belongs to.
 */
@Composable
private fun ClassPlan(answer: NextAnswer) {
    val ctx = LocalContext.current
    val at = answer.leaveAtMs ?: return
    val fmt = { ms: Long -> clock(ctx, ms) }
    // Minute resolution is enough for "in 24 min"; seconds near the end.
    val now by produceState(System.currentTimeMillis(), at) {
        while (true) {
            value = System.currentTimeMillis()
            delay(if (at - value < 120_000) 1_000 else 15_000)
        }
    }
    val late = answer.leaveLate
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Text(
        listOfNotNull(answer.destLabel, answer.classAtMs?.let { "starts ${fmt(it)}" }).joinToString(" · "),
        color = muted,
    )
    Text(
        answer.leaveHeadline(now, fmt).orEmpty(),
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
    val left = (at - now) / 1000
    if (left > 0) {
        Text(
            if (left >= 120) "in ${(left + 30) / 60} min" else "in ${left / 60} min ${left % 60} s",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
        )
    }
    answer.catchLine(fmt)?.let {
        Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = if (late) MaterialTheme.colorScheme.error else goodColor())
    }
    answer.leaveNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.tertiary) }
    if (answer.leaveEstimated) {
        Text("Estimated from the usual gap between buses. Live times show nearer the time.", style = MaterialTheme.typography.bodySmall, color = muted)
    }
    answer.goNowLine(fmt)?.let {
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium)
        Countdown(answer)
    }
    Text(answer.detail, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 6.dp))
    qualityNote(answer.quality)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
}

@Composable
private fun goodColor() = if (isSystemInDarkTheme()) GoodDark else GoodLight

/** "Leave by 09:38 · D2 from PGP", turning into "Leave now" when the time comes. */
@Composable
private fun LeaveLine(answer: NextAnswer) {
    val at = answer.leaveAtMs ?: return
    val ctx = LocalContext.current
    val now by produceState(System.currentTimeMillis(), at) {
        while (value < at) {
            delay((at - value).coerceIn(1_000, 30_000))
            value = System.currentTimeMillis()
        }
    }
    answer.leaveText(now) { clock(ctx, it) }?.let {
        Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
    }
}

/** Ticks every second from `departsAt`, so the app never shows an old "4 min". */
@Composable
private fun Countdown(answer: NextAnswer) {
    val at = answer.departsAtMs ?: return
    val now by produceState(System.currentTimeMillis(), at) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val left = (at - now) / 1000
    val text = when {
        left > 60 -> "Leaves in ${left / 60} min ${left % 60} s"
        left > 0 -> "Leaves in $left s"
        else -> "Left ${(-left + 59) / 60} min ago · refreshing"
    }
    Text(text, style = MaterialTheme.typography.titleSmall, color = if (left > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Three states, three colours: "tight" is the one that must not look calm. */
@Composable
private fun timingColor(status: String?) = when (status) {
    "late" -> MaterialTheme.colorScheme.error
    "tight" -> MaterialTheme.colorScheme.tertiary
    else -> goodColor()
}

@Composable
private fun Pill(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = Modifier
            .background(color.copy(alpha = 0.12f), androidx.compose.foundation.shape.RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}


@Composable
private fun NearbyList(stops: List<NearbyStop>?, loading: Boolean) {
    if (stops == null) {
        Text(if (loading) "Checking…" else "Nothing yet")
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (s in stops) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text(if (s.walkS < 60) "here" else "${(s.walkS + 30) / 60} min walk", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!s.available) Text("No live data", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (row in s.board) {
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                            Text(row.svc, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                            Text(eta(row.etaS, row.quality))
                        }
                    }
                }
            }
        }
    }
}

private fun eta(s: Int?, quality: String) = when {
    s == null -> if (quality == "ended") "ended" else "–"
    s < 45 -> "now"
    else -> "${(s + 30) / 60} min"
}

@Composable
private fun Search(state: UiState, vm: MainViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = query,
        onValueChange = {
            query = it
            vm.loadDestinations()
        },
        label = { Text("Go somewhere else") },
        placeholder = { Text("Stop, building or room") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    val q = query.trim()
    if (q.length < 2) return
    val matches = state.destinations
        .filter { it.label.contains(q, ignoreCase = true) || it.code.contains(q, ignoreCase = true) }
        .sortedWith(compareBy({ !it.code.equals(q, ignoreCase = true) }, { it.kind == "room" }, { it.label.length }))
        .take(8)
    Column {
        for (d in matches) {
            Text(
                if (d.label == d.code) d.code else "${d.label} (${d.code})",
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) {
                        query = ""
                        vm.select(Target.Code(d.code, if (d.kind == "stop") d.label else d.code))
                    }
                    .padding(vertical = 12.dp),
            )
            HorizontalDivider()
        }
    }
}
