package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FirstFixTest {
    // COM3's stop, and points north of it (a degree of latitude is about 111 km).
    private val lat = 1.2949
    private val lon = 103.7749

    @Test
    fun theFreshFixIsSentWhenItCameInTimeElseTheOlderOneElseNone() {
        assertEquals("fresh", FirstFix.toSend("fresh", "older"))
        assertEquals("older", FirstFix.toSend(null, "older"))
        assertNull(FirstFix.toSend<String>(null, null))
    }

    @Test
    fun anAnswerSentWithoutAFixIsAskedAgainOnceOneComes() {
        assertTrue(FirstFix.reload(null, null, lat, lon))
    }

    @Test
    fun noFreshFixMeansNothingToAskAgainFrom() {
        assertFalse(FirstFix.reload(lat, lon, null, null))
        assertFalse(FirstFix.reload(null, null, null, null))
    }

    @Test
    fun aSentFixTheApiDropsCountsAsNone() {
        assertTrue(FirstFix.reload(lat, lon, lat, lon, 390.0))
        assertFalse(FirstFix.reload(lat, lon, lat, lon, 150.0))
    }

    @Test
    fun aFreshFixTheApiWouldDropTooAsksNothing() {
        assertFalse(FirstFix.reload(null, null, lat, lon, null, 500.0))
    }

    @Test
    fun onlyAFreshFixOverFiftyMetresAwayAsksAgain() {
        assertFalse(FirstFix.reload(lat, lon, lat, lon))
        // About 40 m: the same stops, the same answer.
        assertFalse(FirstFix.reload(lat, lon, lat + 0.00036, lon))
        // About 60 m.
        assertTrue(FirstFix.reload(lat, lon, lat + 0.00054, lon))
    }
}
