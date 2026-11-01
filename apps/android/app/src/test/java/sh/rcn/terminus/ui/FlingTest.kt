package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The map sheet's give past its top, and the speed it springs back at: the iPhone's FlingTests, held to the same numbers. */
class FlingTest {
    @Test
    fun downFollowsTheFingerAndUpGivesLessAndLess() {
        assertEquals(0f, Fling.rubber(0f, 22f))
        assertEquals(80f, Fling.rubber(80f, 22f))
        val a = -Fling.rubber(-20f, 22f)
        val b = -Fling.rubber(-40f, 22f) - a
        assertTrue(a > 0f && a < 20f)
        assertTrue(b < a)
        assertTrue(-Fling.rubber(-10_000f, 22f) < 22f)
    }

    @Test
    fun upTheDrawnSpeedSlowsAsTheGiveDoes() {
        assertEquals(500f, Fling.rubberSpeed(500f, 30f, 22f))
        // At the start of the give it moves with the finger; 22 up, at a quarter of its speed.
        assertEquals(-400f, Fling.rubberSpeed(-400f, 0f, 22f))
        assertEquals(-100f, Fling.rubberSpeed(-400f, -22f, 22f), 0.001f)
        // It matches the slope of rubber itself.
        val dy = -40f
        val slope = (Fling.rubber(dy + 0.01f, 22f) - Fling.rubber(dy - 0.01f, 22f)) / 0.02f
        assertEquals(slope, Fling.rubberSpeed(1f, dy, 22f), 0.01f)
    }

    @Test
    fun caughtWhereItsDrawnItStaysThere() {
        assertEquals(30f, Fling.unrubber(30f, 22f))
        for (dy in listOf(-5f, -20f, -60f, -400f)) assertEquals(dy, Fling.unrubber(Fling.rubber(dy, 22f), 22f), 0.01f * -dy)
    }

    @Test
    fun aQuickFlickUpSpringsBackWithoutLeavingTheGive() {
        val omega = 20f
        // Going down, or slowly up, it keeps the drawn speed.
        assertEquals(300f, Fling.backSpeed(300f, 50f, 62f, omega))
        assertEquals(Fling.rubberSpeed(-50f, -10f, 62f), Fling.backSpeed(-50f, -10f, 62f, omega))
        for (dy in listOf(0f, -10f, -40f, -200f)) for (speed in listOf(-1_000f, -5_000f, -20_000f)) {
            val x0 = Fling.rubber(dy, 62f).toDouble()
            val v0 = Fling.backSpeed(speed, dy, 62f, omega).toDouble()
            // The critically damped spring's path back to rest, x(t) = (x0 + (v0 + w x0) t) e^(-w t).
            val furthest =
                (0..400).minOf { i ->
                    val t = i / 400.0
                    (x0 + (v0 + omega * x0) * t) * Math.exp(-omega * t)
                }
            assertTrue("dy $dy speed $speed went to $furthest", furthest > -62.0)
        }
    }
}
