package sh.rcn.terminus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/** The phone's clock error, from the API's `Date` header. */
class ServerClockTest {
    private val at = Instant.parse("2026-10-07T01:00:00Z").toEpochMilli()
    private val date = "Wed, 07 Oct 2026 01:00:00 GMT"

    @After fun clear() = ServerClock.reset()

    @Test fun aPhoneThatIsBehindIsMovedOn() {
        // The phone says 00:58:00 when the server says 01:00:00.
        assertEquals(120_000L, ServerClock.skewOf(date, at - 120_000))
        assertEquals(-90_000L, ServerClock.skewOf(date, at + 90_000))
    }

    @Test fun underThreeSecondsIsDatesRoundingNotAWrongClock() {
        assertEquals(0L, ServerClock.skewOf(date, at - 2_999))
        assertEquals(0L, ServerClock.skewOf(date, at + 2_500))
        assertEquals(3_000L, ServerClock.skewOf(date, at - 3_000))
    }

    @Test fun noDateNoChange() {
        assertNull(ServerClock.skewOf(null, at))
        assertNull(ServerClock.skewOf("yesterday", at))
        ServerClock.observe(date, at - 60_000)
        ServerClock.observe("yesterday", at)
        assertEquals(60_000L, ServerClock.skewMs)
    }

    @Test fun aCachedReplySaysNothing() {
        ServerClock.observe(date, at - 60_000, cached = true)
        assertEquals(0L, ServerClock.skewMs)
    }

    @Test fun serverTimesBecomePhoneTimesForAlarms() {
        ServerClock.observe(date, at - 60_000)
        assertEquals(at - 60_000, ServerClock.toDevice(at))
        assertEquals(at, ServerClock.fromDevice(at - 60_000))
        val now = ServerClock.now() - System.currentTimeMillis()
        assertEquals(60_000.0, now.toDouble(), 50.0)
        // Put right later: back to the phone's own clock.
        ServerClock.observe(date, at - 1_000)
        assertEquals(0L, ServerClock.skewMs)
    }
}
