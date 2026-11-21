package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

object NewToNus {
    const val KEY = "new_to_nus"

    private val chosen = mutableStateOf<Boolean?>(null)

    fun on(ctx: Context): Boolean = chosen.value ?: (terminusPrefs(ctx).getString(KEY, null) == "on")

    fun set(ctx: Context, on: Boolean) {
        terminusPrefs(ctx).edit { putString(KEY, if (on) "on" else "off") }
        chosen.value = on
    }
}
