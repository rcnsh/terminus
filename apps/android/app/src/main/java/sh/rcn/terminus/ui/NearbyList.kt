package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.NearbyStop
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.L

@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean) {
    if (stops == null) {
        Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.nothing_yet))
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (s in stops) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text(if (s.walkS < 60) stringResource(R.string.here) else stringResource(R.string.min_walk, (s.walkS + 30) / 60), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!s.available) Text(stringResource(R.string.no_live_data), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    for (row in s.board) {
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp)) {
                            Text(row.svc, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
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
