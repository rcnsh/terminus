package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WidthsTest {
    @Test
    fun aPhoneUprightIsNarrow() {
        for (dp in listOf(412f, 360f, 599.9f)) assertEquals(Width.Narrow, Widths.of(dp))
    }

    @Test
    fun fromSixHundredIsMedium() {
        for (dp in listOf(600f, 618f, 673f, 799f)) assertEquals(Width.Medium, Widths.of(dp))
    }

    @Test
    fun fromEightHundredIsWide() {
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
    fun nowWidensItsColumnOnlyWhenWideWithADay() {
        assertEquals(560f, Widths.nowColumn(412f, day = true))
        assertEquals(560f, Widths.nowColumn(700f, day = true))
        assertEquals(1040f, Widths.nowColumn(800f, day = true))
        assertEquals(560f, Widths.nowColumn(1280f, day = false))
    }

    @Test
    fun sheetsKeepToTheColumnFromMedium() {
        assertEquals(412f, Widths.sheetMax(412f))
        assertEquals(560f, Widths.sheetMax(600f))
        assertEquals(560f, Widths.sheetMax(1280f))
    }

    @Test
    fun underFiveHundredTallIsShort() {
        for (dp in listOf(412f, 360f, 499.9f)) assertTrue(Widths.short(dp))
        for (dp in listOf(500f, 915f, 800f, 1280f)) assertFalse(Widths.short(dp))
    }

    @Test
    fun noHeightToGoByIsNotShort() {
        assertFalse(Widths.short(0f))
    }

    @Test
    fun shortIsIndependentOfWidth() {
        assertEquals(Width.Wide, Widths.of(915f))
        assertTrue(Widths.short(412f))
    }

    @Test
    fun noticesGoUnderTheCardWhenShort() {
        assertEquals(Notices.UnderCard, Widths.notices(412f))
        assertEquals(Notices.AboveChips, Widths.notices(915f))
        assertEquals(Notices.AboveChips, Widths.notices(0f))
    }

    @Test
    fun aPhoneStaysUprightAndATabletTurns() {
        for (dp in listOf(412, 360, 599)) assertTrue(Widths.upright(dp))
        for (dp in listOf(600, 701, 800, 0)) assertFalse(Widths.upright(dp))
    }
}
