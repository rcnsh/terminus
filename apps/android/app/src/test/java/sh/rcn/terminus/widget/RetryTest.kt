package sh.rcn.terminus.widget

import org.junit.Assert.assertEquals
import org.junit.Test

/** A failed background refresh is tried again soon, then less often, never more than 15 minutes apart. */
class RetryTest {
    @Test fun backsOffToFifteenMinutes() {
        assertEquals(listOf(1, 2, 4, 8, 15, 15, 15), (0..6).map { (retryDelay(it) / 60_000).toInt() })
    }

    @Test fun aLongRunOfFailuresStaysAtTheCap() {
        assertEquals(15 * 60_000L, retryDelay(1_000))
    }

    @Test fun aRetryKeepsItsBackOffAndWaitsOutRetryAfter() {
        val now = 1_790_000_000_000L
        assertEquals(now + 60_000, retryAt(now, 0, 0))
        assertEquals(now + 8 * 60_000, retryAt(now, 3, 0))
        // A 429's two minutes beat the first minute's back-off.
        assertEquals(now + 120_000, retryAt(now, 0, 120_000))
    }
}
