package sh.rcn.terminus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.Target
import sh.rcn.terminus.rankDestinations
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L

/**
 * "Go somewhere else", opened by the search button at the end of the chips:
 * a field under them, focused, with the results below. Picking one shows its
 * card under a chip of its own and closes the search; so does Back.
 */
@Composable
internal fun Search(state: UiState, vm: MainViewModel, onClose: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        vm.loadDestinations()
        focus.requestFocus()
    }
    BackHandler(onBack = onClose)
    Column(Modifier.padding(top = 12.dp)) {
        SearchField(state, vm, query, query.trim(), { query = it }, Modifier.focusRequester(focus), onPicked = onClose)
    }
}

@Composable
private fun SearchField(state: UiState, vm: MainViewModel, query: String, q: String, setQuery: (String) -> Unit, modifier: Modifier, onPicked: () -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = {
            setQuery(it)
            vm.loadDestinations()
        },
        label = { Text(stringResource(R.string.go_somewhere_else)) },
        placeholder = { Text(stringResource(R.string.search_placeholder)) },
        singleLine = true,
        modifier = modifier.fillMaxWidth(),
    )
    if (q.isEmpty()) return
    // Once per query, not on every recomposition (the screen refreshes every 30 s).
    val matches = remember(state.destinations, q) { rankDestinations(state.destinations, q) }
    val stopName = { code: String -> state.destinations.firstOrNull { it.kind == "stop" && it.code == code }?.label ?: code }
    val groups = mapOf("stop" to stringResource(R.string.group_stops), "landmark" to stringResource(R.string.group_places), "building" to stringResource(R.string.group_buildings), "room" to stringResource(R.string.group_rooms))
    Column {
        if (matches.isEmpty() && state.destinations.isNotEmpty()) {
            Text(stringResource(R.string.search_none), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
        }
        var group: String? = null
        for (d in matches) {
            if (d.kind != group) {
                group = d.kind
                Text(
                    groups[d.kind].orEmpty().uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
                )
            }
            val meta = when (d.kind) {
                "stop" -> L.s(R.string.bus_stop)
                // Served by more than one stop: the quicker one is used at the time.
                "landmark" -> listOfNotNull(d.detail, L.s(R.string.stop_suffix, d.stops.joinToString(L.s(R.string.or_list)) { stopName(it) })).joinToString(" · ")
                else -> buildString {
                    if (d.label != d.code) append("${d.code} · ")
                    append(L.s(R.string.stop_suffix, stopName(d.stopCode)))
                    d.walkM?.let { append(L.s(R.string.min_walk_comma, maxOf(1, Math.round(it / 1.3 / 60).toInt()))) }
                }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) {
                        setQuery("")
                        vm.select(Target.Code(d.code, if (d.kind == "stop" || d.kind == "landmark") d.label else d.code))
                        onPicked()
                    }
                    .padding(vertical = 10.dp),
            ) {
                Text(d.label)
                Text(meta, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            HorizontalDivider()
        }
    }
}
