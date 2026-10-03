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
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription

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
            Text(stringResource(R.string.step_of, step + 1, STEPS), style = MaterialTheme.typography.labelLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = finish) { Text(stringResource(R.string.skip_setup)) }
        }
        LinearProgressIndicator(progress = { (step + 1f) / STEPS }, modifier = Modifier.fillMaxWidth())
        Spacer(Modifier.height(16.dp))
        val profile = state.profile
        if (profile == null) {
            Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                if (state.message == null) CircularProgressIndicator() else Text(state.message, color = MaterialTheme.colorScheme.error)
            }
            if (state.message != null) Button(onClick = account::refresh) { Text(stringResource(R.string.try_again)) }
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
private fun StepActions(next: () -> Unit, back: (() -> Unit)?, nextLabel: String? = null, skip: String? = null, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth().padding(top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
        if (back != null) TextButton(onClick = back) { Text(stringResource(R.string.back)) }
        Spacer(Modifier.weight(1f))
        if (skip != null) TextButton(onClick = next) { Text(skip) }
        Button(onClick = next, enabled = enabled) { Text(nextLabel ?: stringResource(R.string.continue_)) }
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
    Title(stringResource(R.string.where_live), stringResource(R.string.where_live_sub))
    if (campus == null) {
        CircularProgressIndicator()
        return
    }
    HomePicker(profile, campus, account)
    // Continue means a home is set; with none yet it's a skip, said as one.
    val home = profile.homeStops.isNotEmpty()
    StepActions(next = next, back = null, skip = if (home) null else stringResource(R.string.later), enabled = home)
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
        label = stringResource(R.string.where_live),
        options = campus.residences.map { it.code to it.name },
        selected = residence?.code,
        blank = stringResource(R.string.off_campus),
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
        Hint(stringResource(R.string.residence_stops, residence.name, residence.stops.joinToString(", ") { campus.stopName(it) }), Modifier.padding(top = 4.dp))
    }
    if (offCampus || residence == null) {
        Spacer(Modifier.height(12.dp))
        Choice(
            label = stringResource(R.string.home_stop),
            options = campus.stops.map { it.code to it.name },
            selected = stops.firstOrNull(),
            blank = stringResource(R.string.choose_stop),
            onSelect = { code -> account.edit { it.setHomeStops(listOfNotNull(code) + stops.drop(1).filter { s -> s != code }) } },
        )
        if (Locator.hasForeground(ctx)) {
            TextButton(onClick = {
                locating = L.s(R.string.finding_stop)
                scope.launch {
                    val loc = Locator.lastKnown(ctx, maxAgeMs = 120_000) ?: Locator.current(ctx)
                    val near = loc?.let { l -> nearestStop(campus.stops, l.latitude, l.longitude) }
                    if (near == null) {
                        locating = L.s(R.string.no_location)
                    } else {
                        account.edit { it.setHomeStops(listOf(near.code) + stops.filter { s -> s != near.code }) }
                        locating = L.s(R.string.picked_stop, near.name)
                    }
                }
            }) { Text(stringResource(R.string.pick_nearest)) }
        }
        locating?.let { Hint(it) }
    }
    Spacer(Modifier.height(12.dp))
    Text(stringResource(R.string.home_walk))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin - 1 } }, enabled = profile.homeWalkMin > 0, modifier = Modifier.semantics { contentDescription = L.s(R.string.walk_one_less) }) { Text("−") }
        Text(stringResource(R.string.n_min, profile.homeWalkMin), modifier = Modifier.padding(horizontal = 16.dp))
        OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin + 1 } }, enabled = profile.homeWalkMin < 30, modifier = Modifier.semantics { contentDescription = L.s(R.string.walk_one_more) }) { Text("+") }
    }
    Hint(stringResource(R.string.home_walk_hint))
}

private fun nearestStop(stops: List<Stop>, lat: Double, lon: Double): Stop? = stops.minByOrNull {
    val dLat = it.lat - lat
    val dLon = (it.lon - lon) * Math.cos(Math.toRadians(lat))
    dLat * dLat + dLon * dLon
}

@Composable
private fun TimetableStep(state: AccountState, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    Title(stringResource(R.string.your_timetable), stringResource(R.string.your_timetable_sub))
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
        skip = if (state.profile?.trips.isNullOrEmpty() && !pending) stringResource(R.string.later) else null,
        enabled = !state.importing && (pending || !state.profile?.trips.isNullOrEmpty()),
    )
}

/** The share link field, its import, and what the import found. Shared by setup and settings. */
@Composable
internal fun TimetableImport(state: AccountState, account: AccountViewModel, link: String, onLink: (String) -> Unit) {
    OutlinedTextField(
        value = link,
        onValueChange = onLink,
        label = { Text(stringResource(R.string.nusmods_link)) },
        placeholder = { Text("https://nusmods.com/timetable/sem-1/share?…") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Hint(stringResource(R.string.nusmods_hint), Modifier.padding(top = 4.dp))
    Button(onClick = { account.import(link) }, enabled = link.isNotBlank() && !state.importing, modifier = Modifier.padding(top = 8.dp)) {
        Text(if (state.importing) stringResource(R.string.importing) else stringResource(R.string.import_action))
    }
    val r = state.imported
    if (r != null) {
        Text(if (r.classes == 1) stringResource(R.string.imported_one, r.term) else stringResource(R.string.imported_n, r.classes, r.term), modifier = Modifier.padding(top = 8.dp))
        if (r.unresolved.isNotEmpty()) {
            Hint(stringResource(R.string.no_stop_for, r.unresolved.joinToString("; ")))
        }
        if (r.missing.isNotEmpty()) Hint(stringResource(R.string.nusmods_missing, r.missing.joinToString(", ")))
    } else {
        val n = state.profile?.trips?.size ?: 0
        if (n > 0) Hint(if (n == 1) stringResource(R.string.one_imported) else stringResource(R.string.n_imported, n), Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun PaceStep(profile: ProfileDoc, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    Title(stringResource(R.string.get_around), stringResource(R.string.get_around_sub))
    PacePicker(profile, account)
    StepActions(next = next, back = back)
}

private val PACES = listOf(
    Triple("slow", R.string.pace_slow, R.string.pace_slow_hint),
    Triple("normal", R.string.pace_normal, R.string.pace_normal_hint),
    Triple("fast", R.string.pace_fast, R.string.pace_fast_hint),
)

/** Three cards, one chosen, and "allow for busy buses". Shared by setup and settings. */
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
                    Text(stringResource(title), style = MaterialTheme.typography.titleSmall)
                    Hint(stringResource(hint))
                }
            }
        }
    }
    Spacer(Modifier.height(12.dp))
    SwitchRow(
        stringResource(R.string.packed),
        stringResource(R.string.packed_hint),
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
    Title(stringResource(R.string.two_things), stringResource(R.string.two_things_sub))

    Text(stringResource(R.string.notifications), style = MaterialTheme.typography.titleMedium)
    Text(stringResource(R.string.notifications_text))
    if (mainState.leaveAlerts) {
        Hint(stringResource(R.string.on_), Modifier.padding(top = 4.dp))
    } else {
        OutlinedButton(
            onClick = {
                if (LeaveAlerts.canNotify(ctx)) main.setLeaveAlerts(true)
                else @Suppress("InlinedApi") askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
            },
            modifier = Modifier.padding(top = 4.dp),
        ) { Text(stringResource(R.string.turn_on_alerts)) }
    }

    Spacer(Modifier.height(20.dp))
    Text(stringResource(R.string.location), style = MaterialTheme.typography.titleMedium)
    Text(stringResource(R.string.location_text))
    if (hasLocation) {
        Hint(stringResource(R.string.allowed), Modifier.padding(top = 4.dp))
    } else {
        OutlinedButton(
            onClick = { askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
            modifier = Modifier.padding(top = 4.dp),
        ) { Text(stringResource(R.string.allow_location)) }
    }
    StepActions(next = next, back = back, nextLabel = stringResource(R.string.done))
}
