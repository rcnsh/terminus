package sh.rcn.terminus.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sh.rcn.terminus.Campus
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.Stop

private const val STEPS = 4

/**
 * The in-app setup for a new account, one step at a time, the same four
 * things the account page asks: home, timetable, pace, then notifications and
 * location. Each step saves as it goes and can be skipped; so can the lot.
 */
@Composable
internal fun OnboardingScreen(state: AccountState, account: AccountViewModel, main: MainViewModel, onDone: () -> Unit) {
    var step by rememberSaveable { mutableIntStateOf(0) }
    LaunchedEffect(Unit) { account.refresh() }
    val finish = {
        account.finishSetup()
        onDone()
    }
    // A link shared from NUSMods goes straight to the timetable step.
    LaunchedEffect(state.sharedLink) { if (state.sharedLink != null && step == 0) step = 1 }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Step ${step + 1} of $STEPS", style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = finish) { Text("Skip setup") }
        }
        LinearProgressIndicator(progress = { (step + 1f) / STEPS }, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))
        val profile = state.profile
        if (profile == null) {
            Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                if (state.message == null) CircularProgressIndicator() else Text(state.message, color = MaterialTheme.colorScheme.error)
            }
            if (state.message != null) Button(onClick = account::refresh) { Text("Try again") }
            return@Column
        }
        val next: () -> Unit = { if (step + 1 >= STEPS) finish() else step++ }
        val back: () -> Unit = { if (step > 0) step-- }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            when (step) {
                0 -> HomeStep(profile, state.campus, account, next)
                1 -> TimetableStep(state, account, next, back)
                2 -> PaceStep(profile, account, next, back)
                else -> PermissionsStep(main, next, back)
            }
            state.message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun StepActions(next: () -> Unit, back: (() -> Unit)?, nextLabel: String = "Continue", skip: String? = null, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth().padding(top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        if (back != null) TextButton(onClick = back) { Text("Back") }
        Spacer(Modifier.weight(1f))
        if (skip != null) TextButton(onClick = next) { Text(skip) }
        Button(onClick = next, enabled = enabled) { Text(nextLabel) }
    }
}

@Composable
private fun Title(text: String, sub: String) {
    Text(text, style = MaterialTheme.typography.headlineSmall)
    Spacer(Modifier.height(4.dp))
    Text(sub, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(16.dp))
}

/** Where do you live? A residence brings all its stops; off campus, pick one. */
@Composable
internal fun HomeStep(profile: ProfileDoc, campus: Campus?, account: AccountViewModel, next: () -> Unit) {
    Title("Where do you live?", "Where you catch the bus in the morning and head back to at night. Only the stops are saved, never where you live.")
    if (campus == null) {
        CircularProgressIndicator()
        return
    }
    HomePicker(profile, campus, account)
    // Continue means a home is set; with none yet it's a skip, said as one.
    val home = profile.homeStops.isNotEmpty()
    StepActions(next = next, back = null, skip = if (home) null else "I'll do this later", enabled = home)
}

/** Residence or stop, and the walk to it. Shared by setup and settings; saves on each change. */
@Composable
internal fun HomePicker(profile: ProfileDoc, campus: Campus, account: AccountViewModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val stops = profile.homeStops
    // The residence whose stops these are, if they're exactly one residence's.
    val residence = campus.residences.firstOrNull { it.stops == stops }
    var offCampus by rememberSaveable { mutableStateOf(stops.isNotEmpty() && residence == null) }
    var locating by remember { mutableStateOf<String?>(null) }

    Choice(
        label = "Where do you live?",
        options = campus.residences.map { it.code to it.name },
        selected = residence?.code,
        blank = "Off campus, or I'll pick a stop",
        onSelect = { code ->
            val r = campus.residences.firstOrNull { it.code == code }
            offCampus = r == null
            if (r != null) {
                account.edit {
                    it.setHomeStops(r.stops)
                    it.homeWalkMin = maxOf(1, Math.round(r.walkM / 1.3 / 60).toInt())
                }
            }
        },
    )
    if (residence != null) {
        Hint("Stops for ${residence.name}: ${residence.stops.joinToString(", ") { campus.stopName(it) }}. terminus won't send you home when you're already there.", Modifier.padding(top = 4.dp))
    }
    if (offCampus || residence == null) {
        Spacer(Modifier.height(12.dp))
        Choice(
            label = "Home stop",
            options = campus.stops.map { it.code to it.name },
            selected = stops.firstOrNull(),
            blank = "Choose a stop",
            onSelect = { code -> account.edit { it.setHomeStops(listOfNotNull(code) + stops.drop(1).filter { s -> s != code }) } },
        )
        if (Locator.hasForeground(ctx)) {
            TextButton(onClick = {
                locating = "Finding the nearest stop…"
                scope.launch {
                    val loc = Locator.lastKnown(ctx, maxAgeMs = 120_000) ?: Locator.current(ctx)
                    val near = loc?.let { l -> nearestStop(campus.stops, l.latitude, l.longitude) }
                    if (near == null) {
                        locating = "Couldn't get your location. Pick your stop instead."
                    } else {
                        account.edit { it.setHomeStops(listOf(near.code) + stops.filter { s -> s != near.code }) }
                        locating = "Picked ${near.name}. Change it if you use a different stop."
                    }
                }
            }) { Text("Pick the stop nearest me") }
        }
        locating?.let { Hint(it) }
    }
    Spacer(Modifier.height(12.dp))
    Text("Walk from home to your stop")
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin - 1 } }, enabled = profile.homeWalkMin > 0) { Text("−") }
        Text("${profile.homeWalkMin} min", modifier = Modifier.padding(horizontal = 16.dp))
        OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin + 1 } }, enabled = profile.homeWalkMin < 30) { Text("+") }
    }
    Hint("Counted in your leave-by time when terminus doesn't have your location.")
}

private fun nearestStop(stops: List<Stop>, lat: Double, lon: Double): Stop? = stops.minByOrNull {
    val dLat = it.lat - lat
    val dLon = (it.lon - lon) * Math.cos(Math.toRadians(lat))
    dLat * dLat + dLon * dLon
}

@Composable
private fun TimetableStep(state: AccountState, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    Title("Your timetable", "Paste your NUSMods share link. Each class goes to the stop nearest its room.")
    var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: state.profile?.share.orEmpty()) }
    TimetableImport(state, account, link) { link = it }
    // Continue imports a link that was pasted but not imported yet, then moves on once it has.
    var waiting by remember { mutableStateOf(false) }
    LaunchedEffect(state.importing, state.imported, waiting) {
        if (waiting && !state.importing) {
            waiting = false
            if (state.imported != null) next()
        }
    }
    val pending = link.isNotBlank() && link.trim() != state.profile?.share
    StepActions(
        next = { if (pending) { waiting = true; account.import(link) } else next() },
        back = back,
        // As on the home step: Continue means there's a timetable; with none, it's the skip.
        skip = if (state.profile?.trips.isNullOrEmpty() && !pending) "I'll do this later" else null,
        enabled = !state.importing && (pending || !state.profile?.trips.isNullOrEmpty()),
    )
}

/** The share link field, its import, and what the import found. Shared by setup and settings. */
@Composable
internal fun TimetableImport(state: AccountState, account: AccountViewModel, link: String, onLink: (String) -> Unit) {
    OutlinedTextField(
        value = link,
        onValueChange = onLink,
        label = { Text("NUSMods share link") },
        placeholder = { Text("https://nusmods.com/timetable/sem-1/share?…") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Hint("In NUSMods: Timetable, then Share/Sync. Tap Share and choose terminus, or copy the link and paste it here.", Modifier.padding(top = 4.dp))
    Button(onClick = { account.import(link) }, enabled = link.isNotBlank() && !state.importing, modifier = Modifier.padding(top = 8.dp)) {
        Text(if (state.importing) "Importing…" else "Import")
    }
    val r = state.imported
    if (r != null) {
        Text("Imported ${r.classes} class${if (r.classes == 1) "" else "es"} for ${r.term}.", modifier = Modifier.padding(top = 8.dp))
        if (r.unresolved.isNotEmpty()) {
            Hint("No stop found for ${r.unresolved.joinToString("; ")}. Add those by hand in Settings, under Timetable.")
        }
        if (r.missing.isNotEmpty()) Hint("NUSMods has no classes this semester for ${r.missing.joinToString(", ")}.")
    } else {
        val n = state.profile?.trips?.size ?: 0
        if (n > 0) Hint(if (n == 1) "1 class imported." else "$n classes imported.", Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun PaceStep(profile: ProfileDoc, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    Title("How you get around", "Walks follow the real paths on campus. Your pace sets how long they take.")
    PacePicker(profile, account)
    StepActions(next = next, back = back)
}

private val PACES = listOf(
    Triple("slow", "Slow", "400 m in about 6 min. Unhurried, or you often have a bag to carry."),
    Triple("normal", "Normal", "400 m in about 5 min. Most people."),
    Triple("fast", "Fast", "400 m in about 4 min. You're the one overtaking."),
)

/** Three cards, one chosen, and "allow for packed buses". Shared by setup and settings. */
@Composable
internal fun PacePicker(profile: ProfileDoc, account: AccountViewModel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, title, hint) in PACES) {
            val on = profile.walkPace == value
            Card(
                colors = CardDefaults.cardColors(containerColor = if (on) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface),
                border = BorderStroke(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
                modifier = Modifier.fillMaxWidth().selectable(selected = on, role = Role.RadioButton) { account.edit { it.walkPace = value } },
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(title, style = MaterialTheme.typography.titleSmall)
                    Hint(hint)
                }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    SwitchRow(
        "Allow for packed buses",
        "When the bus you'd wait for is often full at that stop and time, aim one bus earlier.",
        profile.fullBusMargin,
    ) { on -> account.edit { it.fullBusMargin = on } }
}

@Composable
internal fun SwitchRow(title: String, hint: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(value = on, role = Role.Switch, onValueChange = onChange).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Hint(hint)
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
}

/** Notifications and location, each with what it's for, each skippable. */
@Composable
private fun PermissionsStep(main: MainViewModel, next: () -> Unit, back: () -> Unit) {
    val ctx = LocalContext.current
    val mainState by main.state.collectAsStateWithLifecycle()
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
    }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) main.setLeaveAlerts(true)
    }
    Title("Two last things", "Both are optional. You can change them later in Settings.")

    Text("Notifications", style = MaterialTheme.typography.titleMedium)
    Text("A heads-up 5 minutes before you need to leave for class, so you don't have to keep checking.")
    if (mainState.leaveAlerts) {
        Hint("On.", Modifier.padding(top = 4.dp))
    } else {
        OutlinedButton(
            onClick = {
                if (LeaveAlerts.canNotify(ctx)) main.setLeaveAlerts(true)
                else @Suppress("InlinedApi") askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
            },
            modifier = Modifier.padding(top = 4.dp),
        ) { Text("Turn on leave-by alerts") }
    }

    Spacer(Modifier.height(20.dp))
    Text("Location", style = MaterialTheme.typography.titleMedium)
    Text("So answers start from the stop you're nearest. It's used for that answer only, rounded to about 11 m, and never saved. Without it, terminus assumes you're where your last class was, or at home.")
    if (hasLocation) {
        Hint("Allowed.", Modifier.padding(top = 4.dp))
    } else {
        OutlinedButton(
            onClick = { askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
            modifier = Modifier.padding(top = 4.dp),
        ) { Text("Allow location") }
    }
    StepActions(next = next, back = back, nextLabel = "Done")
}
