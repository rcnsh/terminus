package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServersTest {
    private val site = listOf("https://terminus.rcn.sh", "https://terminus.run")

    @Test
    fun theOldAddressIsTheDefaultAndTheStubOnlyInDebug() {
        assertEquals(site, Servers.all("https://terminus.rcn.sh", site, debug = false))
        val debug = Servers.all("https://terminus.rcn.sh", site, debug = true)
        assertEquals(site + listOf("http://localhost:8787", "http://10.0.2.2:8787"), debug)
        // -PapiBase pointing at the stub makes it the default, listed once.
        assertEquals("http://localhost:8787", Servers.all("http://localhost:8787", site, debug = true).first())
        assertEquals(1, Servers.all("http://localhost:8787", site, debug = true).count { it == "http://localhost:8787" })
    }

    @Test
    fun aSavedServerNoLongerBuiltInFallsBackToTheDefault() {
        assertEquals("https://terminus.run", Servers.pick("https://terminus.run", site))
        assertEquals("https://terminus.rcn.sh", Servers.pick(null, site))
        // Dropped from a later version (say terminus.run let go), or written by something else.
        assertEquals("https://terminus.rcn.sh", Servers.pick("https://terminus.run", listOf("https://terminus.rcn.sh")))
        assertEquals("https://terminus.rcn.sh", Servers.pick("https://evil.example", site))
        assertEquals("https://terminus.rcn.sh", Servers.pick("http://localhost:8787", site))
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
    fun theMenuIsAlwaysThereInDebugAndBetaBuilds() {
        assertTrue(Servers.menuAlways(debug = true, flavor = "stable"))
        assertTrue(Servers.menuAlways(debug = false, flavor = "beta"))
        assertFalse(Servers.menuAlways(debug = false, flavor = "stable"))
    }
}
