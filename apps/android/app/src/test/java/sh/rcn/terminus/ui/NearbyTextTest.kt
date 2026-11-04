package sh.rcn.terminus.ui

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.LaterBus
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.TestStrings
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.ui.NearbyText.Cell

/** Nearby's rows as a stop's board, on the API's golden answer: where each bus is going and its next three buses, the next large. */
class NearbyTextTest {
    init {
        TestStrings.install()
    }

    private val fixtures = listOf("../../../fixtures/answers", "../../fixtures/answers").map(::File).first { it.isDirectory }
    private val stops = parseNearby(JSONObject(File(fixtures, "nearby-list.json").readText()))

    private fun row(stop: String, svc: String) = stops.first { it.code == stop }.board.first { it.svc == svc }

    @Test
    fun aRowSaysWhereItsBusIsGoingWithItsPlaceSetApart() {
        val d = NearbyText.dest(row("PGPR", "D2"))
        assertEquals("via COM\u00a03", d.text)
        assertEquals("COM\u00a03", d.text.substring(d.place!!))
        val a2 = NearbyText.dest(row("PGPR", "A2"))
        assertEquals("to KR\u00a0Bus\u00a0Ter", a2.text)
        assertEquals("KR\u00a0Bus\u00a0Ter", a2.text.substring(a2.place!!))
        assertEquals(NearbyText.Dest("Ends here"), NearbyText.dest(row("PGPR", "K")))
    }

    @Test
    fun anOlderServerSaysWhereItEndsUp() {
        assertEquals(
            NearbyText.Dest("to Kent Ridge MRT"),
            NearbyText.dest(BoardRow("A1", 60, "live", towards = listOf("UTown", "Kent Ridge MRT"))),
        )
        assertEquals(NearbyText.Dest("to Central Library"), NearbyText.dest(BoardRow("A1", 60, "live", toText = "to Central Library")))
        assertEquals(NearbyText.Dest("Ends here"), NearbyText.dest(BoardRow("K", null, "scheduled")))
    }

    @Test
    fun onlyNextCarriesItsUnitAndAGuessIsMarked() {
        val cells = NearbyText.cells(row("PGPR", "D2"))
        assertEquals(
            listOf(
                Cell("4", after = " min", next = true, said = "4 minutes, live"),
                Cell("14", said = "14 minutes"),
                Cell("26", mark = "~", said = "about 26 minutes"),
            ),
            cells,
        )
        assertEquals(
            "Bus D2, via COM\u00a03, 4 minutes, live, then 14 minutes, then about 26 minutes",
            NearbyText.said(row("PGPR", "D2"), cells),
        )
    }

    @Test
    fun theNextBusIsAlwaysTheLargeOneWhateverTheWalk() {
        // An older answer's tooSoon is no longer read: the first bus is shown and said like any other.
        val older = JSONObject(File(fixtures, "nearby-list.json").readText())
        for (stop in older.getJSONArray("stops").let { a -> (0 until a.length()).map(a::getJSONObject) }) stop.getJSONArray("board").let { b
            ->
            (0 until b.length()).forEach { b.getJSONObject(it).put("tooSoon", true) }
        }
        val d2 = parseNearby(older).first { it.code == "PGP" }.board.first { it.svc == "D2" }
        val cells = NearbyText.cells(d2)
        assertEquals(listOf(true, false, false), cells.map { it.next })
        assertEquals("4 min", cells[0].text)
        assertEquals("Bus D2, via KR\u00a0MRT, 4 minutes, live, then 14 minutes, then about 26 minutes", NearbyText.said(d2, cells))
    }

    @Test
    fun aFirstBusWithNoTimeLeavesNothingLarge() {
        val r = BoardRow("A1", null, "ended", later = listOf(LaterBus(300, "live")))
        assertTrue(NearbyText.cells(r).none { it.next })
    }

    @Test
    fun theServersChineseGuessIsATildeInTheGrid() {
        TestStrings.install("values-zh")
        val r = BoardRow("A1", 360, "scheduled", eta = "约 6 分钟", later = listOf(LaterBus(1080, "scheduled", eta = "约 18 分钟")))
        val cells = NearbyText.cells(r)
        assertEquals("~6 分钟", cells[0].text)
        assertEquals("~18", cells[1].text)
        assertEquals("–", cells[2].text)
    }

    @Test
    fun nowHasNoFigureAndIsShownAsItIs() {
        val c = NearbyText.cells(BoardRow("A1", 20, "live", eta = "now"))[0]
        assertEquals(Cell("now", next = true, said = "Arriving"), c)
    }

    @Test
    fun aGuessUnderAMinuteIsAboutAMinuteNeverNow() {
        // The server's words, and an older server's "now" for a timetabled bus, worded here.
        for (words in listOf("~1 min", "now", null)) {
            val c = NearbyText.cells(BoardRow("A2", 30, "scheduled", eta = words))[0]
            assertEquals(Cell("1", mark = "~", after = " min", next = true, said = "about 1 minute, estimated"), c)
        }
        TestStrings.install("values-zh")
        assertEquals("~1 分钟", NearbyText.cells(BoardRow("A2", 30, "stale", eta = "约 1 分钟"))[0].text)
    }

    @Test
    fun aPlaceKeptWholeHasNoBreakSpaces() {
        val d = NearbyText.Dest("via Kent Ridge MRT", 4 until 18)
        assertEquals("via Kent\u00a0Ridge\u00a0MRT", d.whole().text)
        assertEquals(d.place, d.whole().place)
        assertEquals(NearbyText.Dest("Ends here"), NearbyText.Dest("Ends here").whole())
    }

    @Test
    fun noBusIsADash() {
        val a2 = row("PGPR", "A2")
        val cells = NearbyText.cells(a2)
        assertEquals(List(3) { Cell("–") }, cells)
        assertNull(cells[0].said)
        assertEquals("Bus A2, to KR\u00a0Bus\u00a0Ter", NearbyText.said(a2, cells))
    }

    @Test
    fun theFootExplainsOnlyWhatIsShowing() {
        fun foot(stops: List<NearbyStop>) = NearbyText.foot(stops.flatMap { s -> s.board.flatMap(NearbyText::cells) })
        assertEquals(listOf("~ is a guess from the timetable, not a live time."), foot(stops))
        val live = NearbyStop("PGP", "PGP", 120, true, listOf(BoardRow("A1", 300, "live", later = listOf(LaterBus(900, "live")))))
        assertEquals(emptyList<String>(), foot(listOf(live)))
        // A row with no time says nothing about guesses, whatever its quality.
        assertEquals(0, foot(listOf(live.copy(board = listOf(BoardRow("K", null, "scheduled"))))).size)
        // A timetabled bus under a minute away is "~1 min", so it's explained.
        val soon = live.copy(board = listOf(BoardRow("A1", 30, "scheduled", eta = "now")))
        assertEquals(1, foot(listOf(soon)).size)
    }
}
