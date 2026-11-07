package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The window's width picks the layout, at the same widths as the iPhone app and the web. */
class WidthsTest {
    @Test
    fun aPhoneUprightIsNarrow() {
        // Pixel 10 Pro, a small phone, and the widest phone held upright.
        for (dp in listOf(412f, 360f, 599.9f)) assertEquals(Width.Narrow, Widths.of(dp))
    }

    @Test
    fun fromSixHundredIsMedium() {
        // A tablet's split-screen half, a foldable open (Pixel 9 Pro Fold: 618 in portrait).
        for (dp in listOf(600f, 618f, 673f, 799f)) assertEquals(Width.Medium, Widths.of(dp))
    }

    @Test
    fun fromEightHundredIsWide() {
        // Pixel Tablet portrait (800) and landscape (1280), a phone on its side (915), the foldable open on its side.
        for (dp in listOf(800f, 841f, 915f, 1280f)) assertEquals(Width.Wide, Widths.of(dp))
    }

    @Test
    fun theRailComesWithMedium() {
        assertFalse(Widths.of(599f).rail)
        assertTrue(Widths.of(600f).rail)
        assertTrue(Widths.of(1280f).rail)
    }

    @Test
    fun theMapSheetFloatsFromSevenHundred() {
        assertFalse(Widths.floatingSheet(699f))
        assertTrue(Widths.floatingSheet(700f))
        assertTrue(Widths.floatingSheet(1280f))
    }

    @Test
    fun nowWidensItsColumnOnlyWhenWide() {
        assertEquals(560f, Widths.nowColumn(412f))
        assertEquals(560f, Widths.nowColumn(700f))
        assertEquals(1040f, Widths.nowColumn(800f))
    }

    @Test
    fun sheetsKeepToTheColumnFromMedium() {
        assertEquals(412f, Widths.sheetMax(412f))
        assertEquals(560f, Widths.sheetMax(600f))
        assertEquals(560f, Widths.sheetMax(1280f))
    }
}
