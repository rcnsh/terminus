package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

object CardStyle {
    const val ROUTE = "route"
    const val STEPS = "steps"

    val ALL = listOf(STEPS, ROUTE)

    const val DEFAULT = STEPS

    const val KEY = "card_style"

    private fun prefs(ctx: Context) = terminusPrefs(ctx)

    private val chosen = mutableStateOf<String?>(null)

    fun pref(ctx: Context): String = chosen.value ?: prefs(ctx).getString(KEY, DEFAULT)?.takeIf { it in ALL } ?: DEFAULT

    fun set(ctx: Context, style: String) {
        prefs(ctx).edit { putString(KEY, style) }
        chosen.value = style
    }

    fun name(style: String) =
        when (style) {
            STEPS -> R.string.card_style_steps
            else -> R.string.card_style_route
        }
}
