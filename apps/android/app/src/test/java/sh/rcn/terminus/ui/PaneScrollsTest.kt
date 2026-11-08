package sh.rcn.terminus.ui

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Test

/** Where each open page is scrolled to, kept across the window's layouts and let go when the page closes. */
class PaneScrollsTest {
    @Test
    fun aPageKeepsItsPlaceOnlyWhileItsOpen() {
        val scrolls = PaneScrolls()
        scrolls.keep(setOf("home", "1:A1"))
        val line = scrolls.of("1:A1")
        runBlocking { line.scrollTo(900) }
        assertSame("the same page, drawn by the other layout", line, scrolls.of("1:A1"))
        // Back: the page peeling away keeps its place till it's gone.
        scrolls.keep(setOf("home"))
        assertSame(line, scrolls.of("1:A1"))
        assertEquals(900, scrolls.of("1:A1").value)
        // Opened again: at the top, as a page always opens.
        scrolls.keep(setOf("home", "1:A1"))
        assertNotSame(line, scrolls.of("1:A1"))
        assertEquals(0, scrolls.of("1:A1").value)
    }

    @Test
    fun theSamePageTwiceInTheStackHasTwoPlaces() {
        val scrolls = PaneScrolls()
        scrolls.keep(setOf("home", "1:A", "2:L", "3:A"))
        assertNotSame(scrolls.of("1:A"), scrolls.of("3:A"))
    }
}
