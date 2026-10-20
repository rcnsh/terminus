package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

/**
 * "New to NUS", in Settings › Appearance, for this phone only: the Nearby widget explains the buses for someone who doesn't know the routes
 * yet. Each side of the road says which way its buses go, each bus the places it passes (the server's `via`: the MRT, UTown, PGP), and Live
 * and Scheduled are spelled out. Off, the widget is as dense as it goes: more buses, fewer words.
 */
object NewToNus {
    /** In terminusPrefs, as "on" or "off"; a sign-out keeps it ([Store.clear]). */
    const val KEY = "new_to_nus"

    // Read in a composable, so Settings redraws when it changes.
    private val chosen = mutableStateOf<Boolean?>(null)

    fun on(ctx: Context): Boolean = chosen.value ?: (terminusPrefs(ctx).getString(KEY, null) == "on")

    /** Sets it; the caller redraws the widgets. */
    fun set(ctx: Context, on: Boolean) {
        terminusPrefs(ctx).edit { putString(KEY, if (on) "on" else "off") }
        chosen.value = on
    }
}
