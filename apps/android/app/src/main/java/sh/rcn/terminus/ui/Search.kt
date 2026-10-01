package sh.rcn.terminus.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.Target
import sh.rcn.terminus.rankDestinations
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun Search(state: UiState, vm: MainViewModel) {
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim()
    // The field sits at the bottom of the screen, so typing put the results
    // under the keyboard: once there are results, scroll the field to the top
    // with as many results under it as fit.
    val reveal = remember { BringIntoViewRequester() }
    var height by remember { mutableIntStateOf(0) }
    val room = with(LocalDensity.current) { 360.dp.toPx() }
    LaunchedEffect(q.isEmpty(), height) {
        if (q.isNotEmpty()) reveal.bringIntoView(Rect(0f, 0f, 1f, minOf(height.toFloat(), room)))
    }
    Column(Modifier.bringIntoViewRequester(reveal).onSizeChanged { height = it.height }) {
        SearchField(state, vm, query, q) { query = it }
    }
}

@Composable
private fun SearchField(state: UiState, vm: MainViewModel, query: String, q: String, setQuery: (String) -> Unit) {
    OutlinedTextField(
        value = query,
        onValueChange = {
            setQuery(it)
            vm.loadDestinations()
        },
        label = { Text(stringResource(R.string.go_somewhere_else)) },
        placeholder = { Text(stringResource(R.string.search_placeholder)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    if (q.isEmpty()) return
    val matches = rankDestinations(state.destinations, q)
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
