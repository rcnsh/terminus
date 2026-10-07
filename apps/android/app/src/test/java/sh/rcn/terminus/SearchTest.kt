package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Both searches against the cases every client is held to
 * (apps/api/test/fixtures/search.json): the destination search, and the
 * Buses tab's, with its index built from the fixture's /campus.
 */
class SearchTest {
    private val spec = JSONObject(File(listOf("../../api/test/fixtures", "../api/test/fixtures").map(::File).first { it.isDirectory }, "search.json").readText())

    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }

    @Test fun theDestinationSearchRanksEveryCaseAsTheWebDoes() {
        val d = spec.getJSONObject("destinations")
        val index = d.getJSONArray("index").let { a ->
            (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                Destination(x.getString("code"), x.getString("label"), x.getString("stopCode"), x.getString("kind"), aliases = x.optJSONArray("aliases").strings())
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

    @Test fun theBusesTabSearchRanksEveryCaseAsTheWebDoes() {
        val b = spec.getJSONObject("busesTab")
        val campus = b.getJSONObject("campus")
        val stops = campus.getJSONArray("stops").let { a ->
            (0 until a.length()).map { i ->
                val x = a.getJSONObject(i)
                MapStop(x.getString("code"), x.getString("name"), 0.0, 0.0, emptyList(), x.optStringOrNull("longName"))
            }
        }
        val index = busesTabIndex(stops, CampusMap.serviceCodes(campus.getJSONObject("routes")), CampusMap.stopAliases(campus.optJSONArray("destinations")))
        fun id(h: BusHit) = when (h) {
            is BusHit.Service -> "service:${h.svc}"
            is BusHit.Stop -> "stop:${h.code}"
        }
        assertEquals(b.getJSONArray("index").strings(), index.map(::id))
        val queries = b.getJSONArray("queries")
        for (i in 0 until queries.length()) {
            val c = queries.getJSONObject(i)
            val q = c.getString("q")
            assertEquals("\"$q\": ${c.optString("why")}", c.getJSONArray("expect").strings(), searchBuses(q, index, b.getInt("limit")).map(::id))
        }
    }
}
