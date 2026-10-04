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
        val bus = LiveBus("b1", 1.0, 103.0, null, true, null, null, at = "COM 3", slot = 1).placed()
        val props = JSONObject(MapGeoJson.buses("D2", 0xFF8E44C9L, listOf(bus))).getJSONArray("features").getJSONObject(0).getJSONObject("properties")
        assertEquals("#8e44c9", props.getString("color"))
        assertEquals(0.0, props.getDouble("heading"), 0.0)
        val offset = props.getJSONArray("offset")
        assertEquals("at a stop: beside the dot, to its left", -LiveBus.AT_STOP_SIDE_DP, offset.getDouble(0), 0.0)
        assertEquals("second in line: one bus further back", LiveBus.AT_STOP_STEP_DP, offset.getDouble(1), 0.0)
    }

    @Test fun busesSlideAlongTheirLineRoundACorner() {
        // East, then north: an L with its corner at (103.001, 1.0).
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.001, 1.0), doubleArrayOf(103.001, 1.001)))
        val leg = RoutePath.haversine(1.0, 103.0, 1.0, 103.001)
        fun at(m: Double) = path.pointAt(m).let { (lat, lon) -> LiveBus("b1", lat, lon, 0.0, true, null, null, along = m) }
        val s = Slides(ms = 1_000)
        s.update(listOf(at(leg - 50)), path, 0)
        assertEquals("a new bus appears where it is", leg - 50, s.at(0)[0].along!!, 1e-9)
        s.update(listOf(at(leg + 50), at(10.0).copy(id = "new")), path, 0)
        val half = s.at(500)[0]
        assertEquals("halfway, at the corner, not cutting it", 1.0, half.lat, 1e-9)
        assertEquals(103.001, half.lon, 1e-9)
        assertTrue(s.moving(500))
        assertFalse(s.moving(1_000))
        assertEquals(leg + 50, s.at(1_000)[0].along!!, 1e-9)
        assertEquals("pointing along the road", 0.0, s.at(1_000)[0].heading!!, 1e-6)
        // Eased: slower at the ends than in the middle.
        assertTrue(s.at(100)[0].along!! - (leg - 50) < 10)
    }

    @Test fun busesSlideBesideTheDotAtAStop() {
        // A straight line east, about 1.1 km; a stop's dot 10 m north of it at 500 m.
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.01, 1.0)))
        val between = path.pointAt(300.0).let { (lat, lon) -> LiveBus("b1", lat, lon, 90.0, true, null, "COM 3", along = 300.0) }
        val (dotLat, dotLon) = path.pointAt(500.0).let { (lat, lon) -> lat + 10 / 110_574.0 to lon }
        val atStop = between.copy(lat = dotLat, lon = dotLon, along = 500.0, at = "COM 3")
        val s = Slides(ms = 1_000)
        s.update(listOf(between), path, 0)
        s.update(listOf(atStop), path, 2_000)
        val half = s.at(2_500)[0]
        assertEquals(400.0, half.along!!, 1e-6)
        assertEquals("halfway beside it", -LiveBus.AT_STOP_SIDE_DP / 2, half.ox, 1e-9)
        val there = s.at(3_000)[0]
        assertEquals("at the dot", dotLat, there.lat, 1e-12)
        assertEquals(-LiveBus.AT_STOP_SIDE_DP, there.ox, 0.0)
        // Behind where it's drawn (the other side of the road, or put right): it jumps.
        s.update(listOf(between), path, 4_000)
        assertEquals(300.0, s.at(4_000)[0].along!!, 1e-9)
        assertFalse(s.moving(4_000))
        // Animations off: it jumps.
        s.update(listOf(atStop), path, 5_000, still = true)
        assertEquals(500.0, s.at(5_000)[0].along!!, 1e-9)
        // No answer for 20 s (the screen was off): it jumps.
        s.update(listOf(atStop.copy(along = 700.0, at = null)), path, 25_000)
        assertEquals(700.0, s.at(25_000)[0].along!!, 1e-9)
        // A long way on (over 1.5 km), or on a line kept from before the route changed: it jumps.
        assertNull(path.aheadBy(between, atStop.copy(along = 2_000.0)))
        assertNull(path.aheadBy(between, atStop.copy(along = 5_000.0)))
    }

    @Test fun busesSayWhichStopTheyAreAt() {
        val list = BusList.parse(JSONObject("""{"svc": "D2", "available": true, "buses": [
            {"id": "a", "plate": "PD726D", "lat": 1.0, "lon": 103.0, "along": 812.5, "heading": 90, "moving": true, "crowd": null, "at": {"code": "COM3", "name": "COM 3"}, "slot": 1, "nextStop": {"code": "BIZ2", "name": "BIZ 2"}},
            {"id": "b", "lat": 1.0, "lon": 103.0, "along": 900, "heading": 90, "moving": true, "crowd": null, "at": null, "slot": 0, "nextStop": null}]}"""))
        assertEquals("COM 3", list.buses[0].at)
        assertEquals(1, list.buses[0].slot)
        assertEquals("PD726D", list.buses[0].plate)
        assertNull(list.buses[1].at)
        assertNull("an older API: no plate", list.buses[1].plate)
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
