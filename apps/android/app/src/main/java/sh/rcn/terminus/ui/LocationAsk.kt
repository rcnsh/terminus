package sh.rcn.terminus.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.Locator
import sh.rcn.terminus.R

/** Whether the app may use the location while it's open, and the ways to allow it, for Now and Nearby ([rememberLocationAsk]). */
internal class LocationAsk(
    val allowed: Boolean,
    /** Android no longer shows its dialog (refused twice): the only way left is the app's page in the phone's settings. */
    val blocked: Boolean,
    /** Shows Android's dialog. */
    val ask: () -> Unit,
    val openSettings: () -> Unit,
    /** Reads it again: it may have been allowed in the phone's settings meanwhile. */
    val recheck: () -> Unit,
)

/** The location permission as it stands; [onAnswered] runs once Android's dialog has been answered, either way. */
@Composable
internal fun rememberLocationAsk(onAnswered: () -> Unit): LocationAsk {
    val ctx = LocalContext.current
    val answered by rememberUpdatedState(onAnswered)
    var allowed by remember { mutableStateOf(Locator.hasForeground(ctx)) }
    var blocked by rememberSaveable { mutableStateOf(false) }
    val launcher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            allowed = Locator.hasForeground(ctx)
            val activity = ctx as? android.app.Activity
            blocked = !allowed && activity?.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION) == false
            answered()
        }
    return LocationAsk(
        allowed,
        blocked,
        ask = { launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)) },
        openSettings = { ctx.openAppSettings() },
        recheck = { allowed = Locator.hasForeground(ctx) },
    )
}

/** A card saying [why] to allow location, with the button that does: Android's dialog, or the phone's settings once that's [blocked]. */
@Composable
internal fun LocationCard(why: String, location: LocationAsk, modifier: Modifier = Modifier) {
    Card(Modifier.fillMaxWidth().then(modifier)) {
        Column(Modifier.padding(12.dp)) {
            Text(why)
            if (location.blocked) {
                TextButton(onClick = location.openSettings) { Text(stringResource(R.string.open_settings_location)) }
            } else {
                TextButton(onClick = location.ask) { Text(stringResource(R.string.allow_location)) }
            }
        }
    }
}
