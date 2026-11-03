package sh.rcn.terminus.ui

import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.LaterBus
import sh.rcn.terminus.TestStrings
import sh.rcn.terminus.parseNearby

/** Nearby's rows as a stop's board, on the API's golden answer: where each bus is going, its next bus and the one after. */
class NearbyTextTest {
    init {
        TestStrings.install()
    }

    private val hhmm = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Singapore"))
    private val clock = { ms: Long -> hhmm.format(Instant.ofEpochMilli(ms)) }

    private val stops =
        parseNearby(
            JSONObject(
                listOf("../../../fixtures/answers", "../../fixtures/answers")
                    .map(::File)
                    .first { it.isDirectory }
                    .resolve("nearby-list.json")
                    .readText()
            )
        )

    private fun row(stop: String, svc: String) = stops.first { it.code == stop }.board.first { it.svc == svc }

    @Test
    fun aRowSaysWhereItsBusEndsUp() {
        assertEquals("to COM 3", NearbyText.to(row("PGPR", "D2")))
        assertEquals("Ends here", NearbyText.to(row("PGPR", "K")))
        // An older server, with no toText.
        assertEquals("Ends here", NearbyText.to(BoardRow("K", null, "scheduled")))
    }

    @Test
    fun minutesAreTheServersWords() {
        val d2 = row("PGPR", "D2")
        assertEquals(NearbyText.Time("4 min", "4 minutes, live"), NearbyText.next(d2, asClock = false, clock))
        assertEquals("14 min", NearbyText.then(d2, asClock = false, clock).text)
        assertEquals(
            "Bus D2, to COM 3, 4 minutes, live, then 14 minutes",
            NearbyText.said(d2, NearbyText.next(d2, false, clock), NearbyText.then(d2, false, clock)),
        )
    }

    @Test
    fun clockTimesAreTheBusesOwn() {
        val d2 = row("PGPR", "D2")
        assertEquals("09:04", NearbyText.next(d2, asClock = true, clock).text)
        assertEquals("09:14", NearbyText.then(d2, asClock = true, clock).text)
    }

    @Test
    fun aGuessKeepsItsTildeAsAClockTime() {
        val at = Instant.parse("2026-08-27T01:09:00Z").toEpochMilli()
        val r = BoardRow("A1", 540, "scheduled", eta = "~9 min", atMs = at, later = listOf(LaterBus(1140, "stale", atMs = at + 600_000)))
        assertEquals(NearbyText.Time("~09:09", "about 09:09"), NearbyText.next(r, asClock = true, clock))
        assertEquals("~09:19", NearbyText.then(r, asClock = true, clock).text)
        assertEquals("~9 min", NearbyText.next(r, asClock = false, clock).text)
    }

    @Test
    fun aBusTooSoonToCatchIsShownAndSaidSo() {
        val d2 = row("PGP", "D2")
        val next = NearbyText.next(d2, asClock = false, clock)
        assertTrue(next.tooSoon)
        assertEquals("4 minutes, live, too soon to catch", next.said)
        assertFalse(NearbyText.then(d2, asClock = false, clock).tooSoon)
    }

    @Test
    fun noBusIsADash() {
        val a2 = row("PGPR", "A2")
        assertEquals(NearbyText.Time("–", null), NearbyText.next(a2, asClock = true, clock))
        assertEquals(NearbyText.Time("–", null), NearbyText.then(a2, asClock = false, clock))
        assertNull(NearbyText.then(a2, false, clock).said)
        assertEquals(
            "Bus A2, to Kent Ridge Bus Terminal",
            NearbyText.said(a2, NearbyText.next(a2, false, clock), NearbyText.then(a2, false, clock)),
        )
    }
}
