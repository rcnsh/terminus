package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import sh.rcn.terminus.Quiet
import sh.rcn.terminus.R
import sh.rcn.terminus.parseColor
import sh.rcn.terminus.widget.clock

/**
 * The Nearby tab (ADR 0017): its title in a band of sky, as Stops has, then the stops around you as their signs ([NearbyList]), in the
 * page's column at every width; under them, when they came. Opening it asks for the location once, and it asks for its stops when it opens
 * and then at the card's pace, only while it's the tab on screen.
 */
@Composable
internal fun NearbyScreen(state: UiState, vm: MainViewModel, insets: PaddingValues, act: NearbyActions) {
    val ctx = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val location = rememberLocationAsk { vm.loadNearby(restart = true) }
    // Once while the app is open, not each time the tab comes back: refused, the card under the title is the way to allow it.
    var asked by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!asked && !location.allowed) {
            asked = true
            location.ask()
        }
    }
    LaunchedEffect(Unit) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            location.recheck()
            while (true) {
                vm.loadNearby()
                // Never sooner than a 429's or a 503's Retry-After.
                delay(maxOf(POLL_MS, Quiet.waitMs()))
            }
        }
    }
    val phase = skyPhase()
    val top = insets.calculateTopPadding()
    val scroll = rememberScrollState()
    // Pulled down, the stops are asked for again; the nearest stop's first service drives to the sign on the hill.
    BusPull(
        state.nearby?.firstOrNull()?.board?.firstOrNull()?.color?.let(::parseColor),
        ::hillScene,
        onRefresh = vm::pullNearby,
        modifier = Modifier.padding(bottom = insets.calculateBottomPadding()),
    ) { pull ->
        Box(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(scroll)) {
                // The title is short, so the moon has room on its right.
                SkyBand(phase, top, moonLow = true, moonLine = false, padded = false) {
                    Column(Modifier.pullLead(pull)) {
                        PullRoom(base = 8.dp, above = 8.dp, below = 8.dp)
                        Text(
                            stringResource(R.string.chip_nearby),
                            style = MaterialTheme.typography.headlineMedium,
                            fontWeight = FontWeight.ExtraBold,
                            modifier = Modifier.padding(horizontal = 16.dp).padding(top = 4.dp).semantics { heading() },
                        )
                    }
                }
                Column(Modifier.column().padding(horizontal = 16.dp).padding(top = 20.dp, bottom = 24.dp)) {
                    if (!location.allowed)
                        LocationCard(stringResource(R.string.nearby_location_ask), location, Modifier.padding(bottom = 12.dp))
                    if (state.nearby?.isEmpty() == true)
                        Text(stringResource(R.string.no_stops_near), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else NearbyList(state.nearby, state.nearbyLoading, act)
                    val footer =
                        listOfNotNull(state.nearbyError, state.nearbyFetchedAt?.let { stringResource(R.string.updated_at, clock(ctx, it)) })
                            .joinToString(" · ")
                    val refreshing = stringResource(R.string.refreshing)
                    Row(
                        Modifier.fillMaxWidth().padding(top = 8.dp, start = 6.dp, end = 6.dp).heightIn(min = 20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (state.nearbyLoading) {
                            CircularProgressIndicator(
                                Modifier.size(12.dp).semantics { contentDescription = refreshing },
                                strokeWidth = 2.dp,
                            )
                            Spacer(Modifier.width(8.dp))
                        }
                        // A failed refresh is said as it happens; "Updated 9:41" alone isn't.
                        val failed = state.nearbyError != null
                        Text(
                            footer,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.semantics { if (failed) liveRegion = LiveRegionMode.Polite },
                        )
                    }
                }
            }
            StatusStrip(phase, top, scroll)
        }
    }
}
