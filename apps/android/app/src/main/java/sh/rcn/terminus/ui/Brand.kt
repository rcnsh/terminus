package sh.rcn.terminus.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle

/**
 * The site's tokens (apps/web/public/assets/site.css), so the app, the widget
 * and the web look like one product rather than taking the wallpaper's colours.
 * `tertiary` is the warning amber: "tight" must not look like "on time".
 */
val BrandLight = lightColorScheme(
    primary = Color(0xFFC2410C), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFF1E6), onPrimaryContainer = Color(0xFF7C2D12),
    secondary = Color(0xFF6B6560), onSecondary = Color.White,
    secondaryContainer = Color(0xFFF5F4F2), onSecondaryContainer = Color(0xFF1C1917),
    tertiary = Color(0xFF92400E), onTertiary = Color.White,
    error = Color(0xFFB91C1C), onError = Color.White,
    background = Color(0xFFFAFAF9), onBackground = Color(0xFF1C1917),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF1C1917),
    surfaceVariant = Color(0xFFF5F4F2), onSurfaceVariant = Color(0xFF6B6560),
    surfaceContainerHighest = Color(0xFFF5F4F2), surfaceContainerHigh = Color(0xFFF5F4F2),
    surfaceContainer = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFFFFFFF),
    outline = Color(0xFF8A847E), outlineVariant = Color(0xFFE7E5E2),
)

val BrandDark = darkColorScheme(
    primary = Color(0xFFFB923C), onPrimary = Color(0xFF1C1917),
    primaryContainer = Color(0xFF2A1A0E), onPrimaryContainer = Color(0xFFFED7AA),
    secondary = Color(0xFFA39D97), onSecondary = Color(0xFF1C1917),
    secondaryContainer = Color(0xFF2C2926), onSecondaryContainer = Color(0xFFF2EFEB),
    tertiary = Color(0xFFFBBF24), onTertiary = Color(0xFF1C1917),
    error = Color(0xFFF87171), onError = Color(0xFF1C1917),
    background = Color(0xFF0F0E0D), onBackground = Color(0xFFF2EFEB),
    surface = Color(0xFF1A1816), onSurface = Color(0xFFF2EFEB),
    surfaceVariant = Color(0xFF211F1C), onSurfaceVariant = Color(0xFFA39D97),
    surfaceContainerHighest = Color(0xFF211F1C), surfaceContainerHigh = Color(0xFF211F1C),
    surfaceContainer = Color(0xFF1A1816), surfaceContainerLow = Color(0xFF1A1816),
    outline = Color(0xFF6F6964), outlineVariant = Color(0xFF2C2926),
)

/** "termi" + "nus" in the accent, as on the site. */
@Composable
fun Wordmark(style: TextStyle) {
    val accent = MaterialTheme.colorScheme.primary
    Text(
        buildAnnotatedString {
            append("termi")
            withStyle(SpanStyle(color = accent)) { append("nus") }
        },
        style = style.copy(fontWeight = FontWeight.Bold),
    )
}

/** One vocabulary everywhere, matching the API's detail line. */
fun crowdWord(c: String?) = when (c) {
    "low" -> "Quiet"
    "medium" -> "Filling"
    "high" -> "Packed"
    else -> null
}

/** The same notes the Mac and web show for each data quality. */
fun qualityNote(q: String) = when (q) {
    "scheduled" -> "Timetable estimate"
    "stale" -> "Live data a few minutes old"
    "unknown" -> "No live data"
    else -> null
}
