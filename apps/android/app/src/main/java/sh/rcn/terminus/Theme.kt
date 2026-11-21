package sh.rcn.terminus

import android.app.UiModeManager
import android.content.Context
import androidx.core.content.edit

object Theme {
    const val AUTO = "auto"
    const val LIGHT = "light"
    const val DARK = "dark"

    private const val KEY = "theme"

    private fun prefs(ctx: Context) = terminusPrefs(ctx)

    fun pref(ctx: Context): String = prefs(ctx).getString(KEY, AUTO) ?: AUTO

    fun set(ctx: Context, pref: String) {
        prefs(ctx).edit { putString(KEY, pref) }
        ctx.getSystemService(UiModeManager::class.java)
            ?.setApplicationNightMode(
                when (pref) {
                    LIGHT -> UiModeManager.MODE_NIGHT_NO
                    DARK -> UiModeManager.MODE_NIGHT_YES
                    else -> UiModeManager.MODE_NIGHT_AUTO
                }
            )
    }
}
