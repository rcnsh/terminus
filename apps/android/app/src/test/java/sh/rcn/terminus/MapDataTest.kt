package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Map tab's data, from replies shaped like the API's (see its /campus and /buses tests). */
class MapDataTest {
    private val campusJson = JSONObject(
        """
        {"stops": [
          {"code": "COM3", "name": "COM 3", "lat": 1.2948, "lon": 103.7745, "services": ["D1", "D2"], "core": true},
          {"code": "BG-MRT", "name": "Botanic Gdns MRT", "lat": 1.3224, "lon": 103.8153, "services": ["P"], "core": false}
         ],
         "routes": {
          "D2": {"seq": ["COM3"], "loop": true, "color": "#8e44c9", "line": [[103.7745, 1.2948], [103.7750, 1.2950], [103.7760, 1.2955]], "shaped": true},
          "A1": {"seq": ["COM3"], "loop": true, "color": "#e53935", "line": [[103.77, 1.29], [103.78, 1.30]], "shaped": true},
          "X": {"seq": [], "loop": false, "color": "nope", "line": [], "shaped": false}
         }}
        """,
    )

    @Test fun campusParsesStopsRoutesAndColours() {
        val (campus, core) = CampusMap.parse(campusJson)
        assertEquals(listOf("A1", "D2"), campus.services)
        assertEquals(0xFF8E44C9L, campus.routes.getValue("D2").color)
        assertEquals(listOf("D1", "D2"), campus.stop("COM3")?.services)
        assertEquals("only the main campus's stops", setOf("COM3"), core)
        val b = campus.routes.getValue("D2").bounds()
        assertEquals(103.7745, b[0], 1e-9)
        assertEquals(1.2955, b[3], 1e-9)
    }

    @Test fun aTapTakingInTwoStopsOpensTheNearer() {
        val (campus, _) = CampusMap.parse(campusJson)
        assertEquals("BG-MRT", campus.nearest(listOf("COM3", "BG-MRT"), 1.3220, 103.8150))
        assertEquals("COM3", campus.nearest(listOf("BG-MRT", "COM3"), 1.2950, 103.7746))
        assertEquals("without a position, the first", "COM3", campus.nearest(listOf("COM3", "BG-MRT"), null, null))
        assertNull(campus.nearest(emptyList(), 1.0, 103.0))
    }

    @Test fun badColoursAreGrey() {
        assertEquals(0xFF8A939CL, parseColor("nope"))
        assertEquals(0xFF8A939CL, parseColor(null))
        assertEquals(0xFFD9A000L, parseColor("#d9a000"))
    }

    @Test fun busesParseWithoutPlates() {
        val list = BusList.parse(
            JSONObject(
                """{"svc": "D2", "color": "#8e44c9", "available": true, "stale": false, "asOf": "2026-10-02T01:00:00Z",
                   "buses": [
                     {"id": "3f9a1c0b7e21", "lat": 1.295, "lon": 103.775, "heading": 92, "moving": true, "crowd": "high", "nextStop": {"code": "COM3", "name": "COM 3"}},
                     {"id": "aa", "lat": 1.3, "lon": 103.76, "heading": null, "moving": false, "crowd": null, "nextStop": null}
                   ]}""",
            ),
        )
        assertTrue(list.available)
        assertEquals("COM 3", list.buses[0].nextStop)
        assertEquals("high", list.buses[0].crowd)
        assertNull(list.buses[1].heading)
        assertNull(list.buses[1].crowd)
        assertNull(list.buses[1].nextStop)
        assertFalse(BusList.parse(JSONObject("""{"svc": "K", "available": false, "buses": []}""")).available)
    }

    @Test fun boardDropsRowsWithNoTime() {
        val b = StopBoard.parse(JSONObject("""{"available": true, "board": [{"svc": "D2", "etaS": 240, "quality": "live"}, {"svc": "D1", "etaS": null, "quality": "none"}]}"""))
        assertEquals(listOf("D2"), b.rows.map { it.svc })
    }

    @Test fun geoJsonForTheMap() {
        val (campus, _) = CampusMap.parse(campusJson)
        val stops = JSONObject(MapGeoJson.stops(campus)).getJSONArray("features")
        assertEquals(" D1 D2 ", stops.getJSONObject(0).getJSONObject("properties").getString("services"))
        val routes = JSONObject(MapGeoJson.routes(campus)).getJSONArray("features")
        assertEquals(2, routes.length())
        val bus = LiveBus("b1", 1.0, 103.0, null, true, null, null)
        val props = JSONObject(MapGeoJson.buses("D2", 0xFF8E44C9L, listOf(bus))).getJSONArray("features").getJSONObject(0).getJSONObject("properties")
        assertEquals("#8e44c9", props.getString("color"))
        assertFalse("no heading, no arrow", props.getBoolean("moving"))
    }

    @Test fun busesGlideStraightAShortWayOffTheirLine() {
        val g = Glides(ms = 1_000)
        val was = LiveBus("b1", 1.0, 103.0, 0.0, true, null, null)
        g.update(listOf(was), null, 0)
        // 0.001 deg is about 110 m: a glide.
        val now = was.copy(lat = 1.001)
        g.update(listOf(now, now.copy(id = "new")), null, 0)
        val half = g.at(500)
        assertEquals(1.0005, half[0].lat, 1e-9)
        assertEquals("a new bus appears where it is", 1.001, half[1].lat, 1e-9)
        assertTrue(g.moving(500))
        assertFalse(g.moving(1_000))
        // About 1.1 km: it jumps.
        g.update(listOf(now.copy(lat = 1.011)), null, 1_000)
        assertEquals(1.011, g.at(1_000)[0].lat, 1e-9)
    }

    @Test fun busesGlideAlongTheirLineRoundACorner() {
        // East, then north: an L with its corner at (103.001, 1.0).
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.001, 1.0), doubleArrayOf(103.001, 1.001)))
        val leg = RoutePath.haversine(1.0, 103.0, 1.0, 103.001)
        fun at(m: Double) = path.pointAt(m).let { (lat, lon) -> LiveBus("b1", lat, lon, 0.0, true, null, null, along = m) }
        val g = Glides(ms = 1_000)
        g.update(listOf(at(leg - 50)), path, 0)
        g.update(listOf(at(leg + 50)), path, 0)
        val half = g.at(500)[0]
        assertEquals("at the corner, not cutting it", 1.0, half.lat, 1e-9)
        assertEquals(103.001, half.lon, 1e-9)
        // The same position again, mid-glide: it keeps going.
        g.update(listOf(at(leg + 50)), path, 600)
        val later = g.at(750)[0]
        assertEquals("on the north leg", 103.001, later.lon, 1e-9)
        assertEquals("pointing north", 0.0, later.heading!!, 1e-6)
        // A new position mid-glide: on from where it's drawn, not from the old start.
        g.update(listOf(at(leg + 100)), path, 750)
        assertEquals(later.lat, g.at(750)[0].lat, 1e-9)
        // Put back a little (GPS error): it stays put rather than reversing.
        g.update(listOf(at(leg + 80)), path, 2_000)
        assertEquals(path.pointAt(leg + 100).first, g.at(2_500)[0].lat, 1e-9)
        // A line that isn't the API's (kept from before the route changed), or off its line: not along it.
        assertNull(path.alongBy(at(0.0), at(50.0).copy(lat = 1.001)))
        assertNull(path.alongBy(at(0.0).copy(along = null), at(50.0)))
    }

    @Test fun busesNeverCutAcrossTheRoadBetweenTheTwoSidesOfTheirLine() {
        // Out east about 2.2 km, then back west 8 m north: one road, both ways.
        val east = 0.02
        val north = 8 / 110_574.0
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.0 + east, 1.0), doubleArrayOf(103.0 + east, 1.0 + north), doubleArrayOf(103.0, 1.0 + north)))
        val out = RoutePath.haversine(1.0, 103.0, 1.0, 103.0 + east)
        fun at(m: Double) = path.pointAt(m).let { (lat, lon) -> LiveBus("b1", lat, lon, 0.0, true, null, null, along = m) }
        val g = Glides(ms = 1_000)
        g.update(listOf(at(280.0)), path, 0)
        // The other side, 8 m away but kilometres along the route: it jumps there.
        val across = at(out + 8 + (out - 280.0))
        g.update(listOf(across), path, 0)
        assertEquals(across.lat, g.at(500)[0].lat, 1e-12)
        assertFalse(g.moving(500))
    }

    @Test fun busesKeepMovingBetweenAnswersAndWaitRatherThanReverse() {
        // A straight line east, about 1.1 km.
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.01, 1.0)))
        fun at(m: Double, speed: Double, until: Double) = path.pointAt(m).let { (lat, lon) -> LiveBus("b1", lat, lon, 90.0, true, null, null, along = m, speed = speed, until = until) }
        val g = Glides(catchMs = 1_000)
        g.update(listOf(at(100.0, 10.0, 150.0)), path, 0)
        assertEquals("going on at its speed", 120.0, g.at(2_000)[0].along!!, 1e-6)
        assertEquals("not past where the answer says", 150.0, g.at(9_000)[0].along!!, 1e-6)
        assertTrue(g.moving(4_000))
        assertFalse(g.moving(6_000))
        // The next answer is behind where it's drawn (it went slower): it waits, then goes on.
        g.update(listOf(at(130.0, 10.0, 300.0)), path, 9_000)
        assertEquals(150.0, g.at(10_000)[0].along!!, 1e-6)
        assertEquals(160.0, g.at(12_000)[0].along!!, 1e-6)
        // An answer ahead: it catches up over catchMs, then goes on with it.
        g.update(listOf(at(200.0, 10.0, 400.0)), path, 12_000)
        assertEquals("halfway to where it now is (205 m)", 182.5, g.at(12_500)[0].along!!, 1e-6)
        assertEquals(220.0, g.at(14_000)[0].along!!, 1e-6)
        // From an older API, with no speed: it glides there over 15 s, as before.
        val old = Glides()
        old.update(listOf(at(0.0, 0.0, 0.0).copy(speed = null, until = null)), path, 0)
        old.update(listOf(at(150.0, 0.0, 0.0).copy(speed = null, until = null)), path, 0)
        assertEquals(75.0, old.at(7_500)[0].along!!, 1e-6)
    }

    @Test fun busesSayHowFastTheyAreGoing() {
        val list = BusList.parse(JSONObject("""{"svc": "D2", "available": true, "buses": [
            {"id": "a", "lat": 1.0, "lon": 103.0, "along": 812.5, "speed": 6.7, "until": 990.0, "heading": 90, "moving": true, "crowd": null, "nextStop": null},
            {"id": "b", "lat": 1.0, "lon": 103.0, "along": null, "heading": null, "moving": false, "crowd": null, "nextStop": null}]}"""))
        assertEquals(6.7, list.buses[0].speed!!, 1e-9)
        assertEquals(990.0, list.buses[0].until!!, 1e-9)
        assertNull("an older API: no speed", list.buses[1].speed)
    }

    @Test fun busesSayHowFarAlongTheirLineTheyAre() {
        val list = BusList.parse(JSONObject("""{"svc": "D2", "available": true, "buses": [
            {"id": "a", "lat": 1.0, "lon": 103.0, "along": 812.5, "heading": 90, "moving": true, "crowd": null, "nextStop": null},
            {"id": "b", "lat": 1.0, "lon": 103.0, "along": null, "heading": null, "moving": false, "crowd": null, "nextStop": null}]}"""))
        assertEquals(812.5, list.buses[0].along!!, 1e-9)
        assertNull(list.buses[1].along)
    }

    @Test fun theStyleReadsTheMapFileFromStorage() {
        val style = """{"version": 8, "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://terminus.rcn.sh/map/campus.pmtiles"}}, "layers": []}"""
        val local = JSONObject(MapFiles.localTiles(style, "/data/user/0/sh.rcn.terminus/files/map/campus.pmtiles"))
        assertEquals("pmtiles://file:///data/user/0/sh.rcn.terminus/files/map/campus.pmtiles", local.getJSONObject("sources").getJSONObject("protomaps").getString("url"))
    }

    @Test fun withoutTheMapFileOnlyTheBackgroundStays() {
        val style = """{"version": 8, "glyphs": "g", "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://x/map/campus.pmtiles"}},
            "layers": [{"id": "background", "type": "background"}, {"id": "roads", "type": "line", "source": "protomaps"}]}"""
        val plain = JSONObject(MapFiles.withoutBaseMap(style))
        assertEquals(0, plain.getJSONObject("sources").length())
        assertEquals(1, plain.getJSONArray("layers").length())
        assertEquals("g", plain.getString("glyphs"))
    }
}
