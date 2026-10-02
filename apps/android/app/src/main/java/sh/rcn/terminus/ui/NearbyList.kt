package sh.rcn.terminus.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.core.graphics.toColorInt
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.NearbyStop
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L

@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean, onOpenStop: (String) -> Unit) {
    if (stops == null) {
        Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.nothing_yet))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (s in stops) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        // The stop's name opens it on the map, with its services and what's coming.
                        Text(
                            s.name,
                            fontWeight = FontWeight.Bold,
                            textDecoration = TextDecoration.Underline,
                            modifier = Modifier.weight(1f).clickable(role = Role.Button, onClickLabel = stringResource(R.string.on_the_map, s.name)) { onOpenStop(s.code) },
                        )
                        Text(if (s.walkS < 60) stringResource(R.string.here) else stringResource(R.string.min_walk, (s.walkS + 30) / 60), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!s.available) Text(stringResource(R.string.no_live_data), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (row in s.board) {
                        Row(Modifier.fillMaxWidth().padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            // In the service's colour, as on the buses and the map.
                            val color = row.color?.let { runCatching { Color(it.toColorInt()) }.getOrNull() }
                            Box(Modifier.weight(1f)) {
                                if (color != null) SvcTag(row.svc, color) else Text(row.svc, fontWeight = FontWeight.SemiBold)
                            }
                            Text(eta(row.etaS, row.quality))
                        }
                    }
                }
            }
        }
    }
}

internal fun eta(s: Int?, quality: String) = when {
    s == null -> if (quality == "ended") L.s(R.string.eta_ended) else "–"
    s < 45 -> L.s(R.string.now)
    else -> L.s(R.string.n_min, (s + 30) / 60)
}
