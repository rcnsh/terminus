package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.ui.roadWords

/** The Stops tab's data, from replies shaped like the API's (/api/arrivals, /api/me/nearby, /api/line). */
class BusesTest {
    private val arrivals =
        JSONObject(
            """
        {"stop": {"code": "YIH", "name": "Yusof Ishak House", "opposite": "YIH-OPP"},
         "board": [
          {"svc": "K", "etaS": 40, "quality": "live", "ambiguousBerth": false, "later": [{"etaS": 560, "quality": "live"}, {"etaS": 1260, "quality": "scheduled"}],
           "color": "#1e88e5", "towards": ["Central Library", "Kent Vale"], "crowd": "low", "endsAt": "2026-10-07T15:15:00.000Z"},
          {"svc": "R1", "etaS": null, "quality": "scheduled", "ambiguousBerth": false, "later": [],
           "color": null, "towards": [], "crowd": null, "endsAt": null},
          {"svc": "151", "etaS": 300, "quality": "scheduled", "ambiguousBerth": false, "paid": true, "later": [],
           "color": null, "towards": ["Kent Ridge Ter"], "crowd": "nope", "endsAt": "not a time"}
         ],
         "asOf": "2026-10-07T02:42:00.000Z", "available": true}
        """
        )

    @Test
    fun anArrivalsBoardParsesEveryNewField() {
        val b = Board.parse(arrivals)
        assertEquals("YIH", b.code)
        assertEquals("Yusof Ishak House", b.name)
        assertEquals("YIH-OPP", b.opposite)
        assertEquals("every row, not only the ones with a time", listOf("K", "R1", "151"), b.rows.map { it.svc })
        val k = b.rows[0]
        assertEquals(listOf("Central Library", "Kent Vale"), k.towards)
        assertEquals("low", k.crowd)
        assertEquals(java.time.Instant.parse("2026-10-07T15:15:00Z").toEpochMilli(), k.endsAtMs)
        assertEquals("#1e88e5", k.color)
        assertEquals(java.time.Instant.parse("2026-10-07T02:42:00Z").toEpochMilli(), b.asOfMs)
        val bus151 = b.rows[2]
        assertTrue(bus151.paid)
        assertNull("an unknown crowd word is no crowd", bus151.crowd)
        assertNull("a time it can't read is no time", bus151.endsAtMs)
    }

    @Test
    fun anOlderServersBoardStillParses() {
        val b =
            Board.parse(
                JSONObject(
                    """{"stop": {"code": "COM3", "name": "COM 3"}, "board": [{"svc": "D2", "etaS": 120, "quality": "live", "later": []}], "available": true}"""
                )
            )
        assertNull(b.opposite)
        val r = b.rows.single()
        assertEquals(emptyList<String>(), r.towards)
        assertNull(r.crowd)
        assertNull(r.endsAtMs)
        assertNull(r.color)
        assertNull(b.asOfMs)
    }

    @Test
    fun nearbyRowsCarryTheNewFieldsAndTheDistance() {
        val json =
            JSONObject(
                """
            {"stops": [{"stop": {"code": "YIH", "name": "Yusof Ishak House"}, "opposite": "YIH-OPP", "distM": 40, "walkS": 35, "available": true,
              "board": [{"svc": "A1", "etaS": 240, "quality": "live", "later": [{"etaS": 720, "quality": "live"}], "color": "#e53935", "towards": ["Central Library"], "crowd": "high", "endsAt": null}]}],
             "asOf": "2026-10-07T02:42:00.000Z"}
            """
            )
        val s = parseNearby(json).single()
        assertEquals(40, s.distM)
        val board = Board.of(s, 5L)
        assertEquals("YIH-OPP", board.opposite)
        assertEquals(40, board.distM)
        assertEquals("high", board.rows.single().crowd)
        assertEquals(listOf("Central Library"), board.rows.single().towards)
    }

    @Test
    fun aFreshBoardIsShownAsItCame() {
        val got = 1_000_000L
        val b = Board.parse(arrivals).copy(gotMs = got)
        // Within two refreshes, as the server counted it: not counted again here.
        assertEquals(b, b.aged(got + BusTimes.OLD_MS))
        assertEquals("live", b.aged(got + 20_000).rows[0].quality)
        // Not known when it came (an older caller): as it is.
        val unknown = Board.parse(arrivals)
        assertEquals(unknown, unknown.aged(got + 600_000))
    }

    @Test
    fun anOldBoardIsCountedDownAndNotLive() {
        val got = 1_000_000L
        val b = Board.parse(arrivals).copy(gotMs = got).aged(got + 40_000)
        val k = b.rows[0]
        // K was 40 s away with buses 560 and 1260 s away: 40 s on, exactly 40 s less.
        assertEquals(0, k.etaS)
        assertEquals("stale", k.quality)
        assertNull("the server's words from then", k.eta)
        assertNull(k.laterText)
        assertEquals(listOf(520, 1220), k.later.map { it.etaS })
        // The later buses too: a live one is no longer live, a timetabled one stays so.
        assertEquals(listOf("stale", "scheduled"), k.later.map { it.quality })
        // A timetabled time stays timetabled, counted down too.
        val p = b.rows[2]
        assertEquals(260, p.etaS)
        assertEquals("scheduled", p.quality)
        // No time to count: as it was.
        assertNull(b.rows[1].etaS)
        assertEquals("scheduled", b.rows[1].quality)
    }

    @Test
    fun busesLongPastHaveNoTime() {
        val got = 1_000_000L
        val k = Board.parse(arrivals).copy(gotMs = got).aged(got + 101_000).rows[0]
        // 40 s away 101 s ago: over a minute past, so no time; still not live.
        assertNull(k.etaS)
        assertEquals("stale", k.quality)
        // 99 s ago, a minute past at most: "Arriving" at 0 rather than nothing.
        assertEquals(0, Board.parse(arrivals).copy(gotMs = got).aged(got + 99_000).rows[0].etaS)
        // Later buses gone by are dropped.
        val far = Board.parse(arrivals).copy(gotMs = got).aged(got + 600_000).rows[0]
        assertEquals(listOf(660), far.later.map { it.etaS })
    }

    @Test
    fun aLineCountsYourStopsTimeDownToo() {
        val got = 1_000_000L
        val here = Board.parse(arrivals).rows[0]
        val line =
            Line("K", 0, null, listOf(LineStop("YIH", "YIH", emptyList())), emptyList(), LineHere("YIH", 0, here), true, null, gotMs = got)
        assertEquals(line, line.aged(got + 30_000))
        val row = line.aged(got + 45_000).here?.row
        assertEquals(0, row?.etaS)
        assertEquals("stale", row?.quality)
        assertEquals(listOf(515, 1215), row?.later?.map { it.etaS })
    }

    @Test
    fun timesComeOnlyFromTheApi() {
        val k = Board.parse(arrivals).rows[0]
        assertEquals(listOf(9, 21), BusTimes.later(k))
        assertTrue("a timetabled later bus after a live one says so", BusTimes.laterScheduled(k))
        val r1 = Board.parse(arrivals).rows[1]
        assertEquals("no later buses given: none shown", emptyList<Int>(), BusTimes.later(r1))
        assertFalse(BusTimes.laterScheduled(r1))
        assertEquals(1, BusTimes.minutes(50))
        assertEquals(4, BusTimes.minutes(240))
        assertEquals(5, BusTimes.minutes(270))
    }

    @Test
    fun onlyServicesEndingWithinTwoHoursSayWhen() {
        val now = java.time.Instant.parse("2026-10-07T14:00:00Z").toEpochMilli()
        val rows =
            listOf(
                BoardRow("D1", 60, "live", endsAtMs = now + 80 * 60_000),
                BoardRow("D1", 600, "live", endsAtMs = now + 75 * 60_000),
                BoardRow("R1", 60, "live", endsAtMs = now + 30 * 60_000),
                BoardRow("A1", 60, "live", endsAtMs = now + 3 * 3_600_000),
                BoardRow("K", 60, "live", endsAtMs = now - 60_000),
                BoardRow("D2", 60, "live"),
            )
        assertEquals(listOf("R1", "D1"), BusTimes.endingSoon(rows, now).map { it.first })
        // A service on two rows says the sooner of its ends.
        assertEquals(now + 75 * 60_000, BusTimes.endingSoon(rows, now).last().second)
    }

    @Test
    fun campusTimeIsSingapores() {
        assertEquals(23 * 60 + 15, BusTimes.campusMinute(java.time.Instant.parse("2026-10-07T15:15:00Z").toEpochMilli()))
    }

    private val line =
        JSONObject(
            """
        {"svc": "D1", "color": "#ec4fa0", "endsAt": "2026-10-07T15:15:00.000Z",
         "stops": [
          {"code": "COM3", "name": "COM 3", "services": ["D2"]},
          {"code": "IT", "name": "Information Technology", "services": []},
          {"code": "YIH-OPP", "name": "Opp Yusof Ishak House", "services": ["A2"]},
          {"code": "UTOWN", "name": "University Town", "services": ["C", "D2"]}
         ],
         "buses": [
          {"id": "a", "plate": "PD427L", "crowd": "low", "at": null, "after": 0},
          {"id": "b", "plate": "PD418C", "crowd": "high", "at": 2, "after": null},
          {"id": "c", "plate": null, "crowd": null, "at": null, "after": 3},
          {"id": "d", "plate": "PD1", "crowd": "low", "at": 9, "after": null}
         ],
         "stop": {"code": "YIH-OPP", "index": 2, "row": {"svc": "D1", "etaS": 420, "quality": "live", "later": [{"etaS": 1020, "quality": "live"}], "color": "#ec4fa0", "towards": ["UTown"], "crowd": "low", "endsAt": null}},
         "available": true, "asOf": "2026-10-07T02:42:00.000Z"}
        """
        )

    @Test
    fun aLineParsesWithItsBusesPlaced() {
        val l = Line.parse(line)
        assertEquals("D1", l.svc)
        assertEquals(0xFFEC4FA0L, l.color)
        assertEquals(4, l.stops.size)
        assertEquals(listOf("C", "D2"), l.stops[3].services)
        assertEquals("a bus placed off the list isn't drawn", 3, l.buses.count { it.at != null || it.after != null })
        assertEquals(2, l.here?.index)
        assertEquals(420, l.here?.row?.etaS)
    }

    @Test
    fun theLineIsDrawnStopsWithBusesBetween() {
        val items = Line.parse(line).items()
        val shape = items.map {
            when (it) {
                is LineItem.Stop -> "${it.stop.code}${if (it.buses.isNotEmpty()) "*" else ""}${if (it.here) "!" else ""}"
                is LineItem.Between -> "~${it.after}"
            }
        }
        // The bus after the last stop is drawn after it.
        assertEquals(listOf("COM3", "~0", "IT", "YIH-OPP*!", "UTOWN", "~3"), shape)
    }

    @Test
    fun aLineWithoutTheStopOrBusesStillParses() {
        val l =
            Line.parse(
                JSONObject(
                    """{"svc": "A1", "color": null, "endsAt": null, "stops": [{"code": "PGP", "name": "PGP", "services": []}], "buses": [], "available": false}"""
                )
            )
        assertNull(l.here)
        assertFalse(l.available)
        assertEquals(0xFF8A939CL, l.color)
        assertEquals(1, l.items().size)
    }

    @Test
    fun pinsToggleAndStopAtEight() {
        assertEquals(listOf("A", "B"), Pins.toggle(listOf("A"), "B"))
        assertEquals(listOf("B"), Pins.toggle(listOf("A", "B"), "A"))
        val full = (1..8).map { "S$it" }
        assertEquals("a ninth isn't added", full, Pins.toggle(full, "S9"))
        assertEquals(full - "S3", Pins.toggle(full, "S3"))
        // Made again on a profile where another device pinned it too: still pinned, not toggled off.
        assertEquals(listOf("A", "B"), Pins.set(listOf("A", "B"), "B", on = true))
        assertEquals(listOf("A"), Pins.set(listOf("A"), "B", on = false))
    }

    @Test
    fun theHomeShowsEachPinnedStopOnceUpToTheLimit() {
        assertEquals(listOf("CLB", "YIH", "COM3"), Pins.shown(listOf("CLB", "YIH", "CLB", "COM3")))
        // A profile saved with more than the limit (an older one, a smaller limit) asks for no more boards than the limit.
        val many = (1..10).map { "S$it" }
        assertEquals(many.take(8), Pins.shown(many))
        assertEquals(many.take(2), Pins.shown(many, max = 2))
        assertEquals(emptyList<String>(), Pins.shown(emptyList()))
    }

    @Test
    fun thePinnedCardKeepsTheStopShowingWhenThePinsChange() {
        val pins = listOf("UTOWN", "KR-MRT", "COM3")
        assertEquals("unpinned, the next one takes its place", "COM3", PinPages.kept(pins, listOf("UTOWN", "COM3"), "KR-MRT"))
        assertEquals("the last one unpinned: the one before it", "KR-MRT", PinPages.kept(pins, listOf("UTOWN", "KR-MRT"), "COM3"))
        assertEquals("another unpinned: it stays", "COM3", PinPages.kept(pins, listOf("KR-MRT", "COM3"), "COM3"))
        assertEquals("pinned since: it stays", "KR-MRT", PinPages.kept(pins, pins + "PGP", "KR-MRT"))
        assertNull("the only one unpinned: nothing", PinPages.kept(listOf("UTOWN"), emptyList(), "UTOWN"))
        assertEquals("two gone at once: the next still pinned", "UTOWN", PinPages.kept(pins, listOf("UTOWN"), "KR-MRT"))
        assertEquals("the last page stays the last page", PinPages.ADD, PinPages.kept(pins, listOf("UTOWN"), PinPages.ADD))
        assertNull("nothing chosen: the first", PinPages.kept(pins, listOf("COM3"), null))
        assertEquals("one never seen (the profile came): the first", "COM3", PinPages.kept(emptyList(), listOf("COM3", "PGP"), "UTOWN"))
    }

    @Test
    fun eachPinnedStopIsAPageAndTheLastSaysHowToPinAnother() {
        val pins = listOf("UTOWN", "KR-MRT", "COM3")
        assertEquals(1, PinPages.index(pins, "KR-MRT"))
        assertEquals(3, PinPages.index(pins, PinPages.ADD))
        assertEquals("nothing chosen, or one not pinned: the first", 0, PinPages.index(pins, null))
        assertEquals(0, PinPages.index(pins, "PGP"))
        assertEquals("COM3", PinPages.at(pins, 2))
        assertEquals(PinPages.ADD, PinPages.at(pins, 3))
    }

    @Test
    fun theStopShowingIsAskedForWithItsNeighbours() {
        val pins = listOf("A", "B", "C", "D")
        assertEquals(listOf("A", "B"), PinPages.around(pins, 0))
        assertEquals(listOf("B", "C", "D"), PinPages.around(pins, 2))
        assertEquals("on the last page, the last stop", listOf("D"), PinPages.around(pins, 4))
        assertEquals(emptyList<String>(), PinPages.around(emptyList(), 0))
        // A swipe back and forth doesn't ask again for a stop asked for 4 s ago, only for one asked 12 s ago or never.
        val asked = mapOf("A" to 96_000L, "B" to 88_000L)
        assertEquals(listOf("B", "C"), PinPages.due(listOf("A", "B", "C", "C"), { asked[it] }, 100_000L, 10_000L))
    }

    @Test
    fun theStopOpenBesideTheHomeIsLeftToItsPage() {
        // Wide, the stop whose page is open is asked for by the page; the home's pinned refresh asks only for the rest.
        assertEquals(listOf("A", "C"), PinPages.due(listOf("A", "B", "C"), { null }, 100_000L, 10_000L, open = "B"))
        assertEquals(listOf("A", "B", "C"), PinPages.due(listOf("A", "B", "C"), { null }, 100_000L, 10_000L, open = null))
    }

    @Test
    fun aPinnedCardTakesItsOpenPagesTimes() {
        val guess = LaterBus(2_400, "scheduled")
        val old =
            PinnedStop(
                NearbyStop(
                    "COM3",
                    "COM 3",
                    null,
                    true,
                    listOf(
                        BoardRow("D1", 600, "live", later = listOf(LaterBus(900, "live"), guess), dest = "via UTown"),
                        BoardRow("D2", 700, "live", dest = "to PGP"),
                    ),
                ),
                1_000L,
            )
        val board =
            Board(
                "COM3",
                "Computing 3",
                null,
                true,
                listOf(BoardRow("D1", 120, "live", later = listOf(LaterBus(800, "live"))), BoardRow("95", 300, "live", paid = true)),
                null,
                gotMs = 50_000L,
            )
        val now = old.withBoard(board)
        val d1 = now.stop.board[0]
        assertEquals("the page's time", 120, d1.etaS)
        assertEquals(
            "the page's next bus, then the card's own guess after it, counted down the 49 s since the card's times",
            listOf(LaterBus(800, "live"), LaterBus(2_351, "scheduled")),
            d1.later,
        )
        assertEquals("the card's words", "via UTown", d1.dest)
        assertEquals("a service the page doesn't have keeps its row; no paid bus joins", listOf("D1", "D2"), now.stop.board.map { it.svc })
        assertEquals(50_000L, now.gotMs)
        assertEquals("the walk and name are the card's own", "COM 3", now.stop.name)
    }

    @Test
    fun anOpenPinnedCardsGuessesCountDownAndNeverPassAnOldLiveTimeOff() {
        val card =
            PinnedStop(
                NearbyStop(
                    "COM3",
                    "COM 3",
                    null,
                    true,
                    listOf(BoardRow("D1", 300, "live", later = listOf(LaterBus(900, "live"), LaterBus(1_500, "scheduled")))),
                ),
                gotMs = 0L,
            )
        fun board(atMs: Long, etaS: Int, laterS: Int) =
            Board(
                "COM3",
                "Computing 3",
                null,
                true,
                listOf(BoardRow("D1", etaS, "live", later = listOf(LaterBus(laterS, "live")))),
                null,
                gotMs = atMs,
            )
        // A minute on: the card's own live "then" isn't carried (it's old); its guess is a minute nearer.
        val one = card.withBoard(board(60_000L, 240, 840))
        assertEquals(listOf(LaterBus(840, "live"), LaterBus(1_440, "scheduled")), one.stop.board[0].later)
        assertEquals("its own answer is still when it was got", 0L, one.answeredMs)
        // Merged again 15 s later: counted down from the last merge, not frozen at the first.
        val two = one.withBoard(board(75_000L, 225, 825))
        assertEquals(listOf(LaterBus(825, "live"), LaterBus(1_425, "scheduled")), two.stop.board[0].later)
        // Once the board's last bus is as late as the guess, the guess goes.
        val three = two.withBoard(board(90_000L, 210, 1_500))
        assertEquals(listOf(LaterBus(1_500, "live")), three.stop.board[0].later)
        // And a guess already due is dropped.
        assertEquals(emptyList<LaterBus>(), PinnedStop.guessesAfter(listOf(LaterBus(30, "scheduled")), 60, 0))
        // The merged times are what the card keeps: live, from the board, when its page closes.
        assertEquals("live", three.stop.board[0].quality)
        assertEquals(90_000L, three.gotMs)
    }

    @Test
    fun anOpenPinnedCardAsksAgainWhenItsOwnAnswerIsOld() {
        val card = PinnedStop(NearbyStop("COM3", "COM 3", null, true, emptyList()), gotMs = 0L)
        assertTrue(card.answerFresh(PinnedStop.ANSWER_MS - 1))
        assertFalse("then once more, for fresh guesses", card.answerFresh(PinnedStop.ANSWER_MS))
        assertFalse(PinnedStop(card.stop, null).answerFresh(0L))
    }

    @Test
    fun theLinesAreAskedForAtMostOnceAMinute() {
        assertEquals("never asked: now", 0L, LinesPoll.waitMs(null, 1_000_000L))
        assertEquals(40_000L, LinesPoll.waitMs(1_000_000L, 1_020_000L))
        assertEquals("a minute on: now", 0L, LinesPoll.waitMs(1_000_000L, 1_060_000L))
        assertEquals("the clock put back: no more than a minute", 60_000L, LinesPoll.waitMs(1_000_000L, 900_000L))
        // Asleep until it's due; a whole minute when it couldn't be asked (no account yet), not a busy loop.
        assertEquals(40_000L, LinesPoll.nextMs(1_000_000L, 1_020_000L))
        assertEquals(60_000L, LinesPoll.nextMs(null, 1_020_000L))
    }

    @Test
    fun theLinesCountsParseAndAnUnreachableOneIsNull() {
        val out =
            LineOut.parse(
                JSONObject(
                    """{"lines": {"A1": {"out": 3, "outText": "3 out", "stale": false}, "K": {"out": 0, "outText": "None out", "stale": true}, "P": null},
                    "asOf": "2026-08-27T01:00:00.000Z"}"""
                )
            )
        assertEquals(LineOut(3, "3 out", false), out["A1"])
        assertEquals(LineOut(0, "None out", true), out["K"])
        assertTrue("P is there, unknown", out.containsKey("P"))
        assertNull(out["P"])
        assertEquals(emptyMap<String, LineOut?>(), LineOut.parse(JSONObject("{}")))
    }

    @Test
    fun aServicesPageBringsTheListItsNewerCountAndAnOlderListKeepsIt() {
        val one = LineOut(1, "1 out", false)
        val none = LineOut(0, "None out", false)
        // The page's own count, as /api/line gives it; none from an older server.
        val line =
            Line.parse(JSONObject("""{"svc": "K", "stops": [], "buses": [], "out": {"out": 0, "outText": "None out", "stale": false}}"""))
        assertEquals(none, line.out)
        assertNull(Line.parse(JSONObject("""{"svc": "K", "stops": [], "buses": []}""")).out)
        // The list counted K's last bus a moment before it left the feed; K's page, later, has none out.
        var outs = Outs().listed(mapOf("K" to one, "D1" to one), 1_000L)
        outs = outs.paged("K", line.out, 31_000L)
        assertEquals(mapOf("K" to none, "D1" to one), outs.shown)
        // A list counted before the page keeps the page's count; a newer one wins.
        assertEquals(mapOf("K" to none, "D1" to one), outs.listed(mapOf("K" to one, "D1" to one), 11_000L).shown)
        assertEquals(mapOf("K" to one, "D1" to none), outs.listed(mapOf("K" to one, "D1" to none), 51_000L).shown)
        // An older answer for the page changes nothing; no count, nothing; no list, nothing shown.
        assertEquals(outs, outs.paged("K", one, 21_000L))
        assertEquals(outs, outs.paged("K", null, 41_000L))
        assertEquals(emptyMap<String, LineOut?>(), outs.listed(emptyMap(), 0).shown)
    }

    @Test
    fun aLineIsNamedAndSaidAsTheServerWordsIt() {
        val routes =
            CampusMap.serviceRoutes(
                JSONObject(
                    """{"A1": {"seq": ["KR-BT", "AS5"], "loop": true, "name": "Loop from KR Bus Ter", "via": "via AS 5, PGP, KR MRT"},
                    "R2": {"seq": ["PGP", "KV"], "loop": false, "name": "PGP to Kent Vale", "via": null},
                    "D1": {"seq": ["COM3", "UTOWN"], "loop": true}}"""
                )
            )
        assertEquals(ServiceRoute("A1", listOf("KR-BT", "AS5"), true, "Loop from KR Bus Ter", "via AS 5, PGP, KR MRT"), routes[0])
        TestStrings.install()
        try {
            val a1 = LineRow.of(routes[0], LineOut(3, "3 out", false)) { it }
            assertTrue(a1.live)
            assertEquals("Bus A1, Loop from KR Bus Ter, via AS 5, PGP, KR MRT, 3 out", a1.said())
            val r2 = LineRow.of(routes[1], LineOut(0, "None out", false)) { it }
            assertNull(r2.via)
            assertFalse("none out: the words without the dot", r2.live)
            assertFalse("a count from last time isn't live: no dot", LineRow("K", "K", null, LineOut(2, "2 out", true)).live)
            assertEquals("Bus R2, PGP to Kent Vale, None out", r2.said())
            // Unreachable: nothing said or shown for its buses.
            assertEquals("Bus A1, Loop from KR Bus Ter, via AS 5, PGP, KR MRT", LineRow.of(routes[0], null) { it }.said())
            // A campus kept from an older server, without the name: worded here from its stops.
            val names = mapOf("COM3" to "COM 3")
            assertEquals("Loop from COM 3", LineRow.of(routes[2], null) { names[it] ?: it }.name)
            TestStrings.install("values-zh")
            val zh = LineRow("A1", "KR Bus Ter 环线", "经 AS 5、PGP、KR MRT", LineOut(3, "3 辆在路上", false))
            assertEquals("A1 巴士，KR Bus Ter 环线，经 AS 5、PGP、KR MRT，3 辆在路上", zh.said())
        } finally {
            TestStrings.install()
        }
    }

    @Test
    fun aPinnedStopWithoutALocationHasNoWalk() {
        TestStrings.install()
        val stops =
            parseNearby(
                JSONObject(
                    """{"stops": [{"stop": {"code": "UTOWN", "name": "UTown"}, "walkS": null, "available": true, "board": []},
                    {"stop": {"code": "COM3", "name": "COM 3"}, "walkS": 540, "available": true, "board": []},
                    {"stop": {"code": "PGP", "name": "PGP"}, "walkS": 20, "available": true, "board": []}], "asOf": "2026-08-27T01:00:00.000Z"}"""
                )
            )
        assertNull(stops[0].walkS)
        assertNull(stops[0].walkWords)
        assertEquals("9 min walk", stops[1].walkWords)
        assertEquals("here", stops[2].walkWords)
    }

    @Test
    fun aPinnedStopsTimesAreCountedDownOnceOld() {
        val row = BoardRow("D2", etaS = 600, quality = "live")
        val stop = NearbyStop("COM3", "COM 3", null, true, listOf(row))
        val pinned = PinnedStop(stop, gotMs = 1_000_000L)
        assertEquals("fresh: as it came", stop, pinned.aged(1_010_000L))
        val old = pinned.aged(1_000_000L + 120_000L).board.single()
        assertEquals(480, old.etaS)
        assertEquals("not passed off as live", "stale", old.quality)
        assertEquals("no time to count from: as it came", stop, PinnedStop(stop, null).aged(9_999_999L))
    }

    @Test
    fun aServiceSaysWhereItGoes() {
        val names = mapOf("KR-MRT" to "Kent Ridge MRT", "COM3" to "COM 3", "UTOWN" to "University Town")
        val name = { code: String -> names[code] ?: code }
        TestStrings.install()
        try {
            assertEquals("Loop from Kent Ridge MRT", serviceWhere(ServiceRoute("A1", listOf("KR-MRT", "COM3"), loop = true), name))
            assertEquals(
                "COM 3 to University Town",
                serviceWhere(ServiceRoute("D1", listOf("COM3", "KR-MRT", "UTOWN"), loop = false), name),
            )
            assertNull("no stops, no words", serviceWhere(ServiceRoute("X", emptyList(), loop = false), name))
            TestStrings.install("values-zh")
            assertEquals("Kent Ridge MRT 环线", serviceWhere(ServiceRoute("A1", listOf("KR-MRT"), loop = true), name))
            assertEquals("COM 3 至 University Town", serviceWhere(ServiceRoute("D1", listOf("COM3", "UTOWN"), loop = false), name))
        } finally {
            TestStrings.install()
        }
    }

    @Test
    fun pinnedStopsLiveInTheProfile() {
        val p = ProfileDoc(JSONObject("""{"lang": "auto", "future": 1}"""))
        assertEquals(emptyList<String>(), p.pinnedStops)
        p.pinnedStops = listOf("YIH", "CLB", "YIH")
        assertEquals(listOf("YIH", "CLB"), p.pinnedStops)
        assertEquals("fields this version doesn't know survive", 1, p.json.getInt("future"))
    }

    @Test
    fun theSearchFindsServicesAndStops() {
        val stops =
            listOf(
                MapStop("COM3", "COM 3", 0.0, 0.0, listOf("D1", "D2")),
                MapStop("KR-MRT", "KR MRT", 0.0, 0.0, listOf("A1", "D2"), longName = "Kent Ridge MRT"),
                MapStop("KV", "Kent Vale", 0.0, 0.0, listOf("K")),
                MapStop("YIH", "YIH", 0.0, 0.0, listOf("A1", "D1", "K"), longName = "Yusof Ishak House"),
            )
        val index = busesTabIndex(stops, listOf("K", "D2", "A1", "D1", "A2"), mapOf("KR-MRT" to listOf("mrt")))
        fun names(q: String) = searchBuses(q, index).map { if (it is BusHit.Service) it.svc else (it as BusHit.Stop).code }
        assertEquals("the service first, then stops starting with it", listOf("K", "KV", "KR-MRT", "YIH"), names("k"))
        assertEquals(listOf("D1"), names("d1"))
        assertEquals(listOf("D1", "D2", "KR-MRT"), names("d"))
        assertEquals(listOf("YIH"), names("ishak"))
        assertEquals(listOf("YIH"), names("yih"))
        assertEquals("a nickname", listOf("KR-MRT"), names("mrt"))
        assertEquals("nothing typed: every service", listOf("A1", "A2", "D1", "D2", "K"), names("  "))
    }

    @Test
    fun theFullNameIsShownWhereTheServerGivesOne() {
        val b =
            Board.parse(
                JSONObject("""{"stop": {"code": "YIH", "name": "YIH", "longName": "Yusof Ishak House", "opposite": null}, "board": []}""")
            )
        assertEquals("Yusof Ishak House", b.name)
        val l =
            Line.parse(
                JSONObject(
                    """{"svc": "D1", "stops": [{"code": "CLB", "name": "CLB", "longName": "Central Library", "services": []}], "buses": []}"""
                )
            )
        assertEquals("Central Library", l.stops.single().name)
        val near =
            parseNearby(
                    JSONObject("""{"stops": [{"stop": {"code": "YIH", "name": "YIH", "longName": "Yusof Ishak House"}, "board": []}]}""")
                )
                .single()
        assertEquals("the widget keeps the short name", "YIH", near.name)
        assertEquals("Yusof Ishak House", Board.of(near, null).name)
        val stops = listOf(MapStop("CLB", "CLB", 0.0, 0.0, listOf("A1"), longName = "Central Library"))
        val hit = searchBuses("library", busesTabIndex(stops, emptyList(), emptyMap())).single() as BusHit.Stop
        assertEquals("Central Library", hit.name)
    }

    @Test
    fun anEmptyTowardsIsTheEndOfTheLine() {
        val b =
            Board.parse(
                JSONObject(
                    """{"stop": {"code": "PGPR"}, "board": [{"svc": "K", "etaS": 600, "quality": "live", "towards": []}, {"svc": "A1", "etaS": 60, "quality": "live", "towards": ["LT 27"]}]}"""
                )
            )
        assertTrue(b.rows[0].endsHere)
        assertFalse(b.rows[1].endsHere)
        val old = Board.parse(JSONObject("""{"stop": {"code": "PGPR"}, "board": [{"svc": "K", "etaS": 600, "quality": "live"}]}"""))
        assertFalse("an older server says nothing of where it goes", old.rows[0].endsHere)
    }

    @Test
    fun anOppositeOnlyNearByIsNotAcrossTheRoad() {
        val b =
            Board.parse(
                JSONObject(
                    """{"stop": {"code": "PGPR", "opposite": "PGP", "oppositeAcross": false, "oppositeName": "Prince George's Park"}, "board": []}"""
                )
            )
        assertFalse(b.oppositeAcross)
        assertEquals("Prince George's Park", b.oppositeName)
        assertTrue("an older server: across the road, as before", Board.parse(arrivals).oppositeAcross)
        val near =
            parseNearby(
                    JSONObject(
                        """{"stops": [{"stop": {"code": "PGP", "name": "PGP"}, "opposite": "PGPR", "oppositeAcross": false, "oppositeName": "Prince George's Park Foyer", "board": []}]}"""
                    )
                )
                .single()
        val nb = Board.of(near, null)
        assertFalse(nb.oppositeAcross)
        assertEquals("Prince George's Park Foyer", nb.oppositeName)
    }

    private fun at(iso: String) = java.time.Instant.parse(iso).toEpochMilli()

    @Test
    fun aStoppedRowParsesAndAnOlderOneRuns() {
        val b =
            Board.parse(
                JSONObject(
                    """{"stop": {"code": "PGP"}, "board": [
          {"svc": "R1", "etaS": null, "quality": "ended", "later": [], "towards": ["Kent Ridge MRT"], "running": false, "stopped": "ended", "resumesAt": "2026-10-07T23:40:00.000Z"},
          {"svc": "A1", "etaS": 60, "quality": "live", "later": []}]}"""
                )
            )
        val r1 = b.rows[0]
        assertFalse(r1.running)
        assertEquals("ended", r1.stopped)
        assertEquals(at("2026-10-07T23:40:00Z"), r1.resumesAtMs)
        assertTrue("no `running` from an older server: running", b.rows[1].running)
        assertNull(b.rows[1].stopped)
        val l =
            Line.parse(
                JSONObject("""{"svc": "R1", "stops": [], "buses": [], "running": false, "stopped": "noService", "resumesAt": null}""")
            )
        assertFalse(l.running)
        assertEquals("noService", l.stopped)
        assertTrue(Line.parse(JSONObject("""{"svc": "R1", "stops": [], "buses": []}""")).running)
    }

    @Test
    fun aStoppedServiceSaysWhenItsBackInSingaporeDays() {
        TestStrings.install()
        // Wednesday 21:30 in Singapore.
        val now = at("2026-10-07T13:30:00Z")
        assertNull(Stopped.of(true, null, null, now))
        // Thursday 07:40 in Singapore: tomorrow, though it's the same UTC day.
        assertEquals(
            "Stopped for today" to "Back tomorrow at 7:40 AM",
            Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(true),
        )
        assertEquals(
            "Stopped for today" to "Back tomorrow at 07:40",
            Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(false),
        )
        // Saturday morning, back Monday.
        val sat = at("2026-10-10T02:00:00Z")
        assertEquals(
            "No service today" to "Back Monday at 7:40 AM",
            Stopped.of(false, "noService", at("2026-10-11T23:40:00Z"), sat)!!.lines(true),
        )
        // 06:00 on a weekday: later today, so it starts, never "Back today".
        val early = at("2026-10-07T22:00:00Z")
        assertEquals("Not running yet" to "Starts at 7:04 AM", Stopped.of(false, "notYet", at("2026-10-07T23:04:00Z"), early)!!.lines(true))
        assertEquals("No time found: the first line only", "Stopped for today" to null, Stopped.of(false, "ended", null, now)!!.lines(true))
    }

    @Test
    fun aStoppedServiceInChinese() {
        TestStrings.install("values-zh")
        try {
            val now = at("2026-10-07T13:30:00Z")
            assertEquals("今天已停运" to "明天 07:40 恢复", Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(false))
            assertEquals(
                "今天不运行" to "星期一 07:40 恢复",
                Stopped.of(false, "noService", at("2026-10-11T23:40:00Z"), at("2026-10-10T02:00:00Z"))!!.lines(false),
            )
        } finally {
            TestStrings.install()
        }
    }

    @Test
    fun onlyABusSeenIsArriving() {
        assertTrue(BusTimes.arriving(30, "live"))
        assertFalse(BusTimes.arriving(45, "live"))
        assertFalse(BusTimes.arriving(30, "scheduled"))
        assertFalse(BusTimes.arriving(0, "stale"))
        assertFalse(BusTimes.arriving(null, "live"))
    }

    @Test
    fun theRoadSaysAnEstimateIsAboutAMinuteNeverArriving() {
        TestStrings.install()
        assertEquals("arriving at COM3", roadWords("COM3", 30, live = true))
        assertEquals("reaches COM3 in about 1 min", roadWords("COM3", 30, live = false))
        assertEquals("reaches COM3 in about 6 min", roadWords("COM3", 360, live = false))
        assertEquals("from COM3", roadWords("COM3", 0, live = false))
    }
}
