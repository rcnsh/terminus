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
}
