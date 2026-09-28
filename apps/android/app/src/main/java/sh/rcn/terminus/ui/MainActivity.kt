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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
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
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.Locator
import sh.rcn.terminus.R
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Target
import sh.rcn.terminus.widget.clock
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
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
            if (code != null && code.length == 6 && !vm.state.value.paired) vm.pair(code)
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
    val ctx = LocalContext.current
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)
    MaterialTheme(colorScheme = scheme, content = content)
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
}

@Composable
private fun PairScreen(state: UiState, onPair: (String) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxWidth().padding(top = 48.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("terminus", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Pair this phone with your account. On terminus.rcn.sh/account, tap \"Get a pairing code\" and type it here.")
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
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
        vm.load()
    }

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
            Text("terminus", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            TextButton(onClick = vm::unpair) { Text("Unpair") }
        }

        if (!hasLocation) {
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("Allow location so answers start from the stop you're nearest, not from your timetable's guess.")
                    TextButton(onClick = {
                        askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                    }) { Text("Allow location") }
                }
            }
        } else if (!Locator.hasBackground(ctx)) {
            Text(
                "The widget follows your timetable when it refreshes in the background. For it to use your location too, set location to \"Allow all the time\".",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = {
                ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)))
            }) { Text("Open settings") }
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
            state.fetchedAt?.let { "Updated ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it))}" },
        ).joinToString(" · ")
        Row(Modifier.padding(top = 8.dp).height(20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(footer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(24.dp))
        Search(state, vm)
        Spacer(Modifier.height(24.dp))
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
            heading?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Text(answer.clockLabel(::clock), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Countdown(answer)
            Text(answer.detail)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                answer.timingText?.let { Pill(it, if (answer.timingStatus == "late") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
                answer.crowd?.let { Pill("${it.replaceFirstChar { c -> c.uppercase() }} crowd", MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            // The alternative is already at the end of `detail`.
            qualityNote(answer.quality)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
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

private fun qualityNote(q: String) = when (q) {
    "scheduled" -> "Estimated from the timetable, no live bus seen"
    "stale" -> "Live data is a few minutes old"
    "unknown" -> "Couldn't reach the NUS bus feed"
    else -> null
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
                    .clickable {
                        query = ""
                        vm.select(Target.Code(d.code, if (d.kind == "stop") d.label else d.code))
                    }
                    .padding(vertical = 12.dp),
            )
            HorizontalDivider()
        }
    }
}
