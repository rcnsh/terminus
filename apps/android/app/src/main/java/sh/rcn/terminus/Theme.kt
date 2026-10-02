package sh.rcn.terminus

import android.app.UiModeManager
import android.content.Context
import androidx.core.content.edit

/**
 * Light, dark, or the phone's own setting ("auto"), chosen in Settings ›
 * Appearance, for this phone only. Android keeps the choice as the app's
 * night mode, so everything that follows the system's dark mode (the
 * screens, the map, the status bar, dialogs) follows it, and it holds
 * from the next launch without the app applying it again.
 */
object Theme {
    const val AUTO = "auto"
    const val LIGHT = "light"
    const val DARK = "dark"

    private const val KEY = "theme"

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

    /** What this phone was set to: auto, light or dark. */
    fun pref(ctx: Context): String = prefs(ctx).getString(KEY, AUTO) ?: AUTO

    /** Sets it; the system then redraws the app in it. */
    fun set(ctx: Context, pref: String) {
        prefs(ctx).edit { putString(KEY, pref) }
        ctx.getSystemService(UiModeManager::class.java)?.setApplicationNightMode(
            when (pref) {
                LIGHT -> UiModeManager.MODE_NIGHT_NO
                DARK -> UiModeManager.MODE_NIGHT_YES
                else -> UiModeManager.MODE_NIGHT_AUTO
            },
        )
    }
}
