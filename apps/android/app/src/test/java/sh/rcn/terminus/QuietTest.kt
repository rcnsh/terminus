package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuietTest {
    private var now = 1_000_000L
    private val quiet = QuietGate({ now }, { now })
    private val outdated = OutdatedGate { now }

    @Test
    fun aSignInLimitHoldsBackOnlySignIn() {
        quiet.after("/api/auth/app/start", "60")
        assertTrue(quiet.blocked("/api/auth/app/poll"))
        assertTrue(quiet.blocked("/api/pair/check"))
        assertFalse(quiet.blocked("/api/me/next"))
        assertEquals(0, quiet.remainingMs())
    }

    @Test
    fun anAppWideLimitHoldsEverythingUntilRetryAfter() {
        quiet.after("/api/me/next", "30")
        assertTrue(quiet.blocked("/api/me/next"))
        assertTrue(quiet.blocked("/api/auth/app/start"))
        assertEquals(30_000, quiet.remainingMs())
        now += 30_000
        assertFalse(quiet.blocked("/api/me/next"))
    }

    @Test
    fun waitsAreCappedAndDefaulted() {
        quiet.after("/api/me/next", "99999")
        assertEquals(300_000, quiet.remainingMs())
        quiet.after("/api/me/next", null)
        assertEquals(60_000, quiet.remainingMs())
    }

    @Test
    fun a503sRetryAfterSlowsThePollingWithoutBlocking() {
        quiet.later("30")
        assertFalse(quiet.blocked("/api/me/next"))
        assertEquals(30_000, quiet.waitMs())
        val fresh = QuietGate({ now }, { now })
        fresh.later(null)
        assertEquals(0, fresh.waitMs())
    }

    @Test
    fun refusedAsTooOldHoldsHalfAnHourThenTriesOnce() {
        assertFalse(outdated.holding())
        outdated.refused()
        assertTrue(outdated.required)
        assertTrue(outdated.holding())
        now += 29 * 60_000L
        assertTrue(outdated.holding())
        now += 60_000L
        assertFalse(outdated.holding())
        outdated.served()
        assertFalse(outdated.required)
    }

    @Test
    fun anOutdatedAppCanStillSignOutAndLeave() {
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
