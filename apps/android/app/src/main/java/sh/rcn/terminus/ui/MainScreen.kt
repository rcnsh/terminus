package sh.rcn.terminus.ui

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.Target
import sh.rcn.terminus.soonOnCampus
import sh.rcn.terminus.widget.clock

@Composable
internal fun MainScreen(state: UiState, vm: MainViewModel, onSettings: () -> Unit) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var hasLocation by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    // After two refusals Android stops showing the dialog, and the button
    // would do nothing. Then the only way is the app's settings page.
    var blocked by rememberSaveable { mutableStateOf(false) }
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        hasLocation = Locator.hasForeground(ctx)
        val activity = ctx as? android.app.Activity
        blocked = !hasLocation && activity?.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) == false
        vm.load()
    }
    // "Alarms & reminders" is allowed in system settings; check again on return.
    var exact by remember { mutableStateOf(LeaveAlerts.canBeExact(ctx)) }
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) { exact = LeaveAlerts.canBeExact(ctx) }
    }
    val openSettings = { ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))) }

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
            Box(Modifier.weight(1f)) { Wordmark(MaterialTheme.typography.titleLarge) }
            TextButton(onClick = onSettings) { Text("Settings") }
        }

        state.update?.let { v ->
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("terminus $v is out", modifier = Modifier.weight(1f))
                    TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "https://terminus.rcn.sh/download/android".toUri())) }) { Text("Update") }
                }
            }
        }

        if (!hasLocation) {
            Card(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("Allow location so answers start from the stop you're nearest. Without it, terminus assumes you're where your last class was, or at home.")
                    if (blocked) {
                        TextButton(onClick = openSettings) { Text("Open settings to allow location") }
                    } else {
                        TextButton(onClick = {
                            askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        }) { Text("Allow location") }
                    }
                }
            }
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
            if (state.showNearby) NearbyList(state.nearby, state.loading) else AnswerCard(state.answer, state.loading, vm::signal, state.signalling, vm::choose)
        }
        // The rest of today under the planned answer.
        if (!state.showNearby && state.target == Target.Plan) state.day?.let { DayTimeline(it, state.removed, vm::removeFromToday, vm::undoRemove, vm::dismissRemoved) }
        // Somewhere else: going there later today, planned like a class (phase 8.3).
        if (!state.showNearby && state.target != Target.Plan && state.paired) {
            TimeButton("Go later today at…", null, vm::goLater, Modifier.padding(top = 8.dp), initial = ::soonOnCampus)
        }

        val footer = listOfNotNull(
            state.error,
            state.fetchedAt?.let { "Updated ${clock(ctx, it)}" },
        ).joinToString(" · ")
        Row(Modifier.padding(top = 8.dp).height(20.dp), verticalAlignment = Alignment.CenterVertically) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(12.dp).semantics { contentDescription = "Refreshing" }, strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
            }
            Text(footer, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        if (!state.showNearby && state.answer != null) {
            var reporting by remember { mutableStateOf<String?>(null) }
            var opened by remember { mutableStateOf(false) }
            TextButton(onClick = { reporting = state.rawAnswers[state.target]; opened = true; vm.clearReportResult() }) { Text("Is this wrong?") }
            if (opened) {
                ReportDialog(
                    sending = state.reportSending,
                    onSend = { note ->
                        vm.report(note, reporting, BuildConfig.VERSION_NAME)
                        opened = false
                    },
                    onDismiss = { opened = false },
                )
            }
        }
        state.reportResult?.let {
            Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Spacer(Modifier.height(16.dp))
        NotifyToggle(
            "Notify me when to leave for class",
            "A heads-up 5 minutes before you need to set off, then the ride or the next way there, without asking you anything.",
            state.leaveAlerts, vm::setLeaveAlerts, openSettings,
        )
        NotifyToggle(
            "Live notification during trips",
            "During each trip, from time to go until you're there, keeps the next bus and a countdown in your notifications and the widget up to date. It checks for new times every 30 seconds then, which uses more battery.",
            state.liveUpdates, vm::setLiveUpdates, openSettings,
        )
        DetectToggle(state.detectTrips, vm::setDetectTrips, openSettings)
        if ((state.leaveAlerts || state.liveUpdates) && !exact) {
            Text(
                "\"Alarms & reminders\" is off for terminus, so the heads-up can come a few minutes late, and the live notification may wait for the next update to start.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = { runCatching { ctx.startActivity(LeaveAlerts.exactAlarmSettings(ctx)) } }) { Text("Allow alarms & reminders") }
        }

        Spacer(Modifier.height(16.dp))
        Search(state, vm)
        Spacer(Modifier.height(24.dp))
    }
}

/** Asks for notification permission on the way to "on", and says so when it's refused. */
@Composable
internal fun NotifyToggle(title: String, hint: String, on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        refused = !granted
        if (granted) onChange(true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = on,
                role = Role.Switch,
                onValueChange = { want ->
                    when {
                        !want -> onChange(false)
                        LeaveAlerts.canNotify(ctx) -> onChange(true)
                        // Only reached on Android 13+, where the permission exists.
                        else -> @Suppress("InlinedApi") ask.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            Text(
                hint,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
    if (refused && !on) {
        Text("Notifications are off for terminus.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = openSettings) { Text("Open settings") }
    }
}

/**
 * "Notice when I board" (phase 8.1): the live notification follows the trip by
 * location. Needs notifications and precise location, asked for on the way to on.
 */
@Composable
private fun DetectToggle(on: Boolean, onChange: (Boolean) -> Unit, openSettings: () -> Unit) {
    val ctx = LocalContext.current
    var refused by rememberSaveable { mutableStateOf(false) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val ok = granted[Manifest.permission.ACCESS_FINE_LOCATION] == true && LeaveAlerts.canNotify(ctx)
        refused = !ok
        if (ok) onChange(true)
    }
    Row(
        Modifier
            .fillMaxWidth()
            .toggleable(
                value = on,
                role = Role.Switch,
                onValueChange = { want ->
                    when {
                        !want -> onChange(false)
                        Locator.hasPrecise(ctx) && LeaveAlerts.canNotify(ctx) -> onChange(true)
                        else -> ask.launch(
                            listOfNotNull(
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION,
                                if (android.os.Build.VERSION.SDK_INT >= 33) Manifest.permission.POST_NOTIFICATIONS else null,
                            ).toTypedArray(),
                        )
                    }
                },
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text("Notice when I board")
            Text(
                "During a trip, the live notification uses your location to tell when you're on the bus, missed it, or are there, and keeps your plan right on every device. " +
                    "It starts when you open terminus or tap its notification or widget during the trip. Only what it means is kept, never where you were.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(12.dp))
        Switch(checked = on, onCheckedChange = null)
    }
    if (refused && !on) {
        Text("terminus needs precise location and notifications for this.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        TextButton(onClick = openSettings) { Text("Open settings") }
    }
}

/** "Is this wrong?": an optional note, sent with the answer that was on screen. */
@Composable
private fun ReportDialog(sending: Boolean, onSend: (String) -> Unit, onDismiss: () -> Unit) {
    var note by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("What was wrong?") },
        text = {
            Column {
                OutlinedTextField(
                    value = note,
                    onValueChange = { if (it.length <= 1000) note = it },
                    placeholder = { Text("The D2 never came, the walk is longer…") },
                    minLines = 2,
                    maxLines = 5,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "Sends this answer and your note, with your email address (if you've added one) so you can get a reply.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        confirmButton = { TextButton(onClick = { onSend(note) }, enabled = !sending) { Text("Send") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
