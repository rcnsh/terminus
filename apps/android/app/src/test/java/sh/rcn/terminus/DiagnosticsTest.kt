package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiagnosticsTest {
    private val now = 1_792_300_000_000L

    @Test
    fun theLogKeepsThePathNeverTheQuery() {
        RequestLog.clear()
        RequestLog.record("GET", "/api/me/next?lat=1.29661&lon=103.77628", "https://terminus.run", 200, 143, null, now)
        val e = RequestLog.entries().single()
        assertEquals("/api/me/next", e.path)
        assertEquals("terminus.run", e.host)
        assertFalse(Diagnostics.entry(e).contains("lat"))
    }

    @Test
    fun theLogKeepsTheNewestFifty() {
        RequestLog.clear()
        repeat(RequestLog.MAX + 5) { RequestLog.record("GET", "/api/campus/$it", "https://terminus.run", 200, 1, null, now + it) }
        val all = RequestLog.entries()
        assertEquals(RequestLog.MAX, all.size)
        assertEquals("/api/campus/${RequestLog.MAX + 4}", all.first().path)
        assertEquals("/api/campus/5", all.last().path)
    }

    @Test
    fun aRequestWithNoAnswerSaysWhy() {
        val failed = RequestLog.Entry(now, "GET", "/api/me/next", "terminus.run", null, 2_000, "UnknownHostException")
        assertEquals("UnknownHostException", Diagnostics.outcome(failed))
        assertEquals("no answer", Diagnostics.outcome(failed.copy(failure = null)))
        assertEquals("304", Diagnostics.outcome(failed.copy(status = 304)))
    }

    @Test
    fun timesAreSaidPlainly() {
        assertEquals("right", Diagnostics.skew(0))
        assertEquals("+42 s", Diagnostics.skew(42_000))
        assertEquals("-5 s", Diagnostics.skew(-5_400))
        assertNull(Diagnostics.ago(0, now))
        assertEquals("12 s ago", Diagnostics.ago(now - 12_000, now))
        assertEquals("3 min ago", Diagnostics.ago(now - 200_000, now))
        assertEquals("5 h ago", Diagnostics.ago(now - 5 * 3_600_000L, now))
        assertEquals("3 d ago", Diagnostics.ago(now - 3 * 86_400_000L, now))
        // Singapore's time, whatever the phone's zone.
        assertEquals("2026-10-18 13:06:40", Diagnostics.stamp(now))
    }

    @Test
    fun theReportCarriesTheStateAndTheRequests() {
        val facts =
            Diagnostics.Facts(
                version = "3.6.0",
                build = 100,
                flavor = "stable",
                debug = false,
                android = "16 (API 36)",
                device = "Google Pixel 9",
                language = "en",
                server = "https://terminus.run",
                skewMs = 0,
                signedIn = true,
                anonymous = true,
                notifications = true,
                leaveAlerts = true,
                liveUpdates = false,
                exactAlarms = false,
                batteryUnrestricted = null,
                pushAvailable = true,
                pushActive = false,
                pushSentAt = now - 60_000,
                pushHeardAt = 0,
                refreshAlarmAt = 0,
                answerAt = now - 30_000,
                quality = "live",
                staleAt = null,
                remindAt = null,
                lastError = null,
            )
        val req = RequestLog.Entry(now, "GET", "/api/me/next", "terminus.run", 200, 143)
        val text = Diagnostics.report(facts, listOf(req), now)
        assertTrue(text.startsWith("terminus: 3.6.0 (100) stable\n"))
        assertTrue("signed in: anonymous\n" in text)
        assertTrue("exact alarms: no\n" in text)
        assertTrue("battery unrestricted: -\n" in text)
        assertTrue("push: not active\n" in text)
        assertTrue("push heard: -\n" in text)
        assertTrue("answer: 30 s ago\n" in text)
        assertTrue(text.endsWith("13:06:40 GET /api/me/next terminus.run 200 143 ms\n"))
        assertTrue(Diagnostics.report(facts, emptyList(), now).endsWith("requests (newest first):\nnone\n"))
    }
}
