package sh.rcn.terminus.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import sh.rcn.terminus.Campus
import sh.rcn.terminus.Clock
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.R
import sh.rcn.terminus.Residence
import sh.rcn.terminus.Stop
import sh.rcn.terminus.Trip
import sh.rcn.terminus.dayShort
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12

private const val STEPS = 4

/**
 * The in-app setup for a new account, one step at a time, the same four
 * things the account page asks: home, timetable, pace, then notifications and
 * location. Each step saves as it goes and can be skipped; so can the lot.
 *
 * Each step shows what its choice does (your stops' signs, your week, a lap
 * of a track at your pace, the alert you'd get), and its buttons stay at the
 * foot of the screen, under the thumb, while the step scrolls above them.
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
        Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            StepLine(step, Modifier.weight(1f))
            TextButton(onClick = finish) { Text(stringResource(R.string.skip_setup)) }
        }
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
        when (step) {
            0 -> HomeStep(profile, state, account, next)
            1 -> TimetableStep(state, account, next, back)
            2 -> PaceStep(profile, state, account, next, back)
            else -> PermissionsStep(state, main, next, back)
        }
    }
}

/**
 * Where you are in setup, drawn as a route: a stop per step, the line done
 * so far in the accent, the stop you're at ringed, and each stop's name under it.
 */
@Composable
private fun StepLine(step: Int, modifier: Modifier = Modifier) {
    val names = listOf(R.string.step_home, R.string.step_classes, R.string.step_pace, R.string.step_alerts)
    val c = MaterialTheme.colorScheme
    val said = stringResource(R.string.step_of, step + 1, STEPS)
    Box(modifier.semantics(mergeDescendants = true) { contentDescription = said }) {
        Canvas(Modifier.matchParentSize()) {
            val cell = size.width / STEPS
            val y = 9.dp.toPx()
            fun x(i: Int) = cell * i + cell / 2
            drawLine(c.outlineVariant, Offset(x(0), y), Offset(x(STEPS - 1), y), 4.dp.toPx(), StrokeCap.Round)
            if (step > 0) drawLine(c.primary, Offset(x(0), y), Offset(x(step), y), 4.dp.toPx(), StrokeCap.Round)
            for (i in 0 until STEPS) {
                val at = Offset(x(i), y)
                when {
                    i < step -> drawCircle(c.primary, 6.dp.toPx(), at)
                    i == step -> {
                        drawCircle(c.background, 8.dp.toPx(), at)
                        drawCircle(c.primary, 6.5.dp.toPx(), at, style = Stroke(5.dp.toPx()))
                    }
                    else -> {
                        drawCircle(c.background, 6.dp.toPx(), at)
                        drawCircle(c.outline, 4.5.dp.toPx(), at, style = Stroke(3.dp.toPx()))
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 24.dp)) {
            names.forEachIndexed { i, name ->
                Text(
                    stringResource(name),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = if (i == step) c.onSurface else c.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

/** A step: what it asks, scrolling, and its buttons pinned under it. */
@Composable
private fun ColumnScope.StepPage(message: String?, buttons: @Composable () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 12.dp)) {
        content()
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
        Spacer(Modifier.height(20.dp))
    }
    buttons()
}

/**
 * Back on the left; the step's one big button filling the rest. With nothing
 * to continue with yet, the big button is the skip, and says so.
 */
@Composable
private fun StepButtons(next: () -> Unit, back: (() -> Unit)?, nextLabel: String? = null, skip: String? = null, enabled: Boolean = true) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (back != null) TextButton(onClick = back) { Text(stringResource(R.string.back)) }
        if (skip != null) {
            OutlinedButton(onClick = next, modifier = Modifier.weight(1f).height(52.dp)) { Text(skip) }
        } else {
            Button(onClick = next, enabled = enabled, modifier = Modifier.weight(1f).height(52.dp)) { Text(nextLabel ?: stringResource(R.string.continue_)) }
        }
    }
}

@Composable
private fun Title(text: String, sub: String) {
    Text(text, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
    Spacer(Modifier.height(6.dp))
    Text(sub, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Spacer(Modifier.height(18.dp))
}

/** Where do you live? A residence brings all its stops; off campus, pick one. */
@Composable
private fun ColumnScope.HomeStep(profile: ProfileDoc, state: AccountState, account: AccountViewModel, next: () -> Unit) {
    // Continue means a home is set; with none yet it's a skip, said as one.
    val home = profile.homeStops.isNotEmpty()
    StepPage(state.message, { StepButtons(next = next, back = null, skip = if (home) null else stringResource(R.string.later)) }) {
        Title(stringResource(R.string.where_live), stringResource(R.string.where_live_sub))
        val campus = state.campus
        if (campus == null) CircularProgressIndicator() else HomePicker(profile, campus, account)
    }
}

/** The walk from a residence to its stop, at an easy pace. */
private fun Residence.walkMin() = maxOf(1, Math.round(walkM / 1.3 / 60).toInt())

/** How many residences show before "All 15 halls and colleges". */
private const val FEW_RESIDENCES = 7
private const val MORE = "more"
private const val OFF = "off"

/**
 * Residences as tiles (the chosen one always among those showing), then
 * off campus. Your stops follow as their signs, with the buses that call
 * there, so the choice shows what it does.
 */
@Composable
internal fun HomePicker(profile: ProfileDoc, campus: Campus, account: AccountViewModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val stops = profile.homeStops
    // The residence whose stops these are, if they're exactly one residence's.
    val residence = campus.residences.firstOrNull { it.stops == stops }
    var offCampus by rememberSaveable { mutableStateOf(stops.isNotEmpty() && residence == null) }
    var all by rememberSaveable { mutableStateOf(false) }
    var locating by remember { mutableStateOf<String?>(null) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant

    val few = campus.residences.size > FEW_RESIDENCES + 1 && !all
    val shown = if (!few) campus.residences else campus.residences.take(FEW_RESIDENCES).let { if (residence != null && residence !in it) it.dropLast(1) + residence else it }
    TwoColumns(shown + listOfNotNull(if (few) MORE else null, OFF)) { cell, mod ->
        when (cell) {
            is Residence -> ChoiceTile(residence == cell && !offCampus, {
                offCampus = false
                account.edit {
                    it.setHomeStops(cell.stops)
                    it.homeWalkMin = cell.walkMin()
                }
            }, mod) {
                Text(cell.name, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(cell.stops.firstOrNull()?.let(campus::stopName), stringResource(R.string.min_walk, cell.walkMin())).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            MORE -> ChoiceTile(false, { all = true }, mod) {
                Text(stringResource(R.string.all_residences, campus.residences.size), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary)
            }
            else -> ChoiceTile(offCampus || (residence == null && stops.isNotEmpty()), { offCampus = true }, mod) {
                Text(stringResource(R.string.off_campus), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
            }
        }
    }
    if (offCampus || (residence == null && stops.isNotEmpty())) {
        Spacer(Modifier.height(16.dp))
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
    if (stops.isNotEmpty()) {
        Label(stringResource(R.string.your_stops_heading), Modifier.padding(top = 22.dp, bottom = 8.dp))
        TwoColumns(stops, gap = 10.dp) { code, mod ->
            val s = campus.stop(code)
            StopSign(s?.name ?: code, mod) {
                ServiceBadges(s?.services.orEmpty(), campus.colors, Modifier.padding(horizontal = 11.dp, vertical = 10.dp))
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 18.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.home_walk), modifier = Modifier.weight(1f))
            OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin - 1 } }, enabled = profile.homeWalkMin > 0, modifier = Modifier.semantics { contentDescription = L.s(R.string.walk_one_less) }) { Text("−") }
            Text(stringResource(R.string.n_min, profile.homeWalkMin), modifier = Modifier.padding(horizontal = 12.dp))
            OutlinedButton(onClick = { account.edit { it.homeWalkMin = profile.homeWalkMin + 1 } }, enabled = profile.homeWalkMin < 30, modifier = Modifier.semantics { contentDescription = L.s(R.string.walk_one_more) }) { Text("+") }
        }
        Hint(stringResource(R.string.home_walk_hint), Modifier.padding(top = 4.dp))
    }
}

internal fun nearestStop(stops: List<Stop>, lat: Double, lon: Double): Stop? = stops.minByOrNull {
    val dLat = it.lat - lat
    val dLon = (it.lon - lon) * Math.cos(Math.toRadians(lat))
    dLat * dLat + dLon * dLon
}

@Composable
private fun ColumnScope.TimetableStep(state: AccountState, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: state.profile?.share.orEmpty()) }
    // Continue imports a link that was pasted but not imported yet, then moves on once it has.
    var waiting by remember { mutableStateOf(false) }
    LaunchedEffect(state.importing, state.imported, waiting) {
        if (waiting && !state.importing) {
            waiting = false
            if (state.imported != null) next()
        }
    }
    val pending = link.isNotBlank() && link.trim() != state.profile?.share
    val classes = state.profile?.let { it.trips + it.manual }.orEmpty()
    StepPage(state.message, {
        StepButtons(
            next = { if (pending) { waiting = true; account.import(link) } else next() },
            back = back,
            // As on the home step: Continue means there's a timetable; with none, it's the skip.
            skip = if (classes.isEmpty() && !pending) stringResource(R.string.later) else null,
            enabled = !state.importing && (pending || classes.isNotEmpty()),
        )
    }) {
        Title(stringResource(R.string.your_timetable), stringResource(R.string.your_timetable_sub))
        TimetableImport(state, account, link) { link = it }
        Week(classes, state.campus)
    }
}

/**
 * The week as imported: each day's classes in order, each beside the stop
 * terminus will take you to, so a wrong one is easy to spot before going on.
 */
@Composable
private fun Week(classes: List<Trip>, campus: Campus?) {
    if (classes.isEmpty()) return
    val h12 = hour12(LocalContext.current)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    // Monday first, as a timetable is read.
    val days = classes.sortedWith(compareBy({ (it.day + 6) % 7 }, { it.arriveByMin })).groupBy { it.day }
    Column(Modifier.padding(top = 18.dp)) {
        for ((day, list) in days) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.padding(vertical = 10.dp)) {
                Text(dayShort(day), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = muted, modifier = Modifier.width(52.dp).padding(top = 2.dp))
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (t in list) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(if (h12) hhmm12(t.arriveByMin) else hhmm(t.arriveByMin), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.width(64.dp))
                            Column(Modifier.weight(1f).padding(end = 8.dp)) {
                                Text(t.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                // The room, unless the name already says it ("MA1521 @ LT27").
                                if (t.venue.isNotEmpty() && t.venue !in t.label) Text(t.venue, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            StopChip(campus?.stopName(t.to) ?: t.to)
                        }
                    }
                }
            }
        }
    }
}

/** A stop's name on a little plate, as on its sign. */
@Composable
internal fun StopChip(name: String) {
    Text(
        name,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.surface,
        maxLines = 1,
        modifier = Modifier.background(MaterialTheme.colorScheme.onSurface, RoundedCornerShape(7.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

/** The share link field, its import, and what the import found. Shared by setup and settings. */
@Composable
internal fun Unplaced(state: AccountState, account: AccountViewModel) {
    if (state.unplaced.isEmpty()) return
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    val n = state.unplaced.size
    Text(
        if (n == 1) stringResource(R.string.unplaced_one) else stringResource(R.string.unplaced_n, n),
        color = MaterialTheme.colorScheme.error,
        modifier = Modifier.padding(top = 8.dp),
    )
    for (u in state.unplaced) {
        Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val off = if (u.offCampus) stringResource(R.string.off_campus_paren) else ""
                Text("${dayShort(u.day)} ${if (h12) hhmm12(u.arriveByMin) else hhmm(u.arriveByMin)} · ${u.module} @ ${u.venue}$off", Modifier.weight(1f))
                TextButton(onClick = { account.skip(u) }) { Text(stringResource(R.string.skip)) }
            }
            WherePicker(stringResource(R.string.choose_stop), state.campus?.destinations.orEmpty(), null) { d ->
                if (d != null) account.place(u, if (d.kind == "landmark") d.code else d.stopCode)
            }
        }
    }
}

/** Import from NUSMods: the link, Import, and what came of it. Shared by setup and Settings. */
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
        Unplaced(state, account)
        if (r.missing.isNotEmpty()) Hint(stringResource(R.string.nusmods_missing, r.missing.joinToString(", ")))
    } else {
        val n = state.profile?.trips?.size ?: 0
        if (n > 0) Hint(if (n == 1) stringResource(R.string.one_imported) else stringResource(R.string.n_imported, n), Modifier.padding(top = 8.dp))
    }
}

@Composable
private fun ColumnScope.PaceStep(profile: ProfileDoc, state: AccountState, account: AccountViewModel, next: () -> Unit, back: () -> Unit) {
    StepPage(state.message, { StepButtons(next = next, back = back) }) {
        Title(stringResource(R.string.get_around), stringResource(R.string.get_around_sub))
        PacePicker(profile, account)
        Spacer(Modifier.height(20.dp))
        ClockSwitch(profile, account)
    }
}

/** Each pace, and how long a lap of a 400 m track takes at it. */
private val PACES = listOf(
    Triple("slow", R.string.pace_slow, 6),
    Triple("normal", R.string.pace_normal, 5),
    Triple("fast", R.string.pace_fast, 4),
)

/**
 * The pace as a lap of a running track (400 m, something people have walked
 * round), with the chosen pace's time in the middle; then the three paces;
 * then "allow for busy buses", with the trade it makes drawn under it.
 */
@Composable
private fun PacePicker(profile: ProfileDoc, account: AccountViewModel) {
    val lap = PACES.firstOrNull { it.first == profile.walkPace }?.third ?: 5
    Track(lap)
    Text(stringResource(R.string.pace_lap), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
    Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        for ((value, title, min) in PACES) {
            ChoiceTile(profile.walkPace == value, { account.edit { it.walkPace = value } }, Modifier.weight(1f)) {
                Text(stringResource(title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                Text(stringResource(R.string.pace_lap_min, min), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    BusyBuses(profile, account)
}

/** A running track, from above: the lap's time at your pace in the infield. */
@Composable
private fun Track(lapMin: Int) {
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val infield = if (dark) Color(0xFF1E3A26) else Color(0xFFCFE5C3)
    val onInfield = if (dark) Color(0xFFBBF7D0) else Color(0xFF14532D)
    val accent = MaterialTheme.colorScheme.primary
    Box(Modifier.fillMaxWidth().height(150.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.matchParentSize()) {
            val r = size.height / 2
            val lane = 15.dp.toPx()
            drawRoundRect(TRACK, cornerRadius = CornerRadius(r))
            drawRoundRect(Color.White.copy(alpha = 0.45f), Offset(lane / 2, lane / 2), Size(size.width - lane, size.height - lane), CornerRadius(r - lane / 2), style = Stroke(1.dp.toPx()))
            drawRoundRect(infield, Offset(lane, lane), Size(size.width - 2 * lane, size.height - 2 * lane), CornerRadius(r - lane))
            // The finish line, and you on the far bend.
            drawLine(Color.White, Offset(size.width / 2, 0f), Offset(size.width / 2, lane), 3.dp.toPx())
            // On the middle of the lane, part way round the far bend.
            val bend = Math.toRadians(-50.0)
            val you = Offset(size.width - r + (r - lane / 2) * Math.cos(bend).toFloat(), r + (r - lane / 2) * Math.sin(bend).toFloat())
            drawCircle(Color.White, 9.dp.toPx(), you)
            drawCircle(accent, 6.dp.toPx(), you)
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.n_min, lapMin), fontSize = 40.sp, fontWeight = FontWeight.ExtraBold, color = onInfield, letterSpacing = (-1).sp)
            Text(stringResource(R.string.pace_lap_yours), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = onInfield)
        }
    }
}

/** A running track's own red, the same in light and dark. */
private val TRACK = Color(0xFFB4533A)

/** "Allow for busy buses", with an example of what it does: the earlier R2 instead of the packed one. */
@Composable
private fun BusyBuses(profile: ProfileDoc, account: AccountViewModel) {
    val c = MaterialTheme.colorScheme
    val h12 = hour12(LocalContext.current)
    val at = { min: Int -> if (h12) hhmm12(min) else hhmm(min) }
    val shape = RoundedCornerShape(18.dp)
    Column(Modifier.padding(top = 14.dp).fillMaxWidth().clip(shape).border(1.dp, c.outlineVariant, shape).padding(horizontal = 14.dp, vertical = 6.dp)) {
        SwitchRow(stringResource(R.string.packed), stringResource(R.string.packed_hint), profile.fullBusMargin) { on -> account.edit { it.fullBusMargin = on } }
        if (profile.fullBusMargin) {
            Row(Modifier.padding(bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    Modifier.background(c.primaryContainer, RoundedCornerShape(10.dp)).border(2.dp, c.primary, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    BusBadge("R2", 0xFF34A853, 12.sp)
                    Text(at(9 * 60 + 38), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                }
                Text(stringResource(R.string.packed_instead), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                Row(
                    Modifier.background(c.surfaceVariant, RoundedCornerShape(10.dp)).padding(horizontal = 8.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    BusBadge("R2", 0xFF34A853, 12.sp)
                    Text("${at(9 * 60 + 46)} · ${stringResource(R.string.packed_word)}", style = MaterialTheme.typography.labelLarge, color = c.onSurfaceVariant, textDecoration = TextDecoration.LineThrough, maxLines = 1)
                }
            }
        }
    }
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

/**
 * 12- or 24-hour, as two halves of one switch, each an example time. The
 * phone's own style shows picked until another is (Settings has "follow the phone").
 */
@Composable
private fun ClockSwitch(profile: ProfileDoc, account: AccountViewModel) {
    val ctx = LocalContext.current
    val c = MaterialTheme.colorScheme
    val shown = if (profile.clock != Clock.AUTO) profile.clock else if (hour12(ctx)) Clock.H12 else Clock.H24
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.show_times_as), fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        Row(Modifier.background(c.surfaceVariant, RoundedCornerShape(12.dp)).padding(3.dp)) {
            for ((value, example) in listOf(Clock.H12 to stringResource(R.string.clock_12_eg), Clock.H24 to "18:36")) {
                val on = shown == value
                Text(
                    example,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = if (on) c.onSurface else c.onSurfaceVariant,
                    modifier = Modifier
                        .clip(RoundedCornerShape(9.dp))
                        .background(if (on) c.surface else Color.Transparent)
                        .selectable(on, role = Role.RadioButton) { account.setClock(value) }
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                )
            }
        }
    }
}

/**
 * Notifications and location, each showing what it gives before asking: the
 * leave-by alert itself, and your dot finding its nearest stop.
 */
@Composable
private fun ColumnScope.PermissionsStep(state: AccountState, main: MainViewModel, next: () -> Unit, back: () -> Unit) {
    val ctx = LocalContext.current
    val mainState by main.state.collectAsStateWithLifecycle()
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
    }
    val askNotify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) main.setLeaveAlerts(true)
    }
    StepPage(state.message, { StepButtons(next = next, back = back, nextLabel = stringResource(R.string.start_using)) }) {
        Title(stringResource(R.string.two_things), stringResource(R.string.two_things_sub))
        PermissionCard(
            preview = { AlertPreview() },
            title = stringResource(R.string.alerts_title),
            text = stringResource(R.string.notifications_text),
            done = mainState.leaveAlerts,
            doneText = stringResource(R.string.on_),
            ask = stringResource(R.string.turn_on_alerts),
        ) {
            if (LeaveAlerts.canNotify(ctx)) main.setLeaveAlerts(true)
            else @Suppress("InlinedApi") askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        Spacer(Modifier.height(12.dp))
        PermissionCard(
            preview = { LocationPreview() },
            title = stringResource(R.string.location_title),
            text = stringResource(R.string.location_text),
            done = hasLocation,
            doneText = stringResource(R.string.allowed),
            ask = stringResource(R.string.allow_location),
        ) { askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) }
    }
}

@Composable
private fun PermissionCard(preview: @Composable () -> Unit, title: String, text: String, done: Boolean, doneText: String, ask: String, onAsk: () -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(20.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.surface).border(1.dp, c.outlineVariant, shape)) {
        preview()
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(text, style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            if (done) {
                Text("✓ $doneText", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.Bold, color = goodColor(), modifier = Modifier.padding(top = 10.dp))
            } else {
                OutlinedButton(onClick = onAsk, modifier = Modifier.fillMaxWidth().padding(top = 10.dp)) { Text(ask) }
            }
        }
    }
}

/** The leave-by alert, as it shows on the phone: an example class. */
@Composable
private fun AlertPreview() {
    val c = MaterialTheme.colorScheme
    val h12 = hour12(LocalContext.current)
    Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp).fillMaxWidth().background(c.surfaceVariant, RoundedCornerShape(18.dp)).padding(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            BrandMark(Modifier.size(16.dp))
            Text("${stringResource(R.string.app_name)} · ${stringResource(R.string.journey_now)}", style = MaterialTheme.typography.labelMedium, color = c.onSurfaceVariant)
        }
        Text(stringResource(R.string.alert_preview_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 6.dp))
        Text(stringResource(R.string.alert_preview_text, if (h12) hhmm12(9 * 60 + 42) else hhmm(9 * 60 + 42)), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
    }
}

/** A few roads, a route line, a stop, and you: a dashed walk from your dot to the stop. */
@Composable
private fun LocationPreview() {
    val c = MaterialTheme.colorScheme
    Canvas(Modifier.fillMaxWidth().height(110.dp).background(c.surfaceVariant)) {
        val w = size.width
        val h = size.height
        val road = c.outlineVariant
        drawPath(Path().apply { moveTo(-10f, h * 0.62f); cubicTo(w * 0.25f, h * 0.5f, w * 0.45f, h * 0.85f, w * 0.65f, h * 0.65f); cubicTo(w * 0.8f, h * 0.5f, w * 0.9f, h * 0.4f, w + 10, h * 0.45f) }, road, style = Stroke(12.dp.toPx()))
        drawPath(Path().apply { moveTo(w * 0.33f, -10f); cubicTo(w * 0.36f, h * 0.35f, w * 0.3f, h * 0.7f, w * 0.42f, h + 10) }, road, style = Stroke(10.dp.toPx()))
        drawPath(Path().apply { moveTo(-10f, h * 0.82f); cubicTo(w * 0.25f, h * 0.7f, w * 0.45f, h * 1.02f, w * 0.65f, h * 0.82f); cubicTo(w * 0.8f, h * 0.68f, w * 0.9f, h * 0.6f, w + 10, h * 0.64f) }, Color(0xFF2B9AD6), style = Stroke(4.dp.toPx(), cap = StrokeCap.Round))
        val stop = Offset(w * 0.6f, h * 0.84f)
        val you = Offset(w * 0.47f, h * 0.36f)
        drawLine(c.primary, you, stop, 2.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx())))
        drawCircle(Color.White, 6.dp.toPx(), stop)
        drawCircle(c.onSurface, 6.dp.toPx(), stop, style = Stroke(2.dp.toPx()))
        drawCircle(Color(0xFF3B82F6).copy(alpha = 0.18f), 22.dp.toPx(), you)
        drawCircle(Color.White, 9.dp.toPx(), you)
        drawCircle(Color(0xFF3B82F6), 6.5.dp.toPx(), you)
    }
}
