package sh.rcn.terminus.widget

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.LaterBus
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.parseNearby

class NearbySwapTest {
    private val now = 1_790_000_000_000L

    private fun stop(code: String, opposite: String? = null) = NearbyStop(code, code, 60, true, emptyList(), opposite)

    private val stops = listOf(stop("KR-MRT-OPP", "KR-MRT"), stop("LT27"), stop("KR-MRT", "KR-MRT-OPP"))
    private val swap = NearbySwap.Swap("KR-MRT-OPP", "KR-MRT", now)

    @Test
    fun theOppositeStopComesFirstAndTheNearestSecond() {
        assertEquals(listOf("KR-MRT", "KR-MRT-OPP", "LT27"), NearbySwap.order(stops, swap, now).map { it.code })
        assertEquals("KR-MRT", NearbySwap.opposite(stops)?.code)
    }

    @Test
    fun itLastsWhileTheNearestStopIsTheSame() {
        val moved = listOf(stop("LT27"), stop("KR-MRT", "KR-MRT-OPP"))
        assertEquals(moved, NearbySwap.order(moved, swap, now))
        assertEquals(stops, NearbySwap.order(stops, swap, now + NearbySwap.KEEP_MS + 1))
        assertFalse(NearbySwap.active(stops, swap.copy(to = "LT27"), now))
        assertEquals(stops, NearbySwap.order(stops, null, now))
    }

    @Test
    fun theButtonOnlyOffersAnOppositeStopThatIsntShown() {
        assertNull(NearbySwap.offer(stops, null, now, listOf("KR-MRT-OPP", "LT27", "KR-MRT")))
        assertEquals("KR-MRT", NearbySwap.offer(stops, null, now, listOf("KR-MRT-OPP", "LT27"))?.code)
        assertEquals("KR-MRT-OPP", NearbySwap.offer(stops, swap, now, listOf("KR-MRT", "KR-MRT-OPP"))?.code)
    }

    @Test
    fun tappedWhileSwappedItGoesBackRatherThanStoringTheNearestTwice() {
        assertTrue(NearbySwap.undoes("KR-MRT-OPP", "KR-MRT-OPP", "KR-MRT-OPP", "KR-MRT"))
        assertTrue(NearbySwap.undoes("KR-MRT-OPP", "KR-MRT", "KR-MRT-OPP", "KR-MRT"))
        assertFalse(NearbySwap.undoes("KR-MRT-OPP", "KR-MRT", null, null))
    }

    @Test
    fun noOppositeStopNoSwap() {
        assertNull(NearbySwap.opposite(listOf(stop("LT27"), stop("KR-MRT"))))
        assertNull(NearbySwap.opposite(listOf(stop("KR-MRT-OPP", "KR-MRT"), stop("LT27"))))
    }

    @Test
    fun oppositeIsReadAndOptional() {
        val json =
            JSONObject(
                """{"stops":[{"stop":{"code":"PGP","name":"PGP"},"opposite":"PGPR","walkS":60,"board":[]},{"stop":{"code":"LT27","name":"LT 27"},"opposite":null,"walkS":90,"board":[]},{"stop":{"code":"S17","name":"S 17"},"walkS":90,"board":[]}]}"""
            )
        assertEquals(listOf("PGPR", null, null), parseNearby(json).map { it.opposite })
    }

    @Test
    fun laterBusesAreReadAndOptional() {
        val json =
            JSONObject(
                """{"stops":[{"stop":{"code":"PGP","name":"PGP"},"walkS":60,"board":[{"svc":"D2","etaS":300,"quality":"live","later":[{"etaS":840,"quality":"live"},{"etaS":1500,"quality":"scheduled"}]},{"svc":"K","etaS":null,"quality":"scheduled"}]}]}"""
            )
        val board = parseNearby(json).single().board
        assertEquals(listOf(LaterBus(840, "live"), LaterBus(1500, "scheduled")), board[0].later)
        assertEquals(emptyList<LaterBus>(), board[1].later)
    }
}
