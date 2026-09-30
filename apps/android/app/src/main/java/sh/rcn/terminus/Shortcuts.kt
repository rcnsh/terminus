package sh.rcn.terminus

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import sh.rcn.terminus.ui.MainActivity

/**
 * Long-press on the app icon (phase 6): Next, each saved place, and Nearby,
 * opening the app on that answer through the same terminus:// links the
 * widget's chips use. Rebuilt only when the places change.
 */
object Shortcuts {
    fun update(ctx: Context, places: List<Place>) {
        // Launchers show four at most (Pixel's shows the first four by rank), so
        // four, with Nearby last, rather than Nearby lost behind a third place.
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx).coerceIn(3, 4)
        // Next and Nearby always; as many places as fit between them.
        val wanted = buildList {
            add(Triple("next", "Next", MainActivity.intentFor(ctx)))
            places.take(max - 2).forEach { add(Triple("place:${it.key}", it.label, MainActivity.intentFor(ctx, place = it.key))) }
            add(Triple("nearby", "Nearby", MainActivity.intentFor(ctx, nearby = true)))
        }
        val current = ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id to it.shortLabel.toString() }
        if (current == wanted.map { it.first to it.second }) return
        val icon = IconCompat.createWithResource(ctx, R.drawable.ic_shortcut)
        val shortcuts = wanted.mapIndexed { rank, (id, label, intent) ->
            ShortcutInfoCompat.Builder(ctx, id)
                .setShortLabel(label)
                .setLongLabel(if (id == "next") "Next class" else if (id == "nearby") "Buses nearby" else "Bus to $label")
                .setIcon(icon)
                .setIntent(intent.setAction(Intent.ACTION_VIEW))
                .setRank(rank)
                .build()
        }
        runCatching { ShortcutManagerCompat.setDynamicShortcuts(ctx, shortcuts) }
    }
}
