package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

/**
 * How the card and the widgets draw a trip by bus or on foot (`card.journey`),
 * chosen in Settings › Appearance, for this phone only. Each leads with when
 * to leave:
 *
 * - Route: a line from you to the stop to where you're going, with the times
 *   under each point. The default: the whole trip at a glance.
 * - Ticket: the bus first, as a badge in its colour (what you look for on the
 *   road), then when to leave and when you get there.
 * - Steps: walk, bus, arrive, one under the other, each with its time.
 */
object CardStyle {
    const val ROUTE = "route"
    const val TICKET = "ticket"
    const val STEPS = "steps"

    val ALL = listOf(ROUTE, TICKET, STEPS)

    private const val KEY = "card_style"

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

    // Read in a composable, so the card redraws when Settings changes it.
    private val chosen = mutableStateOf<String?>(null)

    fun pref(ctx: Context): String = chosen.value ?: prefs(ctx).getString(KEY, ROUTE)?.takeIf { it in ALL } ?: ROUTE

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
