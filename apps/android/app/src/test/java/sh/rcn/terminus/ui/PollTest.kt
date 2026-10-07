package sh.rcn.terminus.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import sh.rcn.terminus.NextAnswer
import java.time.Instant

/** When Now fetches its answer again: every 30 s, or sooner when the server says the card changes. */
class PollTest {
    private val polled = Instant.parse("2026-08-27T01:00:00Z").toEpochMilli()
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    private fun answer(nextChange: Long?, refresh: Long? = null) = NextAnswer.parse(
        JSONObject().put("label", "D2 · 09:04").put("mode", "trip")
            .apply { refresh?.let { put("refreshAt", iso(it)) } }
            .put("card", JSONObject().put("kind", "trip").apply { nextChange?.let { put("nextChangeAt", iso(it)) } }),
    )

    @Test fun everyThirtySecondsWithNothingSooner() {
        assertEquals(polled + POLL_MS, nextPollAt(null, polled))
        assertEquals(polled + POLL_MS, nextPollAt(answer(null), polled))
        assertEquals(polled + POLL_MS, nextPollAt(answer(polled + 5 * 60_000), polled))
    }

    @Test fun atTheSoonerOfTheServersMarks() {
        assertEquals(polled + 12_000, nextPollAt(answer(polled + 12_000), polled))
        assertEquals(polled + 9_000, nextPollAt(answer(polled + 12_000, refresh = polled + 9_000), polled))
    }

    @Test fun neverWithinFiveSecondsNorForAMomentAlreadyPast() {
        assertEquals(polled + POLL_MIN_MS, nextPollAt(answer(polled + 1_000), polled))
        assertEquals(polled + POLL_MS, nextPollAt(answer(polled - 1_000), polled))
    }
}
