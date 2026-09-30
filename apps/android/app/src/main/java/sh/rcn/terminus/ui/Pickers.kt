package sh.rcn.terminus.ui

import android.app.TimePickerDialog
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.Destination
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12
import sh.rcn.terminus.rankDestinations

/** One choice from a list, as a dropdown field. `null` is the blank option. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun <T> Choice(
    label: String,
    options: List<Pair<T, String>>,
    selected: T?,
    onSelect: (T?) -> Unit,
    blank: String? = null,
    modifier: Modifier = Modifier.fillMaxWidth(),
) {
    var open by rememberSaveable { mutableStateOf(false) }
    val shown = options.firstOrNull { it.first == selected }?.second ?: blank.orEmpty()
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = modifier) {
        OutlinedTextField(
            value = shown,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (blank != null) DropdownMenuItem(text = { Text(blank) }, onClick = { onSelect(null); open = false })
            for ((value, text) in options) {
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false })
            }
        }
    }
}

/**
 * "Stop, building or room": the same search as the main screen's. Calls
 * [onPick] with the result; the caller stores its `stopCode`.
 */
@Composable
internal fun WherePicker(label: String, destinations: List<Destination>, picked: Destination?, onPick: (Destination?) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = picked?.label ?: query,
        onValueChange = {
            query = it
            if (picked != null) onPick(null)
        },
        label = { Text(label) },
        placeholder = { Text("Stop, building or room") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    if (picked != null || query.isBlank()) return
    val matches = rankDestinations(destinations, query, max = 6)
    Column {
        if (matches.isEmpty() && destinations.isNotEmpty()) {
            Text("No stop, building or room by that name", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
        }
        for (d in matches) {
            Column(
                Modifier.fillMaxWidth().clickable(role = Role.Button) {
                    query = ""
                    onPick(d)
                }.padding(vertical = 8.dp),
            ) {
                Text(d.label)
                Text(
                    when (d.kind) {
                        "stop" -> "Bus stop"
                        "landmark" -> d.detail ?: "Place"
                        "building" -> "Building"
                        else -> "Room ${d.code}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            HorizontalDivider()
        }
    }
}

/** A time of day as a button that opens the system time picker. */
@Composable
internal fun TimeButton(label: String, minutes: Int?, onPick: (Int) -> Unit, modifier: Modifier = Modifier) {
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    OutlinedButton(
        onClick = {
            val m = minutes ?: 9 * 60
            TimePickerDialog(ctx, { _, h, min -> onPick(h * 60 + min) }, m / 60, m % 60, !h12).show()
        },
        modifier = modifier,
    ) {
        Text(if (minutes == null) label else "$label ${if (h12) hhmm12(minutes) else hhmm(minutes)}")
    }
}

/** A setting's explanation, under it. */
@Composable
internal fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** A section heading in setup and settings. */
@Composable
internal fun Heading(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.titleMedium, modifier = modifier.padding(top = 20.dp, bottom = 6.dp))
}
