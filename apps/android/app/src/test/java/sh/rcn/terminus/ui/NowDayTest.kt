package sh.rcn.terminus.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan

/** Whether Now has a day to show beside the card when wide. */
class NowDayTest {
    private val item =
        DayItem("class", "k", "GEA1000", "next", "PGP", "UTown", 1_000L, null, null, false, "D2", timingText = null, timingStatus = null)
    private val removed = TodayNote(item, 0, null)

    @Test fun aDayWithItemsIsOne() = assertTrue(UiState(day = DayPlan(listOf(item), null)).hasDay)

    @Test fun aDayEmptiedWithItsUndoShowingIsStillOne() = assertTrue(UiState(day = DayPlan(emptyList(), null), removed = removed).hasDay)

    @Test
    fun aRemovalWithNoDayIsNot() {
        assertFalse(UiState(day = null, removed = removed).hasDay)
        assertFalse(UiState(day = DayPlan(emptyList(), null)).hasDay)
    }
}
