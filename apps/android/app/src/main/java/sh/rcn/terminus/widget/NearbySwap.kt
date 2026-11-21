package sh.rcn.terminus.widget

import android.content.Context
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.state.updateAppWidgetState
import sh.rcn.terminus.NearbyStop

object NearbySwap {
    const val KEEP_MS = 60 * 60_000L

    val FROM = stringPreferencesKey("nearby-swap-from")
    val TO = stringPreferencesKey("nearby-swap-to")
    val AT = longPreferencesKey("nearby-swap-at")

    data class Swap(val from: String, val to: String, val at: Long)

    fun opposite(stops: List<NearbyStop>): NearbyStop? {
        val code = stops.firstOrNull()?.opposite ?: return null
        return stops.firstOrNull { it.code == code }
    }

    fun active(stops: List<NearbyStop>, swap: Swap?, now: Long): Boolean =
        swap != null && now - swap.at in 0..KEEP_MS && stops.firstOrNull()?.code == swap.from && opposite(stops)?.code == swap.to

    fun order(stops: List<NearbyStop>, swap: Swap?, now: Long): List<NearbyStop> {
        if (!active(stops, swap, now)) return stops
        val opp = opposite(stops)!!
        return listOf(opp, stops.first()) + stops.drop(1).filter { it.code != opp.code }
    }

    fun offer(stops: List<NearbyStop>, swap: Swap?, now: Long, onScreen: Collection<String>): NearbyStop? {
        if (active(stops, swap, now)) return stops.firstOrNull()
        return opposite(stops)?.takeIf { it.code !in onScreen }
    }

    fun undoes(from: String, to: String, storedFrom: String?, storedTo: String?): Boolean =
        to == from || (storedFrom == from && storedTo == to)
}

class SwapAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val from = parameters[FROM] ?: return
        val to = parameters[TO] ?: return
        updateAppWidgetState(context, glanceId) {
            if (NearbySwap.undoes(from, to, it[NearbySwap.FROM], it[NearbySwap.TO])) {
                it.remove(NearbySwap.FROM)
                it.remove(NearbySwap.TO)
                it.remove(NearbySwap.AT)
            } else {
                it[NearbySwap.FROM] = from
                it[NearbySwap.TO] = to
                it[NearbySwap.AT] = System.currentTimeMillis()
            }
        }
        redrawWidgets(context)
    }

    companion object {
        val FROM = ActionParameters.Key<String>("from")
        val TO = ActionParameters.Key<String>("to")
    }
}
