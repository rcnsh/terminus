package sh.rcn.terminus.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The window's width in dp, as it is now ([Widths]); 0, the phone layout, where nothing provides it (a widget, a preview). */
internal val LocalWindowDp = compositionLocalOf { 0f }

/** The window's width under [content], from the window itself, so a fold, a rotation or a resize lays it out again. */
@Composable
internal fun ProvideWindowWidth(content: @Composable () -> Unit) {
    val px = LocalWindowInfo.current.containerSize.width
    val dp = with(LocalDensity.current) { px.toDp().value }
    CompositionLocalProvider(LocalWindowDp provides dp, content = content)
}

/** Which layout the window's width calls for. */
@Composable internal fun windowWidth(): Width = Widths.of(LocalWindowDp.current)

/**
 * The page's column: as wide as there's room for up to [max], centred, its content still filling it. On a phone, where there's never more
 * room than [max], it's the full width as before.
 */
internal fun Modifier.column(max: Dp = Widths.COLUMN.dp): Modifier =
    fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = max).fillMaxWidth()
