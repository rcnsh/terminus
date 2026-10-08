package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    @Test fun aTimeWithNoDataBehindItIsNotCountedDown() {
        val a = NextAnswer.parse(JSONObject("""{"label":"D2","quality":"unknown","departsAt":"2026-08-27T01:04:00Z","mode":"trip","card":{"kind":"trip"}}"""))
        assertNull(LiveService.countdownAt(a))
    }
}
