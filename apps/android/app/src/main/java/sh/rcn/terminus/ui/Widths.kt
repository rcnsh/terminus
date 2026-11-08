package sh.rcn.terminus.ui

/**
 * How a window lays out, by its width in dp alone, read live: a fold, a rotation or a resized window changes it mid-session. The device,
 * its screen and the orientation never decide (docs/agents/window-sizes.md, ADR 0015).
 */
internal enum class Width {
    /** The phone layout. */
    Narrow,

    /** The phone layout in the centred [Widths.COLUMN], the sky still edge to edge. */
    Medium,

    /** Two panes on Now, Stops and Settings. */
    Wide;

    /** A navigation rail on the leading edge in place of the bottom bar: Material's own threshold. */
    val rail: Boolean
        get() = this != Narrow
}

internal object Widths {
    const val MEDIUM_FROM = 600f
    const val WIDE_FROM = 800f

    /**
     * A window shorter than this is short, whatever its width (a phone on its side): the top of the page goes compact, the low horizon on
     * Now, the wordmark on the chips' row, notices under the card, the bands without their hills. Nothing else about the layout changes.
     */
    const val SHORT_BELOW = 500f

    /** From here a stop's or bus's sheet on the map floats in the bottom-left corner rather than lying across the bottom. */
    const val FLOATING_SHEET_FROM = 700f

    /** The page's column, gutters included: the web app's. */
    const val COLUMN = 560f

    /** Now's column when wide: the card and Today side by side. */
    const val WIDE_COLUMN = 1040f

    /** The list pane of Stops and Settings when wide, and the map's floating sheet. */
    const val PANE = 360f

    fun of(dp: Float): Width =
        when {
            dp >= WIDE_FROM -> Width.Wide
            dp >= MEDIUM_FROM -> Width.Medium
            else -> Width.Narrow
        }

    /** Whether a window [heightDp] tall is short ([SHORT_BELOW]); 0, nothing to go by (a widget, a preview), is not. */
    fun short(heightDp: Float): Boolean = heightDp > 0f && heightDp < SHORT_BELOW

    /**
     * Where Now's notices (the location prompt, an update) go in a window [heightDp] tall: under the card when short, so the answer comes
     * first.
     */
    fun notices(heightDp: Float): Notices = if (short(heightDp)) Notices.UnderCard else Notices.AboveChips

    fun floatingSheet(dp: Float): Boolean = dp >= FLOATING_SHEET_FROM

    /** How wide Now's words go in a window [dp] wide: beside Today when wide and there's a [day], else lined up with the card alone. */
    fun nowColumn(dp: Float, day: Boolean): Float = if (of(dp) == Width.Wide && day) WIDE_COLUMN else COLUMN

    /** The widest a sheet or dialog goes in a window [dp] wide: the column from medium, else the window's own. */
    fun sheetMax(dp: Float): Float = if (of(dp) == Width.Narrow) dp else COLUMN
}

/** Where Now's notices sit ([Widths.notices]). */
internal enum class Notices {
    /** Between the wordmark and the chips, as in a tall window. */
    AboveChips,

    /** Just under the card's buttons: in two panes, the foot of the card's column. */
    UnderCard,
}
