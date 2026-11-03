package sh.rcn.terminus.ui

import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** What gives way on tight Nearby rows, in order: the gaps, then the times a little smaller, then every row's times on a second line. */
class NearbyTightTest {
    // Three columns 100, 80 and 70 px wide at full size, shrinking with the text.
    private val widths = { s: Float -> listOf(100, 80, 70).map { (it * s).roundToInt() } }

    // Every destination fits in [need] px or more.
    private fun plan(need: Int, line: Float = 400f, whole: Float = 460f) =
        NearbyTight.plan(line, whole, wide = 14f, tight = 8f, slack = 3f, fits = { it >= need }, widths = widths)

    @Test
    fun roomEnoughKeepsTheWideGaps() {
        val p = plan(100)
        assertEquals(14f, p.gap)
        assertEquals(1f, p.scale)
        assertFalse(p.stacked)
        assertEquals(400f - 42 - 3 - 250, p.room)
    }

    @Test
    fun theGapsCloseUpFirst() {
        val p = plan(110)
        assertEquals(8f, p.gap)
        assertEquals(1f, p.scale)
        assertFalse(p.stacked)
    }

    @Test
    fun thenTheTimesShrinkALittle() {
        val p = plan(150)
        assertEquals(8f, p.gap)
        assertTrue(p.scale in NearbyTight.MIN_SCALE..0.95f)
        assertFalse(p.stacked)
        assertTrue(p.room >= 150)
    }

    @Test
    fun neverBelowTheFloorEveryRowStacksInstead() {
        val p = plan(200)
        assertTrue(p.stacked)
        assertEquals(1f, p.scale)
        assertEquals(listOf(100, 80, 70), p.cols)
        // Where it's going has the whole line after the badge; the times' own line keeps the wide gaps, which it has room for.
        assertEquals(400f, p.room)
        assertEquals(14f, p.gap)
    }

    @Test
    fun aStackedLineTooNarrowForTheFullTimesShrinksThemToFit() {
        // A narrow phone at the largest text: the three times at full size are wider than the whole row.
        val p =
            NearbyTight.plan(line = 254f, whole = 298f, wide = 14f, tight = 8f, slack = 3f, fits = { it >= 90 }) { s ->
                listOf(113, 109, 105).map { (it * s).roundToInt() }
            }
        assertTrue(p.stacked)
        assertTrue(p.scale < 1f)
        assertTrue(8f * 3 + 3 + p.cols.sum() <= 298f)
    }

    // Text 10 px a character, wrapped greedily at plain spaces only, as a line breaker treats a no-break space.
    private val width = { w: String -> w.length * 10 }
    private val twoLines = { d: NearbyText.Dest, room: Float ->
        var lines = 1
        var used = 0
        for (w in d.text.split(' ')) {
            val add = if (used == 0) width(w) else used + 10 + width(w)
            if (add <= room) used = add
            else {
                lines++
                used = width(w)
            }
        }
        lines <= 2
    }

    @Test
    fun aShortPlaceKeptTogetherCanStillBreakRatherThanStackTheRows() {
        // The server joins a short place's words with no-break spaces: whole is the first choice, not a reason to stack.
        val kr = NearbyText.Dest("to KR\u00a0Bus\u00a0Ter", 3 until 13)
        // Room for "to KR" over "Bus Ter", not for "KR Bus Ter" on one line.
        assertTrue(NearbyTight.fits(listOf(kr), 70f, width, twoLines))
        assertEquals("to KR Bus Ter", kr.loose().text)
        assertEquals(kr.place, kr.loose().place)
    }

    @Test
    fun aWordWiderThanTheRoomDoesNotFit() {
        assertFalse(NearbyTight.fits(listOf(NearbyText.Dest("via Kampong")), 60f, width, twoLines))
        assertFalse(NearbyTight.fits(listOf(NearbyText.Dest("to PGP")), 0f, width, twoLines))
    }
}
