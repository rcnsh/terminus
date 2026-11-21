package sh.rcn.terminus.ui

internal enum class Width {
    Narrow,
    Medium,
    Wide;

    val rail: Boolean
        get() = this != Narrow
}

internal object Widths {
    const val MEDIUM_FROM = 600f
    const val WIDE_FROM = 800f

    const val SHORT_BELOW = 500f

    const val FLOATING_SHEET_FROM = 700f

    const val COLUMN = 560f

    const val WIDE_COLUMN = 1040f

    const val PANE = 360f

    fun of(dp: Float): Width =
        when {
            dp >= WIDE_FROM -> Width.Wide
            dp >= MEDIUM_FROM -> Width.Medium
            else -> Width.Narrow
        }

    fun short(heightDp: Float): Boolean = heightDp > 0f && heightDp < SHORT_BELOW

    fun notices(heightDp: Float): Notices = if (short(heightDp)) Notices.UnderCard else Notices.AboveChips

    fun upright(smallestWidthDp: Int): Boolean = smallestWidthDp > 0 && smallestWidthDp < MEDIUM_FROM

    fun floatingSheet(dp: Float): Boolean = dp >= FLOATING_SHEET_FROM

    fun nowColumn(dp: Float, day: Boolean): Float = if (of(dp) == Width.Wide && day) WIDE_COLUMN else COLUMN

    fun sheetMax(dp: Float): Float = if (of(dp) == Width.Narrow) dp else COLUMN
}

internal enum class Notices {
    AboveChips,
    UnderCard,
}
