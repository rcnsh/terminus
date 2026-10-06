package sh.rcn.terminus.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TimePickerDefaults
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R

/** One choice from a list, as a dropdown field. `null` is the blank option; [headings] go before the option at their index. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun <T> Choice(
    label: String,
    options: List<Pair<T, String>>,
    selected: T?,
    onSelect: (T?) -> Unit,
    blank: String? = null,
    headings: Map<Int, String> = emptyMap(),
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
            for ((i, option) in options.withIndex()) {
                headings[i]?.let { Label(it, Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp)) }
                val (value, text) = option
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
internal fun WherePicker(
    label: String,
    destinations: List<Destination>,
    picked: Destination?,
    pinned: List<Destination> = emptyList(),
    onPick: (Destination?) -> Unit,
) {
    var query by rememberSaveable { mutableStateOf("") }
    OutlinedTextField(
        value = picked?.label ?: query,
        onValueChange = {
            query = it
            if (picked != null) onPick(null)
        },
        label = { Text(label) },
        placeholder = { Text(stringResource(R.string.search_placeholder)) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    if (picked != null) return
    // [pinned] comes first in its own group, before anything is typed too.
    val top = if (query.isBlank()) pinned else rankDestinations(pinned, query, max = 6)
    val rest = if (query.isBlank()) emptyList() else rankDestinations(destinations, query, max = 6).filter { d -> top.none { it.code == d.code } }
    if (top.isEmpty() && rest.isEmpty() && query.isBlank()) return
    Column {
        if (top.isEmpty() && rest.isEmpty() && destinations.isNotEmpty()) {
            Text(stringResource(R.string.search_none), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 8.dp))
        }
        if (top.isNotEmpty()) {
            Text(
                stringResource(R.string.in_your_timetable),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
            )
        }
        for ((i, d) in (top + rest).withIndex()) {
            if (i == top.size && top.isNotEmpty()) HorizontalDivider(thickness = 2.dp)
            Column(
                Modifier.fillMaxWidth().clickable(role = Role.Button) {
                    query = ""
                    onPick(d)
                }.padding(vertical = 8.dp),
            ) {
                Text(d.label)
                Text(
                    when (d.kind) {
                        "timetable" -> d.detail.orEmpty()
                        "stop" -> stringResource(R.string.bus_stop)
                        "landmark" -> d.detail ?: stringResource(R.string.place)
                        "building" -> stringResource(R.string.building)
                        else -> stringResource(R.string.room_code, d.code)
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            HorizontalDivider()
        }
    }
}

/**
 * A time of day as a button that opens a time picker in the app's theme.
 * With no time set yet, the picker starts at [initial] (minutes past midnight).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TimeButton(label: String, minutes: Int?, onPick: (Int) -> Unit, modifier: Modifier = Modifier, initial: () -> Int = { 9 * 60 }) {
    val h12 = hour12(LocalContext.current)
    var open by rememberSaveable { mutableStateOf(false) }
    OutlinedButton(onClick = { open = true }, modifier = modifier) {
        Text(if (minutes == null) label else "$label ${if (h12) hhmm12(minutes) else hhmm(minutes)}")
    }
    if (open) {
        val m = remember { minutes ?: initial() }
        val state = rememberTimePickerState(initialHour = m / 60, initialMinute = m % 60, is24Hour = !h12)
        AlertDialog(
            onDismissRequest = { open = false },
            confirmButton = {
                TextButton(onClick = {
                    open = false
                    onPick(state.hour * 60 + state.minute)
                }) { Text(stringResource(R.string.ok)) }
            },
            dismissButton = { TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) } },
            // AM/PM in the same tint as the selected hour (the default is the theme's unset tertiary, a pink).
            text = {
                TimePicker(
                    state,
                    colors = TimePickerDefaults.colors(
                        periodSelectorSelectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                        periodSelectorSelectedContentColor = MaterialTheme.colorScheme.onPrimaryContainer,
                    ),
                )
            },
        )
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
