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
        Quiet.after("/api/auth/app/start", "60")
        assertTrue(Quiet.blocked("/api/auth/app/poll"))
        assertTrue(Quiet.blocked("/api/pair/check"))
        // The widget's answers still go out.
        assertFalse(Quiet.blocked("/api/me/next"))
        assertEquals(0, Quiet.remainingMs())
    }

    @Test fun anAppWideLimitHoldsEverythingUntilRetryAfter() {
        Quiet.after("/api/me/next", "30")
        assertTrue(Quiet.blocked("/api/me/next"))
        assertTrue(Quiet.blocked("/api/auth/app/start"))
        assertEquals(30_000, Quiet.remainingMs())
        now += 30_000
        assertFalse(Quiet.blocked("/api/me/next"))
    }

    @Test fun waitsAreCappedAndDefaulted() {
        Quiet.after("/api/me/next", "99999")
        assertEquals(300_000, Quiet.remainingMs())
        Quiet.reset()
        Quiet.after("/api/me/next", null)
        assertEquals(60_000, Quiet.remainingMs())
    }

    @Test fun a503sRetryAfterSlowsThePollingWithoutBlocking() {
        Quiet.later("30")
        assertFalse(Quiet.blocked("/api/me/next"))
        assertEquals(30_000, Quiet.waitMs())
        // Without one, nothing changes.
        Quiet.reset()
        Quiet.later(null)
        assertEquals(0, Quiet.waitMs())
    }

    @Test fun refusedAsTooOldHoldsHalfAnHourThenTriesOnce() {
        assertFalse(Outdated.holding())
        Outdated.refused()
        assertTrue(Outdated.required)
        assertTrue(Outdated.holding())
        now += 29 * 60_000L
        assertTrue(Outdated.holding())
        now += 60_000L
        assertFalse(Outdated.holding())
        Outdated.served()
        assertFalse(Outdated.required)
    }

    /** As the server: signing in or out and leaving still go to an outdated app. */
    @Test fun anOutdatedAppCanStillSignOutAndLeave() {
        assertTrue(Outdated.gated("GET", "/api/me/next"))
        assertTrue(Outdated.gated("GET", "/api/me/next?lat=1.29"))
        assertTrue(Outdated.gated("POST", "/api/me/push"))
        assertTrue(Outdated.gated("GET", "/api/me"))
        assertFalse(Outdated.gated("DELETE", "/api/me/push"))
        assertFalse(Outdated.gated("DELETE", "/api/me"))
        assertFalse(Outdated.gated("POST", "/api/auth/logout"))
        assertFalse(Outdated.gated("POST", "/api/auth/anon"))
        assertFalse(Outdated.gated("POST", "/api/pair"))
        assertFalse(Outdated.gated("POST", "/api/pair/check"))
        assertFalse(Outdated.gated("GET", "/download/latest.json"))
        assertTrue(Outdated.gated("GET", "/api/campus"))
        assertTrue(Outdated.gated("GET", "/api/buses?svc=A1"))
        assertTrue(Outdated.gated("POST", "/api/me/pair-code"))
    }
}
