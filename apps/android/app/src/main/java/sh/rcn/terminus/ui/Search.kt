package sh.rcn.terminus.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.Target
import sh.rcn.terminus.rankDestinations

@Composable
internal fun Search(state: UiState, vm: MainViewModel) {
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
    if (q.isEmpty()) return
    val matches = rankDestinations(state.destinations, q)
    val stopName = { code: String -> state.destinations.firstOrNull { it.kind == "stop" && it.code == code }?.label ?: code }
    val groups = mapOf("stop" to "Stops", "landmark" to "Food & places", "building" to "Buildings", "room" to "Rooms")
    Column {
        if (matches.isEmpty() && state.destinations.isNotEmpty()) {
            Text("No stop, building or room by that name", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp))
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
                "stop" -> "Bus stop"
                // Served by more than one stop: the quicker one is used at the time.
                "landmark" -> listOfNotNull(d.detail, d.stops.joinToString(" or ") { stopName(it) } + " stop").joinToString(" · ")
                else -> buildString {
                    if (d.label != d.code) append("${d.code} · ")
                    append("${stopName(d.stopCode)} stop")
                    d.walkM?.let { append(", ${maxOf(1, Math.round(it / 1.3 / 60).toInt())} min walk") }
                }
            }
            Column(
                Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) {
                        query = ""
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
