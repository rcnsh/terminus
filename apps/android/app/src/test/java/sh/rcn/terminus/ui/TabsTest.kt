package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The tabs' order, and which one a terminus:// link opens (ADR 0017). */
class TabsTest {
    @Test
    fun nearbyIsBetweenNowAndStops() {
        assertEquals(listOf(Tab.Now, Tab.Nearby, Tab.Buses, Tab.Map, Tab.Settings), Tab.entries.toList())
    }

    @Test
    fun theNearbyLinkOpensItsTab() {
        assertEquals(Tab.Nearby, Tab.ofLink("nearby"))
    }

    @Test
    fun theCardsLinksOpenNow() {
        for (host in listOf("plan", "place", "to")) assertEquals(host, Tab.Now, Tab.ofLink(host))
    }

    @Test
    fun anyOtherLinkLeavesTheTab() {
        for (host in listOf(null, "", "map", "Nearby")) assertNull(host, Tab.ofLink(host))
    }
}
