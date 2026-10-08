package sh.rcn.terminus

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The waits after a 429 or a 503, and after a 426. */
class QuietTest {
    private var now = 1_000_000L

    @Before fun clock() {
        Quiet.elapsed = { now }
        Quiet.wall = { now }
        Quiet.reset()
        Outdated.wall = { now }
        Outdated.reset()
    }

    @After fun done() {
        Quiet.reset()
        Outdated.reset()
    }

    @Test fun aSignInLimitHoldsBackOnlySignIn() {
        Quiet.after("/auth/app/start", "60")
        assertTrue(Quiet.blocked("/auth/app/poll"))
        assertTrue(Quiet.blocked("/pair/check"))
        // The widget's answers still go out.
        assertFalse(Quiet.blocked("/me/next"))
        assertEquals(0, Quiet.remainingMs())
    }

    @Test fun anAppWideLimitHoldsEverythingUntilRetryAfter() {
        Quiet.after("/me/next", "30")
        assertTrue(Quiet.blocked("/me/next"))
        assertTrue(Quiet.blocked("/auth/app/start"))
        assertEquals(30_000, Quiet.remainingMs())
        now += 30_000
        assertFalse(Quiet.blocked("/me/next"))
    }

    @Test fun waitsAreCappedAndDefaulted() {
        Quiet.after("/me/next", "99999")
        assertEquals(300_000, Quiet.remainingMs())
        Quiet.reset()
        Quiet.after("/me/next", null)
        assertEquals(60_000, Quiet.remainingMs())
    }

    @Test fun a503sRetryAfterSlowsThePollingWithoutBlocking() {
        Quiet.later("30")
        assertFalse(Quiet.blocked("/me/next"))
        assertEquals(30_000, Quiet.waitMs())
        // Without one, nothing changes.
        Quiet.reset()
        Quiet.later(null)
        assertEquals(0, Quiet.waitMs())
    }

    @Test fun refusedAsTooOldHoldsForHoursThenTriesOnce() {
        assertFalse(Outdated.holding())
        Outdated.refused()
        assertTrue(Outdated.required)
        assertTrue(Outdated.holding())
        now += 6 * 3_600_000L
        assertFalse(Outdated.holding())
        Outdated.served()
        assertFalse(Outdated.required)
    }
}
