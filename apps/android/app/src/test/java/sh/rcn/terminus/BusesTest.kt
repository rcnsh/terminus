package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Buses tab's data, from replies shaped like the API's (/arrivals, /me/nearby, /line). */
class BusesTest {
    private val arrivals = JSONObject(
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
        """,
    )

    @Test fun anArrivalsBoardParsesEveryNewField() {
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

    @Test fun anOlderServersBoardStillParses() {
        val b = Board.parse(JSONObject("""{"stop": {"code": "COM3", "name": "COM 3"}, "board": [{"svc": "D2", "etaS": 120, "quality": "live", "later": []}], "available": true}"""))
        assertNull(b.opposite)
        val r = b.rows.single()
        assertEquals(emptyList<String>(), r.towards)
        assertNull(r.crowd)
        assertNull(r.endsAtMs)
        assertNull(r.color)
        assertNull(b.asOfMs)
    }

    @Test fun nearbyRowsCarryTheNewFieldsAndTheDistance() {
        val json = JSONObject(
            """
            {"stops": [{"stop": {"code": "YIH", "name": "Yusof Ishak House"}, "opposite": "YIH-OPP", "distM": 40, "walkS": 35, "available": true,
              "board": [{"svc": "A1", "etaS": 240, "quality": "live", "later": [{"etaS": 720, "quality": "live"}], "color": "#e53935", "towards": ["Central Library"], "crowd": "high", "endsAt": null}]}],
             "asOf": "2026-10-07T02:42:00.000Z"}
            """,
        )
        val s = parseNearby(json).single()
        assertEquals(40, s.distM)
        val board = Board.of(s, 5L)
        assertEquals("YIH-OPP", board.opposite)
        assertEquals(40, board.distM)
        assertEquals("high", board.rows.single().crowd)
        assertEquals(listOf("Central Library"), board.rows.single().towards)
    }

    @Test fun theMapsBoardKeepsOnlyRowsWithATime() {
        assertEquals(listOf("K", "151"), StopBoard.parse(arrivals).rows.map { it.svc })
    }

    @Test fun timesComeOnlyFromTheApi() {
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

    @Test fun onlyServicesEndingWithinTwoHoursSayWhen() {
        val now = java.time.Instant.parse("2026-10-07T14:00:00Z").toEpochMilli()
        val rows = listOf(
            BoardRow("D1", 60, "live", endsAtMs = now + 75 * 60_000),
            BoardRow("D1", 600, "live", endsAtMs = now + 75 * 60_000),
            BoardRow("R1", 60, "live", endsAtMs = now + 30 * 60_000),
            BoardRow("A1", 60, "live", endsAtMs = now + 3 * 3_600_000),
            BoardRow("K", 60, "live", endsAtMs = now - 60_000),
            BoardRow("D2", 60, "live"),
        )
        assertEquals(listOf("R1", "D1"), BusTimes.endingSoon(rows, now).map { it.first })
    }

    @Test fun campusTimeIsSingapores() {
        assertEquals(23 * 60 + 15, BusTimes.campusMinute(java.time.Instant.parse("2026-10-07T15:15:00Z").toEpochMilli()))
    }

    private val line = JSONObject(
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
        """,
    )

    @Test fun aLineParsesWithItsBusesPlaced() {
        val l = Line.parse(line)
        assertEquals("D1", l.svc)
        assertEquals(0xFFEC4FA0L, l.color)
        assertEquals(4, l.stops.size)
        assertEquals(listOf("C", "D2"), l.stops[3].services)
        assertEquals("a bus placed off the list isn't drawn", 3, l.buses.count { it.at != null || it.after != null })
        assertEquals(2, l.here?.index)
        assertEquals(420, l.here?.row?.etaS)
    }

    @Test fun theLineIsDrawnStopsWithBusesBetween() {
        val items = Line.parse(line).items()
        val shape = items.map {
            when (it) {
                is LineItem.Stop -> "${it.stop.code}${if (it.buses.isNotEmpty()) "*" else ""}${if (it.here) "!" else ""}"
                is LineItem.Between -> "~${it.after}"
            }
        }
        // The bus after the last stop is on its way round to the first.
        assertEquals(listOf("COM3", "~0", "IT", "YIH-OPP*!", "UTOWN", "~3"), shape)
    }

    @Test fun aLineWithoutTheStopOrBusesStillParses() {
        val l = Line.parse(JSONObject("""{"svc": "A1", "color": null, "endsAt": null, "stops": [{"code": "PGP", "name": "PGP", "services": []}], "buses": [], "available": false}"""))
        assertNull(l.here)
        assertFalse(l.available)
        assertEquals(0xFF8A939CL, l.color)
        assertEquals(1, l.items().size)
    }

    @Test fun pinsToggleAndStopAtEight() {
        assertEquals(listOf("A", "B"), Pins.toggle(listOf("A"), "B"))
        assertEquals(listOf("B"), Pins.toggle(listOf("A", "B"), "A"))
        val full = (1..8).map { "S$it" }
        assertEquals("a ninth isn't added", full, Pins.toggle(full, "S9"))
        assertEquals(full - "S3", Pins.toggle(full, "S3"))
    }

    @Test fun pagesAreTheNearestThenThePinnedOnes() {
        assertEquals(listOf("YIH", "CLB", "COM3"), Pins.pages("YIH", listOf("CLB", "YIH", "COM3")))
        assertEquals(listOf(null, "CLB"), Pins.pages(null, listOf("CLB", "CLB")))
    }

    @Test fun pinnedStopsLiveInTheProfile() {
        val p = ProfileDoc(JSONObject("""{"lang": "auto", "future": 1}"""))
        assertEquals(emptyList<String>(), p.pinnedStops)
        p.pinnedStops = listOf("YIH", "CLB", "YIH")
        assertEquals(listOf("YIH", "CLB"), p.pinnedStops)
        assertEquals("fields this version doesn't know survive", 1, p.json.getInt("future"))
    }

    @Test fun theSearchFindsServicesAndStops() {
        val stops = listOf(
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

    @Test fun theFullNameIsShownWhereTheServerGivesOne() {
        val b = Board.parse(JSONObject("""{"stop": {"code": "YIH", "name": "YIH", "longName": "Yusof Ishak House", "opposite": null}, "board": []}"""))
        assertEquals("Yusof Ishak House", b.name)
        val l = Line.parse(JSONObject("""{"svc": "D1", "stops": [{"code": "CLB", "name": "CLB", "longName": "Central Library", "services": []}], "buses": []}"""))
        assertEquals("Central Library", l.stops.single().name)
        val near = parseNearby(JSONObject("""{"stops": [{"stop": {"code": "YIH", "name": "YIH", "longName": "Yusof Ishak House"}, "board": []}]}""")).single()
        assertEquals("the widget keeps the short name", "YIH", near.name)
        assertEquals("Yusof Ishak House", Board.of(near, null).name)
        val stops = listOf(MapStop("CLB", "CLB", 0.0, 0.0, listOf("A1"), longName = "Central Library"))
        val hit = searchBuses("library", busesTabIndex(stops, emptyList(), emptyMap())).single() as BusHit.Stop
        assertEquals("Central Library", hit.name)
    }

    @Test fun anEmptyTowardsIsTheEndOfTheLine() {
        val b = Board.parse(JSONObject("""{"stop": {"code": "PGPR"}, "board": [{"svc": "K", "etaS": 600, "quality": "live", "towards": []}, {"svc": "A1", "etaS": 60, "quality": "live", "towards": ["LT 27"]}]}"""))
        assertTrue(b.rows[0].endsHere)
        assertFalse(b.rows[1].endsHere)
        val old = Board.parse(JSONObject("""{"stop": {"code": "PGPR"}, "board": [{"svc": "K", "etaS": 600, "quality": "live"}]}"""))
        assertFalse("an older server says nothing of where it goes", old.rows[0].endsHere)
    }

    @Test fun aTwinOnlyNearByIsNotAcrossTheRoad() {
        val b = Board.parse(JSONObject("""{"stop": {"code": "PGPR", "opposite": "PGP", "oppositeAcross": false, "oppositeName": "Prince George's Park"}, "board": []}"""))
        assertFalse(b.oppositeAcross)
        assertEquals("Prince George's Park", b.oppositeName)
        assertTrue("an older server: across the road, as before", Board.parse(arrivals).oppositeAcross)
        val near = parseNearby(JSONObject("""{"stops": [{"stop": {"code": "PGP", "name": "PGP"}, "opposite": "PGPR", "oppositeAcross": false, "oppositeName": "Prince George's Park Foyer", "board": []}]}""")).single()
        val nb = Board.of(near, null)
        assertFalse(nb.oppositeAcross)
        assertEquals("Prince George's Park Foyer", nb.oppositeName)
    }

    private fun at(iso: String) = java.time.Instant.parse(iso).toEpochMilli()

    @Test fun aStoppedRowParsesAndAnOlderOneRuns() {
        val b = Board.parse(JSONObject("""{"stop": {"code": "PGP"}, "board": [
          {"svc": "R1", "etaS": null, "quality": "ended", "later": [], "towards": ["Kent Ridge MRT"], "running": false, "stopped": "ended", "resumesAt": "2026-10-07T23:40:00.000Z"},
          {"svc": "A1", "etaS": 60, "quality": "live", "later": []}]}"""))
        val r1 = b.rows[0]
        assertFalse(r1.running)
        assertEquals("ended", r1.stopped)
        assertEquals(at("2026-10-07T23:40:00Z"), r1.resumesAtMs)
        assertTrue("no `running` from an older server: running", b.rows[1].running)
        assertNull(b.rows[1].stopped)
        val l = Line.parse(JSONObject("""{"svc": "R1", "stops": [], "buses": [], "running": false, "stopped": "noService", "resumesAt": null}"""))
        assertFalse(l.running)
        assertEquals("noService", l.stopped)
        assertTrue(Line.parse(JSONObject("""{"svc": "R1", "stops": [], "buses": []}""")).running)
    }

    @Test fun aStoppedServiceSaysWhenItsBackInSingaporeDays() {
        TestStrings.install()
        // Wednesday 21:30 in Singapore.
        val now = at("2026-10-07T13:30:00Z")
        assertNull(Stopped.of(true, null, null, now))
        // Thursday 07:40 in Singapore: tomorrow, though it's the same UTC day.
        assertEquals("Stopped for today" to "Back tomorrow at 7:40 AM", Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(true))
        assertEquals("Stopped for today" to "Back tomorrow at 07:40", Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(false))
        // Saturday morning, back Monday.
        val sat = at("2026-10-10T02:00:00Z")
        assertEquals("No service today" to "Back Monday at 7:40 AM", Stopped.of(false, "noService", at("2026-10-11T23:40:00Z"), sat)!!.lines(true))
        // 06:00 on a weekday: later today, so it starts, never "Back today".
        val early = at("2026-10-07T22:00:00Z")
        assertEquals("Not running yet" to "Starts at 7:04 AM", Stopped.of(false, "notYet", at("2026-10-07T23:04:00Z"), early)!!.lines(true))
        assertEquals("No time found: the first line only", "Stopped for today" to null, Stopped.of(false, "ended", null, now)!!.lines(true))
    }

    @Test fun aStoppedServiceInChinese() {
        TestStrings.install("values-zh")
        try {
            val now = at("2026-10-07T13:30:00Z")
            assertEquals("今天已停运" to "明天 07:40 恢复", Stopped.of(false, "ended", at("2026-10-07T23:40:00Z"), now)!!.lines(false))
            assertEquals("今天不运行" to "星期一 07:40 恢复", Stopped.of(false, "noService", at("2026-10-11T23:40:00Z"), at("2026-10-10T02:00:00Z"))!!.lines(false))
        } finally {
            TestStrings.install()
        }
    }
}
