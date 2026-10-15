package sh.rcn.terminus

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Both searches against the cases every client is held to (apps/api/test/fixtures/search.json): the destination search, and the Buses
 * tab's, with its index built from the fixture's /campus.
 */
class SearchTest {
    private val spec =
        JSONObject(
            File(listOf("../../api/test/fixtures", "../api/test/fixtures").map(::File).first { it.isDirectory }, "search.json").readText()
        )

    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }

    @Test
    fun theDestinationSearchRanksEveryCaseAsTheWebDoes() {
        val d = spec.getJSONObject("destinations")
        val index =
            d.getJSONArray("index").let { a ->
                (0 until a.length()).map { i ->
                    val x = a.getJSONObject(i)
                    Destination(
                        x.getString("code"),
                        x.getString("label"),
                        x.getString("stopCode"),
                        x.getString("kind"),
                        aliases = x.optJSONArray("aliases").strings(),
                    )
                }
            }
        val queries = d.getJSONArray("queries")
        for (i in 0 until queries.length()) {
            val c = queries.getJSONObject(i)
            val q = c.getString("q")
            val got = rankDestinations(index, q, d.getInt("limit")).map { "${it.kind}:${it.code}" }
            assertEquals("\"$q\": ${c.optString("why")}", c.getJSONArray("expect").strings(), got)
        }
    }

    @Test
    fun theBusesTabSearchRanksEveryCaseAsTheWebDoes() {
        val b = spec.getJSONObject("busesTab")
        val campus = b.getJSONObject("campus")
        val stops =
            campus.getJSONArray("stops").let { a ->
                (0 until a.length()).map { i ->
                    val x = a.getJSONObject(i)
                    MapStop(x.getString("code"), x.getString("name"), 0.0, 0.0, emptyList(), x.optStringOrNull("longName"))
                }
            }
        val index =
            busesTabIndex(
                stops,
                CampusMap.serviceCodes(campus.getJSONObject("routes")),
                CampusMap.stopAliases(campus.optJSONArray("destinations")),
            )
        fun id(h: BusHit) =
            when (h) {
                is BusHit.Service -> "service:${h.svc}"
                is BusHit.Stop -> "stop:${h.code}"
            }
        assertEquals(b.getJSONArray("index").strings(), index.map(::id))
        val queries = b.getJSONArray("queries")
        for (i in 0 until queries.length()) {
            val c = queries.getJSONObject(i)
            val q = c.getString("q")
            assertEquals(
                "\"$q\": ${c.optString("why")}",
                c.getJSONArray("expect").strings(),
                searchBuses(q, index, b.getInt("limit")).map(::id),
            )
        }
    }

    @Test
    fun eachKindIsOneGroupInTheOrderOfItsBestResult() {
        val index =
            listOf(
                Destination("COM3", "COM 3", "COM3", "stop"),
                Destination("COM1", "COM1", "COM1", "building"),
                Destination("OPP-COM", "Opp COM", "OPP-COM", "stop"),
                Destination("LT27", "LT27", "S17", "landmark"),
            )
        val ranked = rankDestinations(index, "com")
        // Ranked alone, the stops come either side of the building.
        assertEquals(listOf("stop:COM3", "building:COM1", "stop:OPP-COM"), ranked.map { "${it.kind}:${it.code}" })
        assertEquals(
            listOf("stop:COM3", "stop:OPP-COM", "building:COM1"),
            SearchRank.grouped(ranked) { it.kind }.map { "${it.kind}:${it.code}" },
        )
        // A group's place is its best result's: here the building's, first.
        val buildingFirst = listOf("building:COM1", "stop:COM3", "building:COM2", "stop:OPP")
        assertEquals(
            listOf("building:COM1", "building:COM2", "stop:COM3", "stop:OPP"),
            SearchRank.grouped(buildingFirst) { it.substringBefore(':') },
        )
    }

    @Test
    fun aStopAndABuildingWithOneCodeAreTwoResultsInTheWherePicker() {
        val stop = Destination("COM3", "COM3", "COM3", "stop")
        val building = Destination("COM3", "COM3", "COM3", "building")
        assertNotEquals(stop.id, building.id)
        // A class at the COM3 stop: the stop is that timetable row, the building isn't.
        val row = Destination("COM3", "COM3", "COM3", "timetable", detail = "CS2030")
        assertTrue(stop.isPlaceOf(row))
        assertFalse(building.isPlaceOf(row))
        assertFalse(row.isPlaceOf(row))
        val (top, rest) = whereResults(listOf(stop, building), listOf(row), "COM3")
        assertEquals(listOf("timetable:COM3"), top.map { it.id })
        // The building stays a result of its own; the stop is the row already shown.
        assertEquals(listOf("building:COM3"), rest.map { it.id })
        // Nothing typed: only the timetable's stops.
        assertEquals(listOf(row) to emptyList<Destination>(), whereResults(listOf(stop, building), listOf(row), " "))
    }
}
