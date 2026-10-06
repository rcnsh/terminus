package sh.rcn.terminus.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat

/*
 * Done for today's night: a sky behind the top of Now, from the status bar
 * down to the end of the night section (the headline and the next class),
 * then fading into the page. The section says where it ends ([SkyState]);
 * Now draws the sky and puts what's over it (the header, the chips, the
 * status bar's icons) in night colours while it's there.
 */

/** Where the night section ends, for the sky behind it. Null: no night, no sky. */
@Stable
internal class SkyState {
    /** The top of Now's scrolling content, in root pixels. */
    var contentTop by mutableFloatStateOf(0f)

    /** The bottom of the night section, in root pixels; null when it isn't shown. */
    var sectionBottom by mutableStateOf<Float?>(null)

    /** How far down the content the sky goes, in pixels, or null for none. */
    val end: Float? get() = sectionBottom?.let { it - contentTop }
}

/** The sky Now draws, for the night section to report to. Null outside Now. */
internal val LocalSky = staticCompositionLocalOf<SkyState?> { null }

internal val NIGHT = listOf(Color(0xFF121A33), Color(0xFF181A30), Color(0xFF1C1B26))
internal val NIGHT_INK = Color(0xFFF2EFEB)
internal val NIGHT_SUB = Color(0xFFC9C3BD)
internal val MOON = Color(0xFFFDE9C9)

/** Across (0–1), down (0–1.05 of the room above the headline), brightness and size in dp. Fixed, so they never twinkle into a distraction. */
private val STARS = listOf(
    floatArrayOf(0.06f, 0.30f, 0.7f, 1.3f), floatArrayOf(0.17f, 0.62f, 0.5f, 1.1f), floatArrayOf(0.29f, 0.18f, 0.8f, 1.4f),
    floatArrayOf(0.38f, 0.80f, 0.4f, 1.0f), floatArrayOf(0.47f, 0.42f, 0.6f, 1.2f), floatArrayOf(0.55f, 0.10f, 0.5f, 1.0f),
    floatArrayOf(0.63f, 0.68f, 0.45f, 1.1f), floatArrayOf(0.72f, 0.28f, 0.7f, 1.3f), floatArrayOf(0.84f, 0.88f, 0.4f, 1.0f),
    floatArrayOf(0.92f, 0.50f, 0.55f, 1.2f), floatArrayOf(0.11f, 0.95f, 0.35f, 1.0f), floatArrayOf(0.33f, 1.05f, 0.4f, 1.1f),
    floatArrayOf(0.58f, 0.98f, 0.3f, 1.0f), floatArrayOf(0.97f, 0.16f, 0.45f, 1.1f),
)

/** Under the sky's end, the fade into the page. */
private val FADE = 72.dp

/** The sky behind the content, while the night section is shown; nothing otherwise. */
internal fun Modifier.nightSky(sky: SkyState, page: Color): Modifier = drawBehind {
    val end = sky.end ?: return@drawBehind
    val fade = FADE.toPx()
    val h = end + fade
    drawRect(
        Brush.verticalGradient(0f to NIGHT[0], (end * 0.55f / h) to NIGHT[1], (end / h) to NIGHT[2], 1f to page, endY = h),
        size = Size(size.width, h),
    )
}

/** The stars over the night section, in the room above its headline (clear of the chips, which show the sky through them), and the moon among them. */
internal fun DrawScope.starsAndMoon(room: Float) {
    for ((x, y, a, r) in STARS) drawCircle(Color.White.copy(alpha = a), r.dp.toPx(), Offset(size.width * x, room * 0.85f * y / 1.05f + 4.dp.toPx()))
    crescent(Offset(size.width - 44.dp.toPx(), room * 0.48f), 28.dp.toPx())
}

private operator fun FloatArray.component4() = this[3]

/** A crescent moon centred at [c], of radius [r]: a disc with a slightly smaller one taken out up and to the right. */
internal fun DrawScope.crescent(c: Offset, r: Float) {
    val moon = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c, r)) }
    val bite = Path().apply { addOval(androidx.compose.ui.geometry.Rect(c + Offset(r * 0.46f, -r * 0.3f), r * 0.9f)) }
    drawPath(Path.combine(PathOperation.Difference, moon, bite), MOON)
}

/**
 * [content] in night colours when [on] (the dark scheme, whatever the
 * phone's theme), else as it is. Always the same tree, so nothing inside
 * loses its state when night comes or goes.
 */
@Composable
internal fun NightTheme(on: Boolean, content: @Composable () -> Unit) {
    val scheme = if (on) BrandDark else MaterialTheme.colorScheme
    MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography, shapes = MaterialTheme.shapes) {
        CompositionLocalProvider(LocalContentColor provides if (on) scheme.onBackground else LocalContentColor.current, content = content)
    }
}

/** Light status bar icons over the night sky, back to the theme's when it goes. */
@Composable
internal fun NightStatusBar(night: Boolean) {
    val view = LocalView.current
    val dark = isSystemInDarkTheme()
    if (view.isInEditMode) return
    DisposableEffect(night, dark) {
        val window = view.context.activity()?.window
        val bars = window?.let { WindowCompat.getInsetsController(it, view) }
        bars?.isAppearanceLightStatusBars = !dark && !night
        onDispose { bars?.isAppearanceLightStatusBars = !dark }
    }
}

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
