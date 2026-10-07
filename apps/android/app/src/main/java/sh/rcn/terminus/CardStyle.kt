package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

/**
 * How the card and the widgets draw a trip by bus or on foot (`card.journey`),
 * chosen in Settings › Appearance, for this phone only. Each leads with when
 * to leave:
 *
 * - Steps: the trip as a line diagram down the card, as on a bus's route
 *   map: the walk dotted, the ride in the bus's colour, each point with its
 *   time. The default.
 * - Route: a line across, from you to the stop to where you're going, with
 *   the times under each point: the whole trip at a glance.
 * - Ticket: the bus first, as a badge in its colour (what you look for on the
 *   road), then when to leave and when you get there.
 */
object CardStyle {
    const val ROUTE = "route"
    const val TICKET = "ticket"
    const val STEPS = "steps"

    val ALL = listOf(STEPS, ROUTE, TICKET)

    /** The trip as a line diagram, until another is chosen. */
    const val DEFAULT = STEPS

    private const val KEY = "card_style"

    private fun prefs(ctx: Context) = terminusPrefs(ctx)

    // Read in a composable, so the card redraws when Settings changes it.
    private val chosen = mutableStateOf<String?>(null)

    fun pref(ctx: Context): String = chosen.value ?: prefs(ctx).getString(KEY, DEFAULT)?.takeIf { it in ALL } ?: DEFAULT

    /** Sets it; the caller redraws the widgets. */
    fun set(ctx: Context, style: String) {
        prefs(ctx).edit { putString(KEY, style) }
        chosen.value = style
    }

    fun name(style: String) = when (style) {
        TICKET -> R.string.card_style_ticket
        STEPS -> R.string.card_style_steps
        else -> R.string.card_style_route
    }
}
