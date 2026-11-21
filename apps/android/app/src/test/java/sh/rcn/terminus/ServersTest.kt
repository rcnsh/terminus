package sh.rcn.terminus

import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServersTest {
    private val site = listOf("https://terminus.run", "https://terminus.rcn.sh")

    @Test
    fun theSitesOwnAddressIsTheDefaultAndTheStubOnlyInDebug() {
        assertEquals(site, Servers.all("https://terminus.run", site, debug = false))
        val debug = Servers.all("https://terminus.run", site, debug = true)
        assertEquals(site + listOf("http://localhost:8787", "http://10.0.2.2:8787"), debug)
        assertEquals("http://localhost:8787", Servers.all("http://localhost:8787", site, debug = true).first())
        assertEquals(1, Servers.all("http://localhost:8787", site, debug = true).count { it == "http://localhost:8787" })
    }

    @Test
    fun aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
        assertEquals("https://terminus.rcn.sh", Servers.pick("https://terminus.rcn.sh", site))
        assertEquals("https://terminus.run", Servers.pick(null, site))
        assertEquals("https://terminus.run", Servers.pick("https://terminus.rcn.sh", listOf("https://terminus.run")))
        assertEquals("https://terminus.run", Servers.pick("https://evil.example", site))
        assertEquals("https://terminus.run", Servers.pick("http://localhost:8787", site))
    }

    @Test
    fun onlyPlainHttpToThisPhoneOrTheEmulatorsHostIsTheStub() {
        assertTrue(Servers.isLocal("http://localhost:8787"))
        assertTrue(Servers.isLocal("http://10.0.2.2:8787"))
        assertFalse(Servers.isLocal("https://localhost:8787"))
        assertFalse(Servers.isLocal("https://terminus.rcn.sh"))
        assertFalse(Servers.isLocal("http://localhost.evil.example"))
    }

    @Test
    fun eachSiteAddressIsTheOthersBackupAndTheStubHasNone() {
        val debug = Servers.all("https://terminus.run", site, debug = true)
        assertEquals("https://terminus.rcn.sh", Servers.backup("https://terminus.run", debug))
        assertEquals("https://terminus.run", Servers.backup("https://terminus.rcn.sh", debug))
        assertNull(Servers.backup("http://localhost:8787", debug))
        assertEquals(listOf("https://terminus.run", "https://terminus.rcn.sh"), Servers.order("https://terminus.run", debug, null))
        assertEquals(
            listOf("https://terminus.rcn.sh", "https://terminus.run"),
            Servers.order("https://terminus.run", debug, "https://terminus.rcn.sh"),
        )
        assertEquals(listOf("http://localhost:8787"), Servers.order("http://localhost:8787", debug, "https://terminus.rcn.sh"))
    }

    @Test
    fun theSiteAloneHasNoBackup() {
        assertEquals(BuildConfig.SITE, BuildConfig.SERVERS)
        val built = Servers.all(BuildConfig.SITE, listOf(BuildConfig.SERVERS), debug = true)
        assertNull(Servers.backup(BuildConfig.SITE, built))
        assertEquals(listOf(BuildConfig.SITE), Servers.order(BuildConfig.SITE, built, null))
    }

    @Test
    fun onlyAServerNeverReachedIsTriedAgainElsewhere() {
        for (method in listOf("GET", "POST")) {
            assertTrue(Servers.unreached(SSLHandshakeException("Connection reset by peer"), method))
            assertTrue(Servers.unreached(UnknownHostException("terminus.run"), method))
            assertTrue(Servers.unreached(ConnectException("refused"), method))
        }
        assertTrue(Servers.unreached(SocketException("Connection reset"), "GET"))
        assertFalse(Servers.unreached(SocketException("Connection reset"), "POST"))
        assertFalse(Servers.unreached(SocketTimeoutException("connect timed out"), "GET"))
        assertFalse(Servers.unreached(ApiError(502, "bad gateway"), "GET"))
        assertFalse(Servers.unreached(IOException("other"), "GET"))
    }

    @Test
    fun throughTriesTheBackupOnlyWhenTheFirstWasNeverReached() {
        val answered = mutableListOf<String>()
        val asked = mutableListOf<String>()
        val got =
            Servers.through(site, "POST", "/api/errors", { answered += it }, { it }) { base ->
                asked += base
                if (base == site[0]) throw UnknownHostException("terminus.run") else 204
            }
        assertEquals(204, got)
        assertEquals(site, asked)
        assertEquals(listOf(site[1]), answered)

        asked.clear()
        answered.clear()
        try {
            Servers.through(site, "POST", "/api/errors", { answered += it }, { it }) { base ->
                asked += base
                throw SocketException("Connection reset")
            }
            error("should have thrown")
        } catch (_: SocketException) {}
        assertEquals(listOf(site[0]), asked)
        assertEquals(emptyList<String>(), answered)
    }

    @Test
    fun throughIsInTheRecentRequestsByPathAlone() {
        RequestLog.clear()
        Servers.through(site, "GET", "/map/campus.pmtiles?v=2", {}, { it }) { base ->
            if (base == site[0]) throw UnknownHostException("terminus.run") else 200
        }
        val entries = RequestLog.entries().map { listOf(it.method, it.path, it.host, it.status, it.failure) }
        assertEquals(
            listOf(
                listOf("GET", "/map/campus.pmtiles", "terminus.rcn.sh", 200, null),
                listOf("GET", "/map/campus.pmtiles", "terminus.run", null, "UnknownHostException"),
            ),
            entries,
        )
    }

    @Test
    fun theMenuIsAlwaysThereInDebugAndBetaBuilds() {
        assertTrue(Servers.menuAlways(debug = true, flavor = "stable"))
        assertTrue(Servers.menuAlways(debug = false, flavor = "beta"))
        assertFalse(Servers.menuAlways(debug = false, flavor = "stable"))
    }
}
