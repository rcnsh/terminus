package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.Instant

/** The ride on the bus (phase 6): parsed from card.ride, placed by the clock. */
class RideTest {
    private val board = Instant.parse("2026-10-01T01:41:00Z").toEpochMilli()
    private val arrive = board + 9 * 60_000

    private fun card(ride: String) = Card.parse(JSONObject("""{"kind":"trip","phase":"riding","ride":$ride}"""))

    @Test fun parsesTheStopsAndTimes() {
        val r = card("""{"svc":"D2","stops":[{"code":"PGP","name":"PGP"},{"code":"KR-MRT","name":"KR MRT"},{"code":"LT27","name":"LT27"},{"code":"UTOWN","name":"UTown"}],"board":"2026-10-01T01:41:00Z","arrive":"2026-10-01T01:50:00Z"}""").ride!!
        assertEquals(listOf("PGP", "KR MRT", "LT27", "UTown"), r.stops)
        assertEquals(board, r.boardMs)
        assertEquals(arrive, r.arriveMs)
    }

    @Test fun todaysListSaysWhichBusYoureOn() {
        val day = DayPlan.parse(JSONObject("""{"items":[
            {"kind":"class","key":"a","label":"GEA1000 @ UTown","status":"next","toName":"UTown","startsAt":"2026-10-01T02:00:00Z","onBus":{"svc":"D2","off":"UTown","arrive":"2026-10-01T01:50:00Z"}},
            {"kind":"class","key":"b","label":"CS2030 @ COM1","status":"later","toName":"COM 3","startsAt":"2026-10-01T05:00:00Z","leave":{"at":"2026-10-01T04:40:00Z","svc":"D2"}}
        ]}"""))
        assertEquals(OnBus("D2", "UTown", arrive), day.items[0].onBus)
        assertNull(day.items[1].onBus)
    }

    @Test fun aRideWithoutTwoStopsOrTimesIsNone() {
        assertNull(card("""{"svc":"D2","stops":[{"code":"PGP","name":"PGP"}],"board":"2026-10-01T01:41:00Z","arrive":"2026-10-01T01:50:00Z"}""").ride)
        assertNull(card("""{"svc":"D2","stops":[{"code":"A","name":"A"},{"code":"B","name":"B"}],"board":"2026-10-01T01:50:00Z","arrive":"2026-10-01T01:41:00Z"}""").ride)
        assertNull(Card.parse(JSONObject("""{"kind":"trip","phase":"riding","ride":null}""")).ride)
    }

    @Test fun theBusMovesStopByStopWithTheClock() {
        // Three hops, three minutes each.
        val r = Ride("D2", listOf("PGP", "KR MRT", "LT27", "UTown"), board, arrive)
        assertEquals(0f, r.progress(board - 60_000))
        assertEquals("Next: KR MRT · 3 stops to go", r.nextText(board + 60_000))
        assertEquals("Next: LT27 · 2 stops to go", r.nextText(board + 4 * 60_000))
        assertEquals("Next: UTown, where you get off", r.nextText(board + 7 * 60_000))
        assertEquals("Getting off at UTown", r.nextText(arrive + 60_000))
        assertEquals(1f, r.progress(arrive + 60_000))
        assertEquals(board + 3 * 60_000, RideStyle.nextRedrawAt(r, board + 60_000))
        assertNull(RideStyle.nextRedrawAt(r, arrive))
    }
}
