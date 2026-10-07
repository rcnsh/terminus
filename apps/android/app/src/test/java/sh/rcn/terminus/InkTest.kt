package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A service's code on its colour reads at 4.5:1 or better, whichever colour it is. */
class InkTest {
    /** The services as NUS paints them (the API's ROUTE_COLORS), A1 at its darker red. */
    private val services = mapOf(
        "A1" to 0xFFD32F2FL, "A2" to 0xFFD9A000L, "D1" to 0xFFEC4FA0L, "D2" to 0xFF8E44C9L,
        "K" to 0xFF2B9AD6L, "R1" to 0xFFF57C1FL, "R2" to 0xFF34A853L, "P" to 0xFF8A939CL,
    )

    @Test fun everyServiceReads() {
        for ((svc, color) in services) {
            val ratio = Ink.contrast(color, Ink.on(color))
            assertTrue("$svc: $ratio", ratio >= 4.5)
        }
    }

    @Test fun lightColoursGetDarkInk() {
        assertEquals(Ink.DARK, Ink.on(0xFFD9A000L))
        assertEquals(Ink.DARK, Ink.on(0xFF2B9AD6L))
        assertEquals(Ink.WHITE, Ink.on(0xFF8E44C9L))
        assertEquals(Ink.WHITE, Ink.on(0xFF000000L))
    }

    @Test fun contrastIsWcags() {
        assertEquals(21.0, Ink.contrast(0xFF000000L, 0xFFFFFFFFL), 0.01)
        assertEquals(1.0, Ink.contrast(0xFF777777L, 0xFF777777L), 0.001)
    }
}
