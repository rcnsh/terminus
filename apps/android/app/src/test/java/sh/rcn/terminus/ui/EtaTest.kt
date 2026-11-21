package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.rcn.terminus.TestStrings

class EtaTest {
    init {
        TestStrings.install()
    }

    @Test
    fun aRowsTimeRoundsToTheNearestMinute() {
        assertEquals("5 min", eta(270, "live"))
        assertEquals("4 min", eta(269, "live"))
        assertEquals("1 min", eta(50, "live"))
        assertEquals("now", eta(44, "live"))
        assertEquals("~5 min", eta(270, "scheduled"))
        assertEquals("–", eta(null, "unknown"))
    }

    @Test
    fun anEstimateIsNeverNow() {
        assertEquals("~1 min", eta(20, "scheduled"))
        assertEquals("~1 min", eta(0, "stale"))
        assertEquals("~1 min", eta(80, "scheduled"))
    }
}
