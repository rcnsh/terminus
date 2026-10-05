package sh.rcn.terminus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
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
 * The card styles, each drawn with a made-up trip so the choice is made by
 * looking, not by reading. The pick holds for the card and the widgets.
 */
@Composable
internal fun CardStylePicker() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val chosen = CardStyle.pref(ctx)
    val sample = sampleAnswer()
    Text(stringResource(R.string.card_style), style = MaterialTheme.typography.titleMedium)
    Text(stringResource(R.string.card_style_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
    Column(Modifier.selectableGroup(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (style in CardStyle.ALL) {
            val on = style == chosen
            OutlinedCard(
                Modifier.fillMaxWidth().selectable(on, role = Role.RadioButton) {
                    CardStyle.set(ctx, style)
                    scope.launch { redrawWidgets(ctx) }
                },
                border = BorderStroke(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp, top = 4.dp, end = 16.dp)) {
                    RadioButton(selected = on, onClick = null, modifier = Modifier.padding(12.dp))
                    Column {
                        Text(stringResource(CardStyle.name(style)), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        Text(stringResource(hint(style)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Column(Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    JourneyCard(sample, sample.card!!.journey!!, style)
                }
            }
        }
    }
}

private fun hint(style: String) = when (style) {
    CardStyle.TICKET -> R.string.card_style_ticket_hint
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
        val journey = Journey(
            leave = at(leave), walk = min, bus = JourneyBus("D2", 0xFF8E44C9, "PGP", at(board)), boardAtMs = board, ride = ride, off = null,
            to = "UTown", toStop = "UTown", arrive = at(arrive), slack = null, live = true, backup = JourneyBus("A1", 0xFFE53935, "PGP", at(board + 3 * 60_000)),
        )
        val card = Card(
            kind = "trip", staleAtMs = null, crowd = null, quality = null, leaveBy = null, leaveVia = null, catch = null, arrive = null,
            catchLine = null, late = false, goNow = null, note = null, estimate = null, journey = journey,
        )
        NextAnswer(
            label = "D2", detail = "", alt = null, stopName = "PGP", quality = "live", asOf = "", mode = "trip", destLabel = "UTown", why = "place",
            places = emptyList(), departsAtMs = board, timingStatus = null, timingText = null, leaveAtMs = leave, card = card,
        )
    }
}
