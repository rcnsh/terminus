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

/**
 * A row or card in a list pane marked as the one open beside it: a rounded fill of the accent at low opacity just inside it, nothing else,
 * and said as selected. As the iPhone's and the web's.
 */
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

/** A card in a list pane marked as the one open beside it: the same fill, over the card's own surface, to its [radius] corners. */
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

/** How strong the chosen fill is: the brand colour at about 12%. */
private const val CHOSEN_ALPHA = 0.12f

/**
 * Two panes side by side, each with its band of the sky ([SkyBand]): every band's natural height, so each can grow to the tallest and their
 * horizons meet.
 */
internal class PaneSkies {
    private val heights = mutableStateMapOf<Any, Int>()

    /** The tallest band's height, in px. */
    val tallest: Int
        get() = heights.values.maxOrNull() ?: 0

    fun report(band: Any, px: Int) {
        if (heights[band] != px) heights[band] = px
    }

    fun gone(band: Any) {
        heights.remove(band)
    }
}

/** The pane a [SkyBand] is in, when two are side by side: their heights, and whether it's the leading one, which draws no moon or stars. */
internal class SkyPane(val skies: PaneSkies, val leading: Boolean)

internal val LocalSkyPane = compositionLocalOf<SkyPane?> { null }

/**
 * Where each page of a list-and-detail tab is scrolled to, by the page's own key, so a page keeps its place as the window goes from one
 * pane to two (a fold, a resize) and back. The page is drawn by the other layout in the same frame the first lets it go, before saved state
 * would be handed over, so the scroll state itself is shared, not saved and restored.
 */
internal class PaneScrolls {
    private val states = mutableMapOf<String, ScrollState>()

    /** The pages that last left ([keep]): drawn on while one peels away under a back swipe, then let go. */
    private val leaving = mutableMapOf<String, ScrollState>()
    private var open = emptySet<String>()

    /**
     * The pages open now, by key (a page's place in the stack with what it is): only these keep a scroll. A page that leaves is let go, so
     * opening it again starts at the top, as a page always opens.
     */
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

/** The page's scroll from its tab's [PaneScrolls] ([Keeps]), or its own where there's none. */
private val LocalPaneScroll = compositionLocalOf<ScrollState?> { null }

/** [content], a page whose scroll is kept under [key] in [scrolls]. */
@Composable
internal fun Keeps(scrolls: PaneScrolls, key: String, content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalPaneScroll provides scrolls.of(key), content = content)

/** A page's own scroll: kept by its tab across the window's layouts when it's in [Keeps]. */
@Composable internal fun rememberPaneScroll(): ScrollState = LocalPaneScroll.current ?: rememberScrollState()
