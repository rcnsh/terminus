package sh.rcn.terminus.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** The bar at the foot of the screen, for a page to offer Undo in (null outside the tabs). */
internal val LocalNotices = staticCompositionLocalOf<SnackbarHostState?> { null }

/** What a [NoticeBar] says: with [error], it's why something didn't take, marked in red rather than the accent. */
internal class Notice(
    override val message: String,
    override val actionLabel: String? = null,
    override val duration: SnackbarDuration = if (actionLabel == null) SnackbarDuration.Short else SnackbarDuration.Long,
    val error: Boolean = false,
) : SnackbarVisuals {
    override val withDismissAction: Boolean get() = false
}

/**
 * The bar a SnackbarHost shows, drawn as the app's own pieces are (a card
 * with a hairline round it, Transit.kt) rather than Material's inverted
 * slab: a stop's dot in the accent, the message, the action as a soft orange
 * pill, and a line along the foot running down to when it goes. It still
 * comes and goes as a snackbar does, waits longer for accessibility
 * services, and can be swiped away either way.
 */
@Composable
internal fun NoticeBar(data: SnackbarData) {
    val c = MaterialTheme.colorScheme
    val visuals = data.visuals
    val accent = if ((visuals as? Notice)?.error == true) c.error else c.primary
    val action = visuals.actionLabel
    // As long as the host will wait (SnackbarHost's own sums), so the line ends when the bar goes.
    val a11y = LocalAccessibilityManager.current
    val millis = remember(data) {
        val base = when (visuals.duration) {
            SnackbarDuration.Short -> 4_000L
            SnackbarDuration.Long -> 10_000L
            SnackbarDuration.Indefinite -> Long.MAX_VALUE
        }
        a11y?.calculateRecommendedTimeoutMillis(base, containsIcons = true, containsText = true, containsControls = action != null) ?: base
    }
    val left = remember(data) { Animatable(1f) }
    LaunchedEffect(data) {
        if (millis < Long.MAX_VALUE) left.animateTo(0f, tween(millis.toInt(), easing = LinearEasing))
    }
    val swipe = rememberSwipeToDismissBoxState()
    LaunchedEffect(swipe.currentValue) {
        if (swipe.currentValue != SwipeToDismissBoxValue.Settled) data.dismiss()
    }
    val shape = RoundedCornerShape(16.dp)
    SwipeToDismissBox(
        state = swipe,
        backgroundContent = {},
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp).widthIn(max = 560.dp),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .shadow(10.dp, shape, ambientColor = Color.Black.copy(alpha = 0.25f), spotColor = Color.Black.copy(alpha = 0.25f))
                .clip(shape)
                .background(c.surface)
                .border(1.dp, c.outlineVariant, shape)
                .drawBehind {
                    // What's left of the wait, along the foot.
                    val h = 2.dp.toPx()
                    drawRect(accent.copy(alpha = 0.55f), Offset(0f, size.height - h), Size(size.width * left.value, h))
                }
                .heightIn(min = 56.dp)
                .padding(start = 16.dp, end = if (action != null) 8.dp else 16.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.size(8.dp).background(accent, CircleShape))
            Text(
                visuals.message,
                color = c.onSurface,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                modifier = Modifier.weight(1f),
            )
            if (action != null) {
                Text(
                    action,
                    color = c.primary,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .clip(RoundedCornerShape(50))
                        .background(c.primaryContainer)
                        .clickable(role = Role.Button, onClick = data::performAction)
                        .heightIn(min = 40.dp)
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
}
