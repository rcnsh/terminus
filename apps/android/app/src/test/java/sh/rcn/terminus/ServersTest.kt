package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

class ServersTest {
    private val site = listOf("https://terminus.run", "https://terminus.rcn.sh")

    @Test
    fun theSitesOwnAddressIsTheDefaultAndTheStubOnlyInDebug() {
        assertEquals(site, Servers.all("https://terminus.run", site, debug = false))
        val debug = Servers.all("https://terminus.run", site, debug = true)
        assertEquals(site + listOf("http://localhost:8787", "http://10.0.2.2:8787"), debug)
        // -PapiBase pointing at the stub makes it the default, listed once.
        assertEquals("http://localhost:8787", Servers.all("http://localhost:8787", site, debug = true).first())
        assertEquals(1, Servers.all("http://localhost:8787", site, debug = true).count { it == "http://localhost:8787" })
    }

    @Test
    fun aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
        assertEquals("https://terminus.rcn.sh", Servers.pick("https://terminus.rcn.sh", site))
        assertEquals("https://terminus.run", Servers.pick(null, site))
        // Dropped from a later version, or written by something else.
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
        // The backup answered a moment ago: it goes first until the detour ends.
        assertEquals(listOf("https://terminus.rcn.sh", "https://terminus.run"), Servers.order("https://terminus.run", debug, "https://terminus.rcn.sh"))
        assertEquals(listOf("http://localhost:8787"), Servers.order("http://localhost:8787", debug, "https://terminus.rcn.sh"))
    }

    @Test
    fun onlyAServerNeverReachedIsTriedAgainElsewhere() {
        // A firewall's reset during the TLS handshake, no DNS, refused: the request never arrived.
        for (method in listOf("GET", "POST")) {
            assertTrue(Servers.unreached(SSLHandshakeException("Connection reset by peer"), method))
            assertTrue(Servers.unreached(UnknownHostException("terminus.run"), method))
            assertTrue(Servers.unreached(ConnectException("refused"), method))
        }
        // Reset later: a GET can be asked again, a POST may have arrived.
        assertTrue(Servers.unreached(SocketException("Connection reset"), "GET"))
        assertFalse(Servers.unreached(SocketException("Connection reset"), "POST"))
        // A timeout, or the server's own answer, is never sent elsewhere.
        assertFalse(Servers.unreached(SocketTimeoutException("connect timed out"), "GET"))
        assertFalse(Servers.unreached(ApiError(502, "bad gateway"), "GET"))
        assertFalse(Servers.unreached(IOException("other"), "GET"))
    }

    @Test
    fun throughTriesTheBackupOnlyWhenTheFirstWasNeverReached() {
        val answered = mutableListOf<String>()
        val asked = mutableListOf<String>()
        val got = Servers.through(site, "POST", { answered += it }) { base ->
            asked += base
            if (base == site[0]) throw UnknownHostException("terminus.run") else 204
        }
        assertEquals(204, got)
        assertEquals(site, asked)
        assertEquals(listOf(site[1]), answered)

        // Reached but cut off: a POST may have arrived, so it isn't sent again.
        asked.clear()
        answered.clear()
        try {
            Servers.through(site, "POST", { answered += it }) { base ->
                asked += base
                throw SocketException("Connection reset")
            }
            error("should have thrown")
        } catch (_: SocketException) {
        }
        assertEquals(listOf(site[0]), asked)
        assertEquals(emptyList<String>(), answered)
    }

    @Test
    fun theMenuIsAlwaysThereInDebugAndBetaBuilds() {
        assertTrue(Servers.menuAlways(debug = true, flavor = "stable"))
        assertTrue(Servers.menuAlways(debug = false, flavor = "beta"))
        assertFalse(Servers.menuAlways(debug = false, flavor = "stable"))
    }
}
