package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** The map file kept on the phone: [MapFiles.keepTiles]. */
class MapFilesTest {
    private val dir: File = Files.createTempDirectory("map").toFile()
    private val tiles = File(dir, "campus.pmtiles")
    private val meta = File(dir, "campus.pmtiles.json")
    private val day = 24 * 3_600_000L
    private val now = 1_790_000_000_000L

    /** A server answering [code] with [body]; [length] is its Content-Length. Notes the ETag asked with. */
    private inner class Server(val code: Int, val body: String = "", val etag: String? = "\"v2\"", val length: Long? = body.length.toLong()) {
        var asked = 0
        var askedWith: String? = null
        fun fetch(e: String?, into: File): MapFiles.Fetched {
            asked++
            askedWith = e
            if (code == 200) into.writeText(body)
            return MapFiles.Fetched(code, etag, length)
        }
    }

    private fun keep(server: Server, at: Long = now, metered: Boolean = false) =
        MapFiles.keepTiles(dir, at, { metered }, server::fetch)

    private fun kept(checked: Long, etag: String = "\"v1\"") {
        tiles.writeText("old map")
        meta.writeText(JSONObject().put("etag", etag).put("checked", checked).toString())
    }

    @Test fun theFirstMapIsDownloaded() {
        val s = Server(200, "new map")
        keep(s, metered = true)
        assertNull("nothing to ask about", s.askedWith)
        assertEquals("new map", tiles.readText())
        assertEquals("\"v2\"", JSONObject(meta.readText()).getString("etag"))
        assertEquals(now, JSONObject(meta.readText()).getLong("checked"))
    }

    @Test fun aMapCheckedThisWeekIsNotAskedAbout() {
        kept(now - 6 * day)
        val s = Server(200, "new map")
        keep(s)
        assertEquals(0, s.asked)
        assertEquals("old map", tiles.readText())
    }

    @Test fun anUnchangedMapIsKeptAndCheckedAgainInAWeek() {
        kept(now - 8 * day)
        val s = Server(304, etag = null)
        keep(s)
        assertEquals("\"v1\"", s.askedWith)
        assertEquals("old map", tiles.readText())
        assertEquals(now, JSONObject(meta.readText()).getLong("checked"))
        assertEquals("\"v1\"", JSONObject(meta.readText()).getString("etag"))
    }

    @Test fun aCutOffDownloadLeavesTheOldMap() {
        kept(now - 8 * day)
        keep(Server(200, "new m", length = 7))
        assertEquals("old map", tiles.readText())
        // Not counted as checked: the next look tries again.
        assertEquals(now - 8 * day, JSONObject(meta.readText()).getLong("checked"))
    }

    @Test fun aNewerMapWaitsForWifi() {
        kept(now - 8 * day)
        val s = Server(200, "new map")
        keep(s, metered = true)
        assertEquals(0, s.asked)
        keep(s, metered = false)
        assertEquals("new map", tiles.readText())
    }

    @Test fun anErrorKeepsTheOldMap() {
        kept(now - 8 * day)
        keep(Server(503))
        assertEquals("old map", tiles.readText())
    }
}
