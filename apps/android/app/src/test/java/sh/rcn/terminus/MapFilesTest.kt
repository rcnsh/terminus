package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/** What the Map tab keeps: only a whole map file, and a style that reads. */
class MapFilesTest {
    private fun header(version: Int) = "PMTiles".toByteArray(Charsets.US_ASCII) + byteArrayOf(version.toByte())

    @Test fun aWholeVersion3MapFileIsKept() {
        assertTrue(MapFiles.isPmTiles(header(3), 3_000_000))
    }

    @Test fun anythingElseIsNot() {
        // Another version, a page of HTML from in front of the server, a cut-off file, nothing at all.
        assertFalse(MapFiles.isPmTiles(header(2), 3_000_000))
        assertFalse(MapFiles.isPmTiles("<!doctype".toByteArray(), 3_000_000))
        assertFalse(MapFiles.isPmTiles(header(3), MapFiles.MIN_TILES_BYTES - 1))
        assertFalse(MapFiles.isPmTiles("PMTil".toByteArray(), 3_000_000))
        assertFalse(MapFiles.isPmTiles(ByteArray(0), 3_000_000))
    }

    @Test fun eachDownloadHasANameOfItsOwn() {
        val a = MapFiles.tilesName("\"abc\"", 1_000)
        assertTrue(a.matches(Regex("campus-[0-9a-f]{12}\\.pmtiles")))
        assertEquals(a, MapFiles.tilesName("\"abc\"", 1_000))
        assertNotEquals(a, MapFiles.tilesName("\"abd\"", 1_000))
        // The same version again (a file gone bad, fetched whole) doesn't take the name of the one in use.
        assertNotEquals(a, MapFiles.tilesName("\"abc\"", 2_000))
        assertNotEquals(a, MapFiles.tilesName(null, 1_000))
    }

    @Test fun aStyleCutShortIsNotKept() {
        assertTrue(MapFiles.isJson("""{"version": 8, "layers": []}"""))
        assertFalse(MapFiles.isJson("""{"version": 8, "lay"""))
        assertFalse(MapFiles.isJson(""))
    }

    @Test fun theStyleReadsTheKeptFile() {
        val style = """{"version": 8, "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://terminus.run/map/campus.pmtiles"}}, "layers": [{"id": "bg", "type": "background"}, {"id": "roads", "type": "line", "source": "protomaps"}]}"""
        val local = MapFiles.localTiles(style, "/data/map/campus-0123456789ab.pmtiles")
        assertEquals("pmtiles://file:///data/map/campus-0123456789ab.pmtiles", JSONObject(local).getJSONObject("sources").getJSONObject("protomaps").getString("url"))
        val plain = MapFiles.withoutBaseMap(style)
        assertFalse(plain.contains("roads"))
        assertTrue(plain.contains("background"))
    }
}

/** The map file kept on the phone: [MapFiles.keepTiles]. */
class MapFilesKeepTest {
    private val dir: File = Files.createTempDirectory("map").toFile()
    private val meta = File(dir, "campus.pmtiles.json")
    private val day = 24 * 3_600_000L
    private val now = 1_790_000_000_000L

    /** A map file whose contents say [label]: a PMTiles v3 header, the label, then padding to a map's size. */
    private fun map(label: String): ByteArray {
        val head = header(3) + label.toByteArray()
        return head + ByteArray((MapFiles.MIN_TILES_BYTES - head.size).toInt())
    }

    private fun header(version: Int) = "PMTiles".toByteArray(Charsets.US_ASCII) + byteArrayOf(version.toByte())

    /** The label of the map file [keepTiles] says is kept, or null with none. */
    private fun keptLabel(path: String?): String? {
        val bytes = File(path ?: return null).readBytes()
        return String(bytes, 8, bytes.drop(8).indexOfFirst { it == 0.toByte() })
    }

    /** A server answering [code] with [body]; [length] is its Content-Length. Notes the ETag asked with. */
    private inner class Server(val code: Int, val body: ByteArray = ByteArray(0), val etag: String? = "\"v2\"", val length: Long? = body.size.toLong()) {
        var asked = 0
        var askedWith: String? = null
        fun fetch(e: String?, into: File): MapFiles.Fetched {
            asked++
            askedWith = e
            if (code == 200) into.writeBytes(body)
            return MapFiles.Fetched(code, etag, length)
        }
    }

    private fun keep(server: Server, at: Long = now, metered: Boolean = false) =
        MapFiles.keepTiles(dir, at, { metered }, server::fetch)

    /** A map file kept before files had names of their own: campus.pmtiles, with no size written down. */
    private fun kept(checked: Long, etag: String = "\"v1\"") {
        File(dir, "campus.pmtiles").writeBytes(map("old map"))
        meta.writeText(JSONObject().put("etag", etag).put("checked", checked).toString())
    }

    @Test fun theFirstMapIsDownloaded() {
        val s = Server(200, map("new map"))
        val path = keep(s, metered = true)
        assertNull("nothing to ask about", s.askedWith)
        assertEquals("new map", keptLabel(path))
        assertEquals("\"v2\"", JSONObject(meta.readText()).getString("etag"))
        assertEquals(now, JSONObject(meta.readText()).getLong("checked"))
    }

    @Test fun aMapCheckedThisWeekIsNotAskedAbout() {
        kept(now - 6 * day)
        val s = Server(200, map("new map"))
        val path = keep(s)
        assertEquals(0, s.asked)
        assertEquals("old map", keptLabel(path))
    }

    @Test fun anUnchangedMapIsKeptAndCheckedAgainInAWeek() {
        kept(now - 8 * day)
        val s = Server(304, etag = null)
        val path = keep(s)
        assertEquals("\"v1\"", s.askedWith)
        assertEquals("old map", keptLabel(path))
        assertEquals(now, JSONObject(meta.readText()).getLong("checked"))
        assertEquals("\"v1\"", JSONObject(meta.readText()).getString("etag"))
    }

    @Test fun aCutOffDownloadLeavesTheOldMap() {
        kept(now - 8 * day)
        val whole = map("new map")
        val path = keep(Server(200, whole.copyOf(whole.size - 10), length = whole.size.toLong()))
        assertEquals("old map", keptLabel(path))
        // Not counted as checked: the next look tries again.
        assertEquals(now - 8 * day, JSONObject(meta.readText()).getLong("checked"))
    }

    @Test fun aNewerMapWaitsForWifi() {
        kept(now - 8 * day)
        val s = Server(200, map("new map"))
        keep(s, metered = true)
        assertEquals(0, s.asked)
        assertEquals("new map", keptLabel(keep(s, metered = false)))
    }

    @Test fun anErrorKeepsTheOldMap() {
        kept(now - 8 * day)
        assertEquals("old map", keptLabel(keep(Server(503))))
    }

    @Test fun somethingThatIsntAMapKeepsTheOldOne() {
        // A login page from the Wi-Fi in front of the server, answered with a 200.
        kept(now - 8 * day)
        val page = "<!doctype html><title>Sign in to Wi-Fi</title>".toByteArray()
        assertEquals("old map", keptLabel(keep(Server(200, page))))
    }

    @Test fun aNewerMapHasANewNameAndTheOldOneGoesAtTheNextCheck() {
        kept(now - 8 * day)
        val path = keep(Server(200, map("new map")))!!
        assertNotEquals("campus.pmtiles", File(path).name)
        assertTrue(File(dir, "campus.pmtiles").exists())
        keep(Server(304), at = now + 8 * day)
        assertFalse(File(dir, "campus.pmtiles").exists())
        assertTrue(File(path).exists())
    }
}
