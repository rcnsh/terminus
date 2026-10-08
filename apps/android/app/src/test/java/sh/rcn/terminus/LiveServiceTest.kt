package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** What the live notification's header counts down to. */
class LiveServiceTest {
    init { TestStrings.install() }

    private fun golden(name: String): NextAnswer {
        val dir = listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }
        return NextAnswer.parse(JSONObject(File(dir, "$name.json").readText()))
    }

    @Test fun onTheBusItIsGettingOff() {
        val a = golden("riding")
        val ride = a.card?.ride!!
        assertEquals(ride.arriveMs, LiveService.countdownAt(a))
    }

    @Test fun forAClassItIsTheLeaveBy() {
        val a = golden("class-bus")
        assertNotNull(a.leaveAtMs)
        assertEquals(a.leaveAtMs, LiveService.countdownAt(a))
    }

    @Test fun otherwiseItIsTheBus() {
        val a = golden("place")
        assertNotNull(a.departsAtMs)
        assertEquals(a.departsAtMs, LiveService.countdownAt(a))
    }

    @Test fun atTheStopItIsTheBusNotTheLeaveTime() {
        // A class's leave-by is behind you at the stop: the bus the headline names.
        val json = JSONObject(File(listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }, "class-bus.json").readText())
        json.getJSONObject("card").put("phase", "waiting")
        val a = NextAnswer.parse(json)
        val board = a.card?.journey?.boardAtMs
        assertNotNull(board)
        assertNotEquals(a.leaveAtMs, board)
        assertEquals(board, LiveService.countdownAt(a))
        // A trip at the stop: its journey's bus too.
        val t = golden("last-bus-warning")
        assertEquals("waiting", t.card?.phase)
        assertEquals(t.card?.journey?.boardAtMs, LiveService.countdownAt(t))
    }

    @Test fun betweenTripsItWakesForTheReminderOrThePlanNotEveryChange() {
        val a = golden("class-bus")
        val now = parseInstant(a.asOf)!!
        val change = a.card?.nextChangeAtMs!!
        val wake = LiveService.betweenTripsWakeAt(a, now)
        assertNotNull(wake)
        assertTrue("not at the card's next change", wake != change)
        assertEquals(listOfNotNull(a.card?.remindAtMs, a.refreshAtMs).filter { it > now }.min(), wake)
        // Never within a minute.
        val r = NextAnswer.parse(JSONObject("""{"label":"x","quality":"ended","mode":"rest","refreshAt":"2026-08-27T01:00:10Z","card":{"kind":"rest","nextChangeAt":"2026-08-27T01:00:05Z"}}"""))
        val t = parseInstant("2026-08-27T01:00:00Z")!!
        assertEquals(t + LiveService.MIN_WAKE_MS, LiveService.betweenTripsWakeAt(r, t))
        assertNull(LiveService.betweenTripsWakeAt(null, t))
    }

    @Test fun aTimeWithNoDataBehindItIsNotCountedDown() {
        val a = NextAnswer.parse(JSONObject("""{"label":"D2","quality":"unknown","departsAt":"2026-08-27T01:04:00Z","mode":"trip","card":{"kind":"trip"}}"""))
        assertNull(LiveService.countdownAt(a))
    }
}
