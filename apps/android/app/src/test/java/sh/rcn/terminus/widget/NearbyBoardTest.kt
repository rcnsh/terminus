package sh.rcn.terminus.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.LaterBus
import sh.rcn.terminus.NearbyStop

/** Nearby on a widget: clock times worked out once, a gone bus giving way to the next, which next stop to name. */
class NearbyBoardTest {
    private val fetched = 1_000_000L

    private val utown =
        NearbyStop(
            "UTOWN",
            "UTown",
            120,
            true,
            listOf(
                BoardRow(
                    "D2",
                    370,
                    "live",
                    color = "#8e44c9",
                    towards = listOf("University Health Centre", "COM 3"),
                    crowd = "medium",
                    later = listOf(LaterBus(960, "live")),
                ),
                BoardRow(
                    "D1",
                    190,
                    "live",
                    color = "#ec4fa0",
                    towards = listOf("Yusof Ishak House", "COM 3"),
                    crowd = "low",
                    later = listOf(LaterBus(660, "scheduled"), LaterBus(1140, "live")),
                ),
                BoardRow("R1", 540, "scheduled", towards = listOf("Yusof Ishak House", "Prince George's Park")),
                BoardRow("E", null, "ended"),
            ),
        )

    @Test
    fun soonestFirstWithTheirClockTimes() {
        val buses = NearbyBoard.buses(utown, fetched, fetched)
        assertEquals(listOf("D1", "D2", "R1"), buses.map { it.svc })
        assertEquals(fetched + 190_000, buses[0].atMs)
        assertEquals(listOf(fetched + 660_000, fetched + 1_140_000), buses[0].later)
        assertEquals("Yusof Ishak House", buses[0].next)
        assertEquals("COM 3", buses[0].end)
        assertEquals(0xFFEC4FA0L, buses[0].color)
    }

    @Test
    fun aBusStaysAMinuteAfterItsDueThenTheNextTakesItsPlace() {
        val due = fetched + 190_000
        assertEquals(due, NearbyBoard.buses(utown, fetched, due + 59_000).first { it.svc == "D1" }.atMs)
        val d1 = NearbyBoard.buses(utown, fetched, due + 61_000).first { it.svc == "D1" }
        assertEquals(fetched + 660_000, d1.atMs)
        assertEquals(listOf(fetched + 1_140_000), d1.later)
        // The next bus has its own Live, and no crowding: the server's is for the first.
        assertFalse(d1.live)
        assertNull(d1.crowd)
    }

    @Test
    fun aServiceWithEveryBusGoneIsDropped() {
        val buses = NearbyBoard.buses(utown, fetched, fetched + 600_000)
        assertFalse(buses.any { it.svc == "R1" })
        assertEquals(listOf("D1", "D2"), buses.map { it.svc })
    }

    @Test
    fun theEndIsNamedOnlyWhenTwoBusesShownStopNextAtTheSamePlace() {
        val buses = NearbyBoard.buses(utown, fetched, fetched)
        val d1 = buses.first { it.svc == "D1" }
        val r1 = buses.first { it.svc == "R1" }
        val d2 = buses.first { it.svc == "D2" }
        // D1 and R1 both stop next at Yusof Ishak House: each says where it goes.
        assertEquals("COM 3", NearbyBoard.endIfNeeded(d1, buses))
        assertEquals("Prince George's Park", NearbyBoard.endIfNeeded(r1, buses))
        assertNull(NearbyBoard.endIfNeeded(d2, buses))
        // With R1 off screen, the next stop alone tells D1 apart.
        assertNull(NearbyBoard.endIfNeeded(d1, listOf(d1, d2)))
    }

    @Test
    fun theSameNextStopAndEndNeedsNoEnd() {
        val a = StopBus("A1", 0, false, 0, true, null, "LT27", "Kent Ridge Bus Terminal", false, emptyList())
        val k = a.copy(svc = "K")
        assertNull(NearbyBoard.endIfNeeded(a, listOf(a, k)))
    }

    @Test
    fun redrawnWhenItsBusGoes() {
        val buses = NearbyBoard.buses(utown, fetched, fetched)
        // D1 at 190 s, gone a minute after; then D2 at 370 s.
        assertEquals(fetched + 190_000 + NearbyBoard.GONE_MS, NearbyBoard.redrawAt(buses, fetched))
        assertEquals(fetched + 370_000 + NearbyBoard.GONE_MS, NearbyBoard.redrawAt(buses, fetched + 250_000))
        assertNull(NearbyBoard.redrawAt(emptyList(), fetched))
    }

    @Test
    fun redrawnAsEachMinuteGoesUntilTheTimesAreOld() {
        val buses = NearbyBoard.buses(utown, fetched, fetched)
        val old = fetched + 180_000
        // D1 at 190 s and D2 at 370 s each go down a minute 10 s in and each minute after, R1 at 540 s on the minute.
        val moments = generateSequence(fetched) { NearbyBoard.redrawAt(buses, it, old) }.drop(1).take(6).toList()
        assertEquals(listOf(10_000, 60_000, 70_000, 120_000, 130_000, 250_000).map { fetched + it }, moments)
        // The last of them is D1 going: after the times are old, nothing counts.
    }

    @Test
    fun minuteRedrawsDontFetchTheBoardAgain() {
        // The widgets' redraw alarm over ten minutes with exact alarms, each fetch giving the same board: it redraws at every minute off
        // a count, but fetches only when the times turn old (180 s; D1 going at 250 s would be later), as without the minutes.
        var fetchedAt = fetched
        var now = fetched
        val redraws = mutableListOf<Long>()
        val fetches = mutableListOf<Long>()
        while (true) {
            now = NearbyBoard.boardRedrawAt(listOf(utown), fetchedAt, now, exact = true) ?: break
            if (now > fetched + 600_000) break
            redraws += now - fetched
            if (now - fetchedAt >= 60_000 && now >= NearbyBoard.boardRefetchAt(listOf(utown), fetchedAt)) {
                fetches += now - fetched
                fetchedAt = now
            }
        }
        assertEquals(listOf(180_000L, 360_000L, 540_000L), fetches)
        assertEquals(listOf(10_000L, 60_000L, 70_000L, 120_000L, 130_000L, 180_000L), redraws.take(6))
    }

    @Test
    fun minutesRoundDownAndStopFarOff() {
        val at = fetched + 3_600_000
        assertEquals(6, NearbyBoard.minutesLeft(at, at - 6 * 60_000 - 59_000))
        assertEquals(6, NearbyBoard.minutesLeft(at, at - 6 * 60_000))
        assertEquals(5, NearbyBoard.minutesLeft(at, at - 6 * 60_000 + 1))
        // Its last minute is "now", and stays so while it may still be at the stop.
        assertEquals(0, NearbyBoard.minutesLeft(at, at - 59_999))
        assertEquals(0, NearbyBoard.minutesLeft(at, at + 10_000))
        assertEquals(14, NearbyBoard.minutesLeft(at, at - NearbyBoard.MINUTES_MS + 1))
        assertNull(NearbyBoard.minutesLeft(at, at - NearbyBoard.MINUTES_MS))
    }

    private val night =
        NearbyStop(
            "PGPF",
            "PGP Foyer",
            240,
            true,
            listOf(
                BoardRow(
                    "A2",
                    null,
                    "",
                    towards = listOf("TCOMS", "Kent Ridge Bus Terminal"),
                    running = false,
                    stopped = "notYet",
                    resumesAtMs = fetched + 20_000_000,
                ),
                BoardRow("K", null, "", endsHere = true, running = false, stopped = "notYet", resumesAtMs = fetched + 19_000_000),
                BoardRow("E", null, "", running = false, stopped = "noService"),
            ),
        )

    @Test
    fun withNothingRunningEachServicesFirstBusSoonestFirst() {
        val buses = NearbyBoard.buses(night, fetched, fetched, skewMs = 2_000)
        assertEquals(listOf("K", "A2"), buses.map { it.svc })
        assertTrue(buses.all { it.first && !it.live })
        // On the phone's clock: the server's time less how far ahead the server is.
        assertEquals(fetched + 19_000_000 - 2_000, buses[0].atMs)
        assertEquals("TCOMS", buses[1].next)
    }

    @Test
    fun aRunningBusHidesTheFirstBuses() {
        val mixed = night.copy(board = night.board + BoardRow("D2", 300, "live", towards = listOf("TCOMS", "COM 3")))
        assertEquals(listOf("D2"), NearbyBoard.buses(mixed, fetched, fetched).map { it.svc })
    }

    @Test
    fun aFirstBusPastIsntShown() {
        assertEquals(listOf("A2"), NearbyBoard.buses(night, fetched, fetched + 19_500_000).map { it.svc })
    }

    @Test
    fun pagesCountRound() {
        val buses = NearbyBoard.buses(utown, fetched, fetched)
        assertEquals(listOf("D1", "D2"), NearbyBoard.page(buses, 2, 0).buses.map { it.svc })
        val second = NearbyBoard.page(buses, 2, 1)
        assertEquals(listOf("R1"), second.buses.map { it.svc })
        assertEquals(1 to 2, second.page to second.pages)
        assertEquals(listOf("D1", "D2"), NearbyBoard.page(buses, 2, 2).buses.map { it.svc })
        assertEquals(listOf("R1"), NearbyBoard.page(buses, 2, -1).buses.map { it.svc })
        assertEquals(1, NearbyBoard.page(emptyList(), 2, 3).pages)
    }

    private fun stop(code: String, opposite: String? = null, rows: List<BoardRow> = emptyList()) =
        NearbyStop(code, code, 60, true, rows, opposite = opposite)

    @Test
    fun besideIsTheOppositeStopAcrossTheRoad() {
        val bus = listOf(BoardRow("A1", 120, "live"))
        val stops = listOf(stop("YIH", opposite = "YIH-OPP"), stop("CLB", rows = bus), stop("YIH-OPP"))
        // The opposite stop, even with no bus, over a nearer stop that has one.
        assertEquals("YIH-OPP", NearbyBoard.beside(stops) { NearbyBoard.buses(it, fetched, fetched) }?.code)
    }

    @Test
    fun withNoOppositeStopBesideIsTheNextStopWithABus() {
        val bus = listOf(BoardRow("D2", 120, "live"))
        val stops = listOf(stop("COM3"), stop("TCOMS"), stop("BIZ2", rows = bus))
        assertEquals("BIZ2", NearbyBoard.beside(stops) { NearbyBoard.buses(it, fetched, fetched) }?.code)
        assertNull(NearbyBoard.beside(stops.take(2)) { NearbyBoard.buses(it, fetched, fetched) })
    }

    @Test
    fun aBusKeepsThePlacesItPasses() {
        val row = BoardRow("A2", 120, "live", via = listOf("Science", "Kent Ridge MRT", "PGP"))
        val b = NearbyBoard.buses(stop("YIH-OPP", rows = listOf(row)), fetched, fetched).single()
        assertEquals(listOf("Science", "Kent Ridge MRT", "PGP"), b.via)
    }
}

/** Which layout a Nearby widget takes at the sizes a Pixel home screen gives it, and the mockups'. */
class NearbyFitTest {
    private val sky = 72f

    @Test
    fun oneRowTall() {
        assertEquals(NearbyFit.Kind.MINI, NearbyFit.of(186f, 100f, sky).kind)
        assertEquals(NearbyFit(NearbyFit.Kind.BAR, cols = 2), NearbyFit.of(387f, 100f, sky))
    }

    @Test
    fun narrowIsRows() {
        assertEquals(NearbyFit(NearbyFit.Kind.ROWS, rows = 3), NearbyFit.of(186f, 212f, sky))
        assertEquals(NearbyFit(NearbyFit.Kind.ROWS, rows = 3), NearbyFit.of(286f, 212f, sky))
    }

    @Test
    fun fourByTwoIsThreeTilesAndThePager() {
        assertEquals(NearbyFit(NearbyFit.Kind.TILES, cols = 3, rows = 1, pager = true), NearbyFit.of(387f, 212f, sky))
    }

    @Test
    fun narrowerIsTwoAcross() {
        assertEquals(NearbyFit(NearbyFit.Kind.TILES, cols = 2, rows = 1, pager = true), NearbyFit.of(320f, 196f, sky))
    }

    @Test
    fun shorterHasNoRoomForThePager() {
        assertFalse(NearbyFit.of(320f, 184f, sky).pager)
    }

    @Test
    fun fourByThreeIsTwoRowsWithTheRestUnderThem() {
        val fit = NearbyFit.of(387f, 324f, sky)
        assertEquals(NearbyFit(NearbyFit.Kind.TILES, cols = 3, rows = 2, footer = true), fit)
        assertEquals(6, fit.shown)
    }

    @Test
    fun tallerTakesAnotherRow() {
        assertEquals(NearbyFit(NearbyFit.Kind.TILES, cols = 3, rows = 3, footer = true), NearbyFit.of(387f, 436f, sky))
    }

    @Test
    fun tooShortForATileIsRows() {
        assertEquals(NearbyFit.Kind.ROWS, NearbyFit.of(320f, 150f, sky).kind)
    }

    @Test
    fun bothSidesAtFourByTwo() {
        val sky = NearbyFit.SIDES_SKY_DP
        assertEquals(NearbyFit(NearbyFit.Kind.SIDES, cols = 2, rows = 4), NearbyFit.sides(387f, 212f, sky, newcomer = false))
        // New to NUS: a line more for each bus and each side, so a bus fewer.
        assertEquals(NearbyFit(NearbyFit.Kind.SIDES, cols = 2, rows = 3), NearbyFit.sides(387f, 212f, sky, newcomer = true))
    }

    @Test
    fun bothSidesNeedTheWidthAndTwoRows() {
        val sky = NearbyFit.SIDES_SKY_DP
        assertNull(NearbyFit.sides(286f, 212f, sky, newcomer = false))
        assertNull(NearbyFit.sides(387f, 100f, sky, newcomer = false))
        assertNull(NearbyFit.sides(387f, 130f, sky, newcomer = true))
        // Taller: up to five rows a side, no more than a Glance Column holds.
        assertEquals(5, NearbyFit.sides(387f, 436f, sky, newcomer = false)!!.rows)
    }
}
