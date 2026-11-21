package sh.rcn.terminus

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerClockTest {
    private val at = Instant.parse("2026-10-07T01:00:00Z").toEpochMilli()
    private val date = "Wed, 07 Oct 2026 01:00:00 GMT"

    private val clock = ClockSkew { at }

    @Test
    fun aPhoneThatIsBehindIsMovedOn() {
        assertEquals(120_000L, clock.skewOf(date, at - 120_000))
        assertEquals(-90_000L, clock.skewOf(date, at + 90_000))
    }

    @Test
    fun underThreeSecondsIsDatesRoundingNotAWrongClock() {
        assertEquals(0L, clock.skewOf(date, at - 2_999))
        assertEquals(0L, clock.skewOf(date, at + 2_500))
        assertEquals(3_000L, clock.skewOf(date, at - 3_000))
    }

    @Test
    fun noDateNoChange() {
        assertNull(clock.skewOf(null, at))
        assertNull(clock.skewOf("yesterday", at))
        clock.observe(date, at - 60_000)
        clock.observe("yesterday", at)
        assertEquals(60_000L, clock.skewMs)
    }

    @Test
    fun aCachedReplySaysNothing() {
        clock.observe(date, at - 60_000, cached = true)
        assertEquals(0L, clock.skewMs)
    }

    @Test
    fun serverTimesBecomePhoneTimesForAlarms() {
        clock.observe(date, at - 60_000)
        assertEquals(at - 60_000, clock.toDevice(at))
        assertEquals(at, clock.fromDevice(at - 60_000))
        assertEquals(at + 60_000, clock.now())
        clock.observe(date, at - 1_000)
        assertEquals(0L, clock.skewMs)
    }
}
