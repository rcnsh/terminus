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

@Composable
internal fun NearbyList(stops: List<NearbyStop>?, loading: Boolean) {
    if (stops == null) {
        Text(if (loading) "Checking…" else "Nothing yet")
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        for (s in stops) {
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(s.name, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
                        Text(if (s.walkS < 60) "here" else "${(s.walkS + 30) / 60} min walk", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!s.available) Text("No live data", color = MaterialTheme.colorScheme.onSurfaceVariant)
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
    s == null -> if (quality == "ended") "ended" else "–"
    s < 45 -> "now"
    else -> "${(s + 30) / 60} min"
}
