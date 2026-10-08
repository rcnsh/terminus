package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.rcn.terminus.TestStrings

/**
 * A row's time worded on the phone, for an older server: Nearby and the
 * map's stop card both use [eta], so 4 min 30 s is "5 min" in both.
 */
class EtaTest {
    init { TestStrings.install() }

    @Test fun aRowsTimeRoundsToTheNearestMinute() {
        assertEquals("5 min", eta(270, "live"))
        assertEquals("4 min", eta(269, "live"))
        assertEquals("1 min", eta(50, "live"))
        assertEquals("now", eta(44, "live"))
        assertEquals("~5 min", eta(270, "scheduled"))
        assertEquals("–", eta(null, "unknown"))
    }
}
