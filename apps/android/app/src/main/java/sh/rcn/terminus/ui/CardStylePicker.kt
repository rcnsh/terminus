package sh.rcn.terminus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.rcn.terminus.Card
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.Journey
import sh.rcn.terminus.JourneyBus
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.redrawWidgets

/**
 * The card style: Steps or Route as pills, like the theme's, and the chosen one drawn under them with a made-up trip, so the choice is made
 * by looking without a card for each. The pick holds for the card and the widgets.
 */
@Composable
internal fun CardStylePicker() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    // Read again when it changes, so the pill and the sample move at once.
    var chosen by remember { mutableStateOf(CardStyle.pref(ctx)) }
    val sample = sampleAnswer()
    Group(stringResource(R.string.card_style), stringResource(R.string.card_style_hint)) {
        Pills(
            CardStyle.ALL.map { it to stringResource(CardStyle.name(it)) },
            chosen,
            {
                CardStyle.set(ctx, it)
                chosen = it
                scope.launch { redrawWidgets(ctx) }
            },
            Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp),
        )
        Text(
            stringResource(hint(chosen)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp),
        )
        OutlinedCard(
            Modifier.fillMaxWidth().padding(16.dp).clearAndSetSemantics {},
            colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.background),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                JourneyCard(sample, sample.card!!.journey!!, chosen)
            }
        }
    }
}

private fun hint(style: String) =
    when (style) {
        CardStyle.STEPS -> R.string.card_style_steps_hint
        else -> R.string.card_style_route_hint
    }

/** A D2 from PGP to UTown, leaving in a few minutes, in the phone's clock style. */
@Composable
private fun sampleAnswer(): NextAnswer {
    val ctx = LocalContext.current
    val min = stringResource(R.string.n_min, 3)
    val ride = stringResource(R.string.n_min, 8)
    return remember(min) {
        val now = System.currentTimeMillis()
        val leave = now + 4 * 60_000
        val board = leave + 4 * 60_000
        val arrive = board + 8 * 60_000
        val at = { ms: Long -> clock(ctx, ms) }
        val journey =
            Journey(
                leave = at(leave),
                walk = min,
                bus = JourneyBus("D2", 0xFF8E44C9, "PGP", at(board)),
                boardAtMs = board,
                ride = ride,
                off = null,
                to = "UTown",
                toStop = "UTown",
                arrive = at(arrive),
                slack = null,
                live = true,
                backup = JourneyBus("A1", 0xFFD32F2F, "PGP", at(board + 3 * 60_000)),
            )
        val card =
            Card(
                kind = "trip",
                staleAtMs = null,
                crowd = null,
                quality = null,
                leaveBy = null,
                leaveVia = null,
                catch = null,
                arrive = null,
                catchLine = null,
                late = false,
                goNow = null,
                note = null,
                estimate = null,
                journey = journey,
            )
        NextAnswer(
            label = "D2",
            detail = "",
            alt = null,
            stopName = "PGP",
            quality = "live",
            asOf = "",
            mode = "trip",
            destLabel = "UTown",
            why = "place",
            places = emptyList(),
            departsAtMs = board,
            timingStatus = null,
            timingText = null,
            leaveAtMs = leave,
            card = card,
        )
    }
}
