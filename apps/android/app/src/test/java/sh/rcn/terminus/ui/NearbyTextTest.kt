package sh.rcn.terminus.ui

import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
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

    private val sg = ZoneId.of("Asia/Singapore")
    private val h24 = DateTimeFormatter.ofPattern("HH:mm").withZone(sg)
    private val h12 = DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(sg)
    private val zh12 = DateTimeFormatter.ofPattern("ah:mm", Locale.SIMPLIFIED_CHINESE).withZone(sg)
    private val clock24 = { ms: Long -> h24.format(Instant.ofEpochMilli(ms)) }
    private val clock12 = { ms: Long -> h12.format(Instant.ofEpochMilli(ms)) }

    // As the app writes it: "下午 6:36", with the space the server's Chinese has.
    private val clockZh = { ms: Long -> zh12.format(Instant.ofEpochMilli(ms)).replace(Regex("([上下]午)(\\d)"), "$1 $2") }

    private val fixtures = listOf("../../../fixtures/answers", "../../fixtures/answers").map(::File).first { it.isDirectory }
    private val stops = parseNearby(JSONObject(File(fixtures, "nearby-list.json").readText()))

    private fun row(stop: String, svc: String) = stops.first { it.code == stop }.board.first { it.svc == svc }

    private fun sgt(hhmm: String) = Instant.parse("2026-11-04T${hhmm}:00+08:00").toEpochMilli()

    /** Three live buses at these Singapore times. */
    private fun at(vararg times: String) =
        BoardRow("D1", 60, "live", atMs = sgt(times[0]), later = times.drop(1).map { LaterBus(600, "live", atMs = sgt(it)) })

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
        val cells = NearbyText.cells(row("PGPR", "D2"), asClock = false, clock24)
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
        val cells = NearbyText.cells(d2, asClock = false, clock24)
        assertEquals(listOf(true, false, false), cells.map { it.next })
        assertEquals("4 min", cells[0].text)
        assertEquals("Bus D2, via Kent Ridge MRT, 4 minutes, live, then 14 minutes, then about 26 minutes", NearbyText.said(d2, cells))
        val clock = NearbyText.cells(d2, asClock = true, clock24)
        assertEquals("09:04", clock[0].text)
        assertTrue(clock[0].next)
    }

    @Test
    fun aFirstBusWithNoTimeLeavesNothingLarge() {
        val r = BoardRow("A1", null, "ended", later = listOf(LaterBus(300, "live")))
        assertTrue(NearbyText.cells(r, false, clock24).none { it.next })
    }

    @Test
    fun theServersChineseGuessIsATildeInTheGrid() {
        TestStrings.install("values-zh")
        val r = BoardRow("A1", 360, "scheduled", eta = "约 6 分钟", later = listOf(LaterBus(1080, "scheduled", eta = "约 18 分钟")))
        val cells = NearbyText.cells(r, asClock = false, clock24)
        assertEquals("~6 分钟", cells[0].text)
        assertEquals("~18", cells[1].text)
        assertEquals("–", cells[2].text)
    }

    @Test
    fun nowHasNoFigureAndIsShownAsItIs() {
        val c = NearbyText.cells(BoardRow("A1", 20, "live", eta = "now"), asClock = false, clock24)[0]
        assertEquals(Cell("now", next = true, said = "Arriving"), c)
    }

    @Test
    fun aGuessUnderAMinuteIsAboutAMinuteNeverNow() {
        // The server's words, and an older server's "now" for a timetabled bus, worded here.
        for (words in listOf("~1 min", "now", null)) {
            val c = NearbyText.cells(BoardRow("A2", 30, "scheduled", eta = words), asClock = false, clock24)[0]
            assertEquals(Cell("1", mark = "~", after = " min", next = true, said = "about 1 minute, estimated"), c)
        }
        TestStrings.install("values-zh")
        assertEquals("~1 分钟", NearbyText.cells(BoardRow("A2", 30, "stale", eta = "约 1 分钟"), false, clock24)[0].text)
    }

    @Test
    fun aPlaceKeptWholeHasNoBreakSpaces() {
        val d = NearbyText.Dest("via Kent Ridge MRT", 4 until 18)
        assertEquals("via Kent\u00a0Ridge\u00a0MRT", d.whole().text)
        assertEquals(d.place, d.whole().place)
        assertEquals(NearbyText.Dest("Ends here"), NearbyText.Dest("Ends here").whole())
    }

    @Test
    fun clockTimesShowAmPmOnNextAndWhereTheHalfOfTheDayChanges() {
        val cells = NearbyText.cells(at("11:40", "11:52", "12:04"), asClock = true, clock12)
        assertEquals(listOf("11:40 AM", "11:52", "12:04 PM"), cells.map { it.text })
        assertEquals(" AM", cells[0].after)
        assertEquals("11:52", cells[1].figure)
        assertEquals(" PM", cells[2].after)
        // The next says how long it is, too; the others only their time.
        assertEquals("11:40 AM, in 1 minute", cells[0].said)
        // Said whole, though shown bare.
        assertEquals("11:52 AM", cells[1].said)
        // Next always has it.
        assertEquals(listOf("12:04 PM", "12:16", "12:28"), NearbyText.cells(at("12:04", "12:16", "12:28"), true, clock12).map { it.text })
    }

    @Test
    fun chineseWritesTheHalfOfTheDayBeforeTheTime() {
        TestStrings.install("values-zh")
        val cells = NearbyText.cells(at("11:52", "12:04", "12:16"), asClock = true, clockZh)
        assertEquals("上午 ", cells[0].before)
        assertEquals("", cells[0].after)
        assertEquals("上午 11:52", cells[0].text)
        assertEquals("下午 ", cells[1].before)
        assertEquals("12:16", cells[2].text)
        assertEquals("上午 11:52，1 分钟后", cells[0].said)
        assertEquals("下午 12:04", cells[1].said)
    }

    @Test
    fun twentyFourHourTimesHaveNoHalf() {
        val cells = NearbyText.cells(at("18:02", "18:14", "18:26"), asClock = true, clock24)
        assertEquals(listOf("18:02", "18:14", "18:26"), cells.map { it.text })
        assertEquals("18:02, in 1 minute", cells[0].said)
        assertEquals("18:14", cells[1].said)
        assertEquals(
            "Bus D1, to PGP, 18:02, in 1 minute, then 18:14, then 18:26",
            NearbyText.said(at("18:02", "18:14", "18:26").copy(dest = "to PGP"), cells),
        )
    }

    @Test
    fun aGuessKeepsItsTildeAsAClockTime() {
        val at = Instant.parse("2026-08-27T01:09:00Z").toEpochMilli()
        val r = BoardRow("A1", 540, "scheduled", eta = "~9 min", atMs = at, later = listOf(LaterBus(1140, "stale", atMs = at + 600_000)))
        val clock = NearbyText.cells(r, asClock = true, clock24)
        assertEquals(Cell("09:09", mark = "~", next = true, said = "about 09:09, in about 9 minutes"), clock[0])
        assertEquals("~09:19", clock[1].text)
        assertEquals("~9 min", NearbyText.cells(r, asClock = false, clock24)[0].text)
    }

    @Test
    fun noBusIsADash() {
        val a2 = row("PGPR", "A2")
        val cells = NearbyText.cells(a2, asClock = true, clock24)
        assertEquals(List(3) { Cell("–") }, cells)
        assertNull(cells[0].said)
        assertEquals("Bus A2, to KR\u00a0Bus\u00a0Ter", NearbyText.said(a2, cells))
    }

    @Test
    fun theFootExplainsOnlyWhatIsShowing() {
        fun foot(stops: List<NearbyStop>, asClock: Boolean = false) =
            NearbyText.foot(stops.flatMap { s -> s.board.flatMap { NearbyText.cells(it, asClock, clock24) } })
        assertEquals(
            listOf("~ is a guess from the timetable, not a live time.", "Tap a service to see its whole line."),
            foot(stops),
        )
        val live = NearbyStop("PGP", "PGP", 120, true, listOf(BoardRow("A1", 300, "live", later = listOf(LaterBus(900, "live")))))
        assertEquals(listOf("Tap a service to see its whole line."), foot(listOf(live)))
        // A row with no time says nothing about guesses, whatever its quality.
        assertEquals(1, foot(listOf(live.copy(board = listOf(BoardRow("K", null, "scheduled"))))).size)
        // A timetabled bus under a minute away is "~1 min", so it's explained, in minutes and as a clock time.
        val soon = live.copy(board = listOf(BoardRow("A1", 30, "scheduled", eta = "now", atMs = sgt("12:00"))))
        assertEquals(2, foot(listOf(soon)).size)
        assertEquals(2, foot(listOf(soon), asClock = true).size)
    }

    @Test
    fun aPhonesOwnClockStyleKeepsItsFiguresWhole() {
        val dots = DateTimeFormatter.ofPattern("HH.mm").withZone(sg)
        val clockDots = { ms: Long -> dots.format(Instant.ofEpochMilli(ms)) }
        assertEquals(listOf("18.02", "18.14", "18.26"), NearbyText.cells(at("18:02", "18:14", "18:26"), true, clockDots).map { it.text })
        val dots12 = DateTimeFormatter.ofPattern("h.mm a", Locale.US).withZone(sg)
        assertEquals(
            listOf("11.52 AM", "12.04 PM", "12.16"),
            NearbyText.cells(at("11:52", "12:04", "12:16"), true) { dots12.format(Instant.ofEpochMilli(it)) }.map { it.text },
        )
        // Myanmar digits.
        val my = NearbyText.cells(at("18:02"), true) { "\u1041\u1048:\u1040\u1042" }[0]
        assertEquals("\u1041\u1048:\u1040\u1042", my.figure)
        assertEquals("", my.after)
    }

    @Test
    fun theNextAsAClockTimeSaysItsWait() {
        val r = BoardRow("A1", 20, "scheduled", atMs = sgt("12:09"))
        assertEquals("about 12:09 PM, in about 1 minute", NearbyText.cells(r, asClock = true, clock12)[0].said)
        val live = BoardRow("A1", 20, "live", atMs = sgt("12:09"))
        assertEquals("12:09 PM, in under a minute", NearbyText.cells(live, asClock = true, clock12)[0].said)
        val later = BoardRow("A1", 780, "live", atMs = sgt("12:09"))
        assertEquals("12:09 PM, in 13 minutes", NearbyText.cells(later, asClock = true, clock12)[0].said)
    }
}
