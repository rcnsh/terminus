package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProfileTest {
    @Test
    fun `a link shared from NUSMods is found in the sentence around it`() {
        val shared = "My timetable: https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1,TUT:03&MA1521=LEC:1."
        assertEquals("https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1,TUT:03&MA1521=LEC:1", nusmodsLink(shared))
        assertNull(nusmodsLink("https://example.com/timetable"))
        assertNull(nusmodsLink(null))
    }

    @Test
    fun `place keys follow the account page and never collide`() {
        assertEquals("gym", placeKey("Gym", emptyList()))
        assertEquals("science-library", placeKey("Science Library!", emptyList()))
        assertEquals("gym-2", placeKey("gym", listOf("gym")))
        assertEquals("gym-3", placeKey("gym", listOf("gym", "gym-2")))
        assertEquals("place", placeKey("!!!", emptyList()))
    }

    @Test
    fun `edits keep fields this version does not know about`() {
        val p = ProfileDoc(JSONObject("""{"home":{"stops":["PGP"]},"futureField":42,"places":[]}"""))
        p.setHomeStops(listOf("UTOWN", "UTOWN", "COM3", "KR-MRT", "PGP"))
        p.addPlace("Gym", "UTOWN")
        p.markSeen("onboarding")
        p.markSeen("onboarding")
        assertEquals(listOf("UTOWN", "COM3", "KR-MRT"), p.homeStops)
        assertEquals(42, p.json.getInt("futureField"))
        assertEquals(listOf("onboarding"), p.seen)
        assertEquals("gym", p.places.single().key)
    }

    @Test
    fun `no stops means no home, and a setup needs somewhere to go or start`() {
        val p = ProfileDoc(JSONObject())
        assertFalse(p.hasSetup)
        p.setHomeStops(emptyList())
        assertTrue(p.json.isNull("home"))
        p.addManual(Trip(1, 9 * 60, 10 * 60, "COM3", "Gym", ""))
        assertTrue(p.hasSetup)
        assertEquals(600, p.manual.single().endMin)
        p.removeManual(0)
        assertFalse(p.hasSetup)
    }

    @Test
    fun `settings stay inside what the server accepts`() {
        val p = ProfileDoc(JSONObject())
        p.homeWalkMin = 45
        p.gapHours = 0.0
        assertEquals(30, p.homeWalkMin)
        assertEquals(0.5, p.gapHours, 0.0)
    }

    @Test
    fun `times read in either style`() {
        assertEquals("09:05", hhmm(545))
        assertEquals("9:05 am", hhmm12(545))
        assertEquals("12 pm", hhmm12(720))
        assertEquals("12:30 am", hhmm12(30))
    }

    @Test
    fun `later today starts half an hour from now on campus`() {
        // 14:12 in Singapore: 14:42, up to the five-minute mark.
        assertEquals(14 * 60 + 45, soonOnCampus(java.time.Instant.parse("2026-10-01T06:12:00Z").toEpochMilli()))
        // 23:40: not into tomorrow.
        assertEquals(23 * 60 + 55, soonOnCampus(java.time.Instant.parse("2026-10-01T15:40:00Z").toEpochMilli()))
    }
}
