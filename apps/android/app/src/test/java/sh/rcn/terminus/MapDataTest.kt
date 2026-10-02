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

    @Test fun busesGlideFromWhereTheyWere() {
        val was = LiveBus("b1", 1.0, 103.0, 0.0, true, null, null)
        val now = was.copy(lat = 2.0, lon = 104.0)
        val half = glide(mapOf("b1" to was), listOf(now, now.copy(id = "new")), 0.5f)
        assertEquals(1.5, half[0].lat, 1e-9)
        assertEquals(103.5, half[0].lon, 1e-9)
        assertEquals(2.0, half[1].lat, 1e-9)
    }

    @Test fun busesGlideAlongTheirLineRoundACorner() {
        // East, then north: an L with its corner at (103.001, 1.0).
        val path = RoutePath(listOf(doubleArrayOf(103.0, 1.0), doubleArrayOf(103.001, 1.0), doubleArrayOf(103.001, 1.001)))
        val leg = RoutePath.haversine(1.0, 103.0, 1.0, 103.001)
        fun at(m: Double) = path.pointAt(m).let { (lat, lon) -> LiveBus("b1", lat, lon, 0.0, true, null, null, along = m) }
        val was = at(leg - 50)
        val now = at(leg + 50)
        val half = glide(mapOf("b1" to was), listOf(now), 0.5f, path)[0]
        assertEquals("at the corner, not cutting it", 1.0, half.lat, 1e-9)
        assertEquals(103.001, half.lon, 1e-9)
        val later = glide(mapOf("b1" to was), listOf(now), 0.75f, path)[0]
        assertEquals("on the north leg", 103.001, later.lon, 1e-9)
        assertEquals("pointing north", 0.0, later.heading!!, 1e-6)
        // A line that isn't the API's (kept from before the route changed): straight.
        val elsewhere = now.copy(lat = now.lat + 0.001)
        assertNull(path.alongBy(was, elsewhere))
        // Off its line: straight.
        assertNull(path.alongBy(was.copy(along = null), now))
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
