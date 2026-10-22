package sh.rcn.terminus.widget

import android.content.Context
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.state.updateAppWidgetState
import sh.rcn.terminus.NearbyStop

/**
 * The other side of the road on the Nearby widget. Stops across a road from each other are a few metres apart, within GPS error, so the
 * nearest stop can be the wrong side. A tap on the swap button puts the opposite stop first and the nearest one second; it stays swapped
 * while the nearest stop is the same one, for up to [KEEP_MS]. The widget shows only the first few stops, so the button is there only when
 * the opposite stop isn't one of them.
 */
object NearbySwap {
    const val KEEP_MS = 60 * 60_000L

    /** The stop that was nearest when swapped, and its opposite stop shown instead. */
    val FROM = stringPreferencesKey("nearby-swap-from")
    val TO = stringPreferencesKey("nearby-swap-to")
    val AT = longPreferencesKey("nearby-swap-at")

    data class Swap(val from: String, val to: String, val at: Long)

    /** The nearest stop's opposite stop, when the answer has it. */
    fun opposite(stops: List<NearbyStop>): NearbyStop? {
        val code = stops.firstOrNull()?.opposite ?: return null
        return stops.firstOrNull { it.code == code }
    }

    /** Whether `swap` still applies to these stops (nearest first, as the API sends them). */
    fun active(stops: List<NearbyStop>, swap: Swap?, now: Long): Boolean =
        swap != null && now - swap.at in 0..KEEP_MS && stops.firstOrNull()?.code == swap.from && opposite(stops)?.code == swap.to

    /** The stops as shown: the opposite stop first and the nearest second while swapped. */
    fun order(stops: List<NearbyStop>, swap: Swap?, now: Long): List<NearbyStop> {
        if (!active(stops, swap, now)) return stops
        val opp = opposite(stops)!!
        return listOf(opp, stops.first()) + stops.drop(1).filter { it.code != opp.code }
    }

    /**
     * The stop the swap button offers: the nearest stop's opposite stop, or the nearest one again while swapped. None when the opposite
     * stop is already among the stops on screen (`onScreen`), since there's nothing to swap for; a swap made before then can always be
     * undone.
     */
    fun offer(stops: List<NearbyStop>, swap: Swap?, now: Long, onScreen: Collection<String>): NearbyStop? {
        if (active(stops, swap, now)) return stops.firstOrNull()
        return opposite(stops)?.takeIf { it.code !in onScreen }
    }

    /**
     * Whether a tap offering [to], with [from] the nearest stop, undoes the swap stored as [storedFrom] → [storedTo]: while swapped the
     * button offers the nearest stop itself ([offer]), and a quick second tap repeats the swap just stored.
     */
    fun undoes(from: String, to: String, storedFrom: String?, storedTo: String?): Boolean =
        to == from || (storedFrom == from && storedTo == to)
}

/** The swap button: shows the opposite stop first, or, tapped again, the nearest stop. */
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
