package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Android's back animation between pages: the held swipe, the release from wherever it was, and no jump between them. */
class PeelTest {
    /** A 412 × 915 dp phone at 3 px a dp. */
    private val w = 1236f
    private val h = 2745f
    private val margin = 24f
    private val offset = 288f

    private fun frame(progress: Float, fromRight: Boolean = false, dy: Float = 0f, released: Float = 0f) =
        Peel.frame(progress, fromRight, dy, w, h, margin, offset, released)

    @Test
    fun aSwipeStartsFromTheWholePage() {
        val f = frame(0f)
        assertEquals(1f, f.card.scale, 0f)
        assertEquals(0f, f.card.x, 0f)
        assertEquals(0f, f.round, 0f)
        assertEquals(1f, f.card.alpha, 0f)
    }

    @Test
    fun heldFullyTheCardShrinksAndLeansToWithinTheMarginOfTheFarEdge() {
        val f = frame(1f)
        assertEquals(0.9f, f.card.scale, 1e-4f)
        val right = w / 2f + f.card.x + w * f.card.scale / 2f
        assertEquals(w - margin, right, 0.5f)
        // From the right edge it stays centred.
        assertEquals(0f, frame(1f, fromRight = true).card.x, 0f)
    }

    @Test
    fun theGestureCurveAnswersQuickly() {
        // A tenth of the way across already gives well over a tenth of the shrink.
        val shrink = (1f - frame(0.1f).card.scale) / 0.1f
        assertTrue("shrink $shrink", shrink > 0.25f)
    }

    @Test
    fun cornersAreRoundByAFifthOfTheSwipe() {
        assertEquals(0.5f, frame(0.1f).round, 1e-4f)
        assertEquals(1f, frame(0.2f).round, 0f)
        assertEquals(1f, frame(0.7f).round, 0f)
    }

    @Test
    fun theFingerMovesItUpOrDownButNeverPastTheMargin() {
        assertTrue(frame(0.5f, dy = 200f).card.y > 0f)
        assertTrue(frame(0.5f, dy = -200f).card.y < 0f)
        val f = frame(1f, dy = h)
        val bottom = h / 2f + f.card.y + h * f.card.scale / 2f
        assertTrue("bottom $bottom", bottom <= h - margin + 0.5f)
    }

    @Test
    fun lettingGoStartsExactlyWhereTheCardIs() {
        for (p in listOf(0.03f, 0.2f, 0.5f, 0.95f)) {
            for (right in listOf(false, true)) {
                val held = frame(p, right, dy = 120f)
                val let = frame(p, right, dy = 120f, released = 1e-6f)
                assertEquals(held.card.scale, let.card.scale, 1e-3f)
                assertEquals(held.card.x, let.card.x, 0.5f)
                assertEquals(held.card.y, let.card.y, 0.5f)
                assertEquals(held.under.x, let.under.x, 0.5f)
                assertEquals(held.under.scale, let.under.scale, 1e-3f)
            }
        }
    }

    @Test
    fun theCardIsGoneInAFifthOfTheReleaseAndThePageUnderComesHome() {
        assertEquals(0f, frame(0.4f, released = 0.2f).card.alpha, 1e-4f)
        val end = frame(0.4f, released = 1f)
        assertEquals(1f, end.under.scale, 1e-4f)
        assertEquals(0f, end.under.x, 1e-3f)
        assertEquals(0f, end.under.y, 1e-3f)
        assertEquals(0f, end.dim, 1e-4f)
        assertEquals(0f, end.underRound, 1e-4f)
    }

    @Test
    fun theReleaseIsFastToStart() {
        // Emphasized: most of the way home by a third of the release, so a flick lands at once.
        val e = Peel.EMPHASIZED
        assertEquals(0f, e.transform(0f), 1e-4f)
        assertEquals(0.4f, e.transform(1f / 6f), 1e-3f)
        assertEquals(1f, e.transform(1f), 1e-4f)
        assertTrue(e.transform(1f / 3f) > 0.75f)
        var last = 0f
        for (i in 1..100) {
            val v = e.transform(i / 100f)
            assertTrue("monotonic at $i", v >= last - 1e-4f)
            last = v
        }
    }
}
