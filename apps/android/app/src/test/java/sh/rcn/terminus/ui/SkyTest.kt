package sh.rcn.terminus.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** The sky over Now by the hour, at the web's hours (apps/api/test/daylight.test.js). */
class SkyTest {
    private fun at(hhmm: String) = hhmm.split(":").let { (h, m) -> phaseAt(h.toInt() * 60 + m.toInt()) }

    @Test fun theSkyFollowsTheDayDawnToNight() {
        val day = listOf("00:00", "06:29", "06:30", "08:29", "08:30", "12:00", "16:29", "16:30", "18:44", "18:45", "19:39", "19:40", "23:59").map(::at)
        assertEquals(
            listOf(Phase.NIGHT, Phase.NIGHT, Phase.DAWN, Phase.DAWN, Phase.DAY, Phase.DAY, Phase.DAY, Phase.GOLDEN, Phase.GOLDEN, Phase.DUSK, Phase.DUSK, Phase.NIGHT, Phase.NIGHT),
            day,
        )
    }

    @Test fun aDarkPhoneAlwaysHasLightWordsOverTheSky() {
        for (p in Phase.entries) assertEquals(p.name, true, palette(p, dark = true).lightInk)
    }

    @Test fun aLightPhoneHasDarkWordsOnlyByDay() {
        val dark = Phase.entries.filter { !palette(it, dark = false).lightInk }
        assertEquals(listOf(Phase.DAWN, Phase.DAY, Phase.GOLDEN), dark)
    }

    @Test fun theSkyHasDepthAsNowScrolls() {
        // sky, clouds, far, fade: the web's cases (daylight.test.js).
        fun at(s: Float) = parallax(s).let { listOf(it.sky, it.clouds, it.far, it.fade).map { n -> Math.round(n * 100) / 100f } }
        assertEquals(listOf(0f, 0f, 0f, 1f), at(0f))
        assertEquals(listOf(25f, 17.5f, 6f, 0.69f), at(50f))
        assertEquals(listOf(75f, 52.5f, 18f, 0.06f), at(150f))
        assertEquals(listOf(200f, 140f, 18f, 0f), at(400f))
        // Pulled past the top (a bounce): as at the top.
        assertEquals(at(0f), at(-20f))
    }
}
