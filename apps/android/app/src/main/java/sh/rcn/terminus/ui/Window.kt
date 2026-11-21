package sh.rcn.terminus.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal val LocalWindowDp = compositionLocalOf { 0f }

internal val LocalWindowHeightDp = compositionLocalOf { 0f }

@Composable
internal fun ProvideWindowWidth(content: @Composable () -> Unit) {
    val size = LocalWindowInfo.current.containerSize
    val (w, h) = with(LocalDensity.current) { size.width.toDp().value to size.height.toDp().value }
    CompositionLocalProvider(LocalWindowDp provides w, LocalWindowHeightDp provides h, content = content)
}

@Composable internal fun windowWidth(): Width = Widths.of(LocalWindowDp.current)

@Composable internal fun windowShort(): Boolean = Widths.short(LocalWindowHeightDp.current)

internal fun Modifier.column(max: Dp = Widths.COLUMN.dp): Modifier =
    fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = max).fillMaxWidth()

@Composable
internal fun Modifier.chosen(on: Boolean): Modifier {
    if (!on) return this
    val fill = MaterialTheme.colorScheme.primary.copy(alpha = CHOSEN_ALPHA)
    return drawBehind {
        val inset = 4.dp.toPx()
        drawRoundRect(fill, Offset(inset, inset), Size(size.width - 2 * inset, size.height - 2 * inset), CornerRadius(12.dp.toPx()))
    }
        .semantics { selected = true }
}

@Composable
internal fun Modifier.chosenCard(on: Boolean, radius: Dp): Modifier {
    if (!on) return this
    val fill = MaterialTheme.colorScheme.primary.copy(alpha = CHOSEN_ALPHA)
    return drawWithContent {
        drawContent()
        drawRoundRect(fill, cornerRadius = CornerRadius(radius.toPx()))
    }
        .semantics { selected = true }
}

private const val CHOSEN_ALPHA = 0.12f

internal class PaneSkies {
    private val heights = mutableStateMapOf<Any, Int>()

    val tallest: Int
        get() = heights.values.maxOrNull() ?: 0

    fun report(band: Any, px: Int) {
        if (heights[band] != px) heights[band] = px
    }

    fun gone(band: Any) {
        heights.remove(band)
    }
}

internal class SkyPane(val skies: PaneSkies, val leading: Boolean)

internal val LocalSkyPane = compositionLocalOf<SkyPane?> { null }

internal class PaneScrolls {
    private val states = mutableMapOf<String, ScrollState>()

    private val leaving = mutableMapOf<String, ScrollState>()
    private var open = emptySet<String>()

    fun keep(keys: Set<String>) {
        if (keys == open) return
        leaving.clear()
        states.filterKeys { it !in keys }.let(leaving::putAll)
        states.keys.retainAll(keys)
        open = keys
    }

    fun of(key: String): ScrollState =
        if (key in open) states.getOrPut(key) { ScrollState(0) } else leaving.getOrPut(key) { ScrollState(0) }

    companion object {
        val Saver: Saver<PaneScrolls, Any> =
            Saver(
                save = { p -> p.states.flatMap { (k, v) -> listOf(k, v.value) } },
                restore = { saved ->
                    PaneScrolls().apply {
                        (saved as List<*>).chunked(2).forEach { (k, v) -> states[k as String] = ScrollState(v as Int) }
                        open = states.keys.toSet()
                    }
                },
            )
    }
}

@Composable internal fun rememberPaneScrolls(): PaneScrolls = rememberSaveable(saver = PaneScrolls.Saver) { PaneScrolls() }

private val LocalPaneScroll = compositionLocalOf<ScrollState?> { null }

@Composable
internal fun Keeps(scrolls: PaneScrolls, key: String, content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalPaneScroll provides scrolls.of(key), content = content)

@Composable internal fun rememberPaneScroll(): ScrollState = LocalPaneScroll.current ?: rememberScrollState()
