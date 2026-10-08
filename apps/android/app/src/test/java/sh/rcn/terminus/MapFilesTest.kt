package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

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
        val style = """{"version": 8, "sources": {"protomaps": {"type": "vector", "url": "pmtiles://https://terminus.rcn.sh/map/campus.pmtiles"}}, "layers": [{"id": "bg", "type": "background"}, {"id": "roads", "type": "line", "source": "protomaps"}]}"""
        val local = MapFiles.localTiles(style, "/data/map/campus-0123456789ab.pmtiles")
        assertEquals("pmtiles://file:///data/map/campus-0123456789ab.pmtiles", JSONObject(local).getJSONObject("sources").getJSONObject("protomaps").getString("url"))
        val plain = MapFiles.withoutBaseMap(style)
        assertFalse(plain.contains("roads"))
        assertTrue(plain.contains("background"))
    }
}
