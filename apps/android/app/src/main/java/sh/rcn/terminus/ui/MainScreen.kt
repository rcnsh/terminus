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
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.Target
import sh.rcn.terminus.widget.clock

@Composable
internal fun MainScreen(state: UiState, vm: MainViewModel) {
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
            var confirmUnpair by remember { mutableStateOf(false) }
            TextButton(onClick = { confirmUnpair = true }) { Text("Unpair") }
            if (confirmUnpair) {
                AlertDialog(
                    onDismissRequest = { confirmUnpair = false },
                    title = { Text("Unpair this phone?") },
                    text = { Text("The app and widget stop showing your timetable. You can pair again with a new code from the account page.") },
                    confirmButton = { TextButton(onClick = { confirmUnpair = false; vm.unpair() }) { Text("Unpair") } },
                    dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") } },
                )
            }
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
        } else if (!Locator.hasBackground(ctx)) {
            Text(
                "The widget follows your timetable when it refreshes in the background. For it to use your location too, set location to \"Allow all the time\".",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            TextButton(onClick = openSettings) { Text("Open settings") }
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
            if (state.showNearby) NearbyList(state.nearby, state.loading) else AnswerCard(state.answer, state.loading)
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

        Spacer(Modifier.height(16.dp))
        NotifyToggle(
            "Notify me when to leave for class",
            "A heads-up 5 minutes before you need to set off.",
            state.leaveAlerts, vm::setLeaveAlerts, openSettings,
        )
        NotifyToggle(
            "Live notification during your day",
            "Keeps the next bus and a countdown in your notifications, and the widget up to date. Uses a lot of battery: it checks for new times every 30 seconds while your day is on.",
            state.liveUpdates, vm::setLiveUpdates, openSettings,
        )

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
