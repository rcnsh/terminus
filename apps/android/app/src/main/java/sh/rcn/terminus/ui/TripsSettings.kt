package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.rcn.terminus.Campus
import sh.rcn.terminus.L
import sh.rcn.terminus.Locator
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.R

/**
 * Settings › Your trips: where you live, your day's hours and how you walk,
 * as three short groups of one-line rows, each group with one line of
 * explanation under it. The same groups as the web and the Mac. Setup
 * (Onboarding.kt) asks the same things with more words.
 */
@Composable
internal fun TripsSettings(profile: ProfileDoc, state: AccountState, account: AccountViewModel) {
    Groups {
        state.campus?.let { HomeGroup(profile, it, account) }
        DayGroup(profile, account)
        WalkingGroup(profile, account)
        TripChoices(state, account)
        TripHistory(state, account)
    }
}

/** − value +, for small steps: round buttons either side, as on the web. */
@Composable
private fun Stepper(text: String, less: String, more: String, canLess: Boolean, canMore: Boolean, onLess: () -> Unit, onMore: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        StepButton("−", less, canLess, onLess)
        Text(text, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, modifier = Modifier.widthIn(min = 64.dp))
        StepButton("+", more, canMore, onMore)
    }
}

@Composable
private fun StepButton(sign: String, says: String, enabled: Boolean, onClick: () -> Unit) {
    FilledTonalIconButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.size(36.dp).semantics { contentDescription = says },
        colors = IconButtonDefaults.filledTonalIconButtonColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHighest, contentColor = MaterialTheme.colorScheme.onSurface),
    ) { Text(sign, style = MaterialTheme.typography.titleMedium) }
}

@Composable
private fun HomeGroup(profile: ProfileDoc, campus: Campus, account: AccountViewModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val stops = profile.homeStops
    val residence = campus.residences.firstOrNull { it.stops == stops }
    // "Off campus" can be chosen while the stops are a residence's: it stays chosen until the stops change.
    var offCampus by rememberSaveable(stops) { mutableStateOf(false) }
    var locating by remember { mutableStateOf<String?>(null) }
    val picking = offCampus || residence == null

    Group(stringResource(R.string.where_you_live), stringResource(R.string.only_stops_saved)) {
        ValueRow(
            label = stringResource(R.string.residence),
            options = campus.residences.map { it.code to it.name },
            selected = if (picking) null else residence.code,
            sub = if (picking) null else stringResource(R.string.your_stops, residence.stops.joinToString(", ") { campus.stopName(it) }),
            blank = stringResource(R.string.off_campus_short),
            headings = residenceHeadings(campus.residences),
            onSelect = { code ->
                val r = campus.residences.firstOrNull { it.code == code }
                if (r == null) {
                    offCampus = true
                } else {
                    account.edit {
                        it.setHomeStops(r.stops)
                        it.homeWalkMin = maxOf(1, Math.round(r.walkM / 1.3 / 60).toInt())
                    }
                }
            },
        )
        if (picking) {
            RowDivider()
            ValueRow(
                label = stringResource(R.string.your_stop),
                options = campus.stops.map { it.code to it.name },
                selected = stops.firstOrNull(),
                blank = stringResource(R.string.choose_stop),
                onSelect = { code -> account.edit { it.setHomeStops(listOfNotNull(code) + stops.drop(1).filter { s -> s != code }) } },
            )
            Column(Modifier.padding(horizontal = 4.dp)) {
                if (Locator.hasForeground(ctx)) {
                    TextButton(onClick = {
                        locating = L.s(R.string.finding_stop)
                        scope.launch { locating = pickNearestHome(ctx, campus, stops, account) }
                    }) { Text(stringResource(R.string.pick_nearest)) }
                }
                locating?.let { Hint(it, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 10.dp)) }
            }
        }
        RowDivider()
        FieldRow(stringResource(R.string.walk_to_stop)) {
            Stepper(
                stringResource(R.string.n_min, profile.homeWalkMin),
                L.s(R.string.walk_one_less), L.s(R.string.walk_one_more),
                profile.homeWalkMin > 0, profile.homeWalkMin < 30,
                { account.edit { it.homeWalkMin = it.homeWalkMin - 1 } },
                { account.edit { it.homeWalkMin = it.homeWalkMin + 1 } },
            )
        }
    }
}

@Composable
private fun DayGroup(profile: ProfileDoc, account: AccountViewModel) {
    Group(stringResource(R.string.heading_your_day), stringResource(R.string.day_hint_short)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(stringResource(R.string.show_buses_between), style = MaterialTheme.typography.bodyLarge)
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                TimeButton("", profile.dayStartMin, { m -> if (m < profile.dayEndMin) account.edit { it.dayStartMin = m } }, Modifier.weight(1f))
                Text(stringResource(R.string.and))
                TimeButton("", profile.dayEndMin, { m -> if (m > profile.dayStartMin) account.edit { it.dayEndMin = m } }, Modifier.weight(1f))
            }
        }
        RowDivider()
        FieldRow(stringResource(R.string.gap_home)) {
            val h = profile.gapHours
            Stepper(
                if (h == 1.0) stringResource(R.string.one_hour) else stringResource(R.string.n_hours, if (h % 1.0 == 0.0) h.toInt().toString() else h.toString()),
                L.s(R.string.gap_shorter), L.s(R.string.gap_longer),
                h > 0.5, h < 12,
                { account.edit { it.gapHours = it.gapHours - 0.5 } },
                { account.edit { it.gapHours = it.gapHours + 0.5 } },
            )
        }
    }
}

private val PACES = listOf(
    Triple("slow", R.string.pace_slow, R.string.pace_slow_hint),
    Triple("normal", R.string.pace_normal, R.string.pace_normal_hint),
    Triple("fast", R.string.pace_fast, R.string.pace_fast_hint),
)

@Composable
private fun WalkingGroup(profile: ProfileDoc, account: AccountViewModel) {
    val pace = PACES.firstOrNull { it.first == profile.walkPace } ?: PACES[1]
    Group(stringResource(R.string.heading_walking), stringResource(R.string.walks_follow_paths)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Text(stringResource(R.string.walking_pace), style = MaterialTheme.typography.bodyLarge)
            Hint(stringResource(pace.third))
            Pills(PACES.map { (value, title, _) -> value to stringResource(title) }, pace.first, { value -> account.edit { it.walkPace = value } }, Modifier.padding(top = 10.dp))
        }
        RowDivider()
        FieldRow(
            stringResource(R.string.packed),
            Modifier.toggleable(value = profile.fullBusMargin, role = Role.Switch) { on -> account.edit { it.fullBusMargin = on } },
            sub = stringResource(R.string.busy_hint_short),
        ) { Switch(checked = profile.fullBusMargin, onCheckedChange = null) }
        RowDivider()
        FieldRow(
            stringResource(R.string.public_buses),
            Modifier.toggleable(value = profile.publicBuses, role = Role.Switch) { on -> account.edit { it.publicBuses = on } },
            sub = stringResource(R.string.public_buses_hint),
        ) { Switch(checked = profile.publicBuses, onCheckedChange = null) }
    }
}
