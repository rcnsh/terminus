package sh.rcn.terminus

import android.content.Context
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.edit

/** Nearby's times in minutes ("4 min") or as clock times: this phone's choice, kept between visits, as the web app keeps it. */
object NearbyTimes {
    /** In terminusPrefs, "clock" or "minutes"; a sign-out keeps it ([Store.clear]). Anything else reads as minutes. */
    const val KEY = "nearby-times"
    private const val CLOCK = "clock"
    private const val MINUTES = "minutes"

    // Read in a composable, so every sign switches at once.
    private val chosen = mutableStateOf<Boolean?>(null)

    fun clock(ctx: Context): Boolean = chosen.value ?: (terminusPrefs(ctx).getString(KEY, MINUTES) == CLOCK)

    fun set(ctx: Context, clock: Boolean) {
        terminusPrefs(ctx).edit { putString(KEY, if (clock) CLOCK else MINUTES) }
        chosen.value = clock
    }
}
