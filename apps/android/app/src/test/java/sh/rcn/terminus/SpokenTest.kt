package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** What TalkBack says for the card and the widget: the server's words as sentences, with nothing abbreviated. */
class SpokenTest {
    init { TestStrings.install() }

    private fun golden(name: String): NextAnswer {
        val dir = listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }
        return NextAnswer.parse(JSONObject(File(dir, "$name.json").readText()))
    }

    private val hhmm = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.of("Asia/Singapore"))
    private val clock = { ms: Long -> hhmm.format(Instant.ofEpochMilli(ms)) }

    /** Six minutes before it's time to leave, or a minute before the card goes stale if that's sooner. */
    private fun before(a: NextAnswer) = minOf(a.leaveAtMs!! - 6 * 60_000, (a.card?.staleAtMs ?: Long.MAX_VALUE) - 60_000)

    @Test fun aTripIsSentencesOfTheServersWords() {
        val a = golden("place")
        val said = Spoken.summary(true, a, null, before(a), clock = clock)
        assertTrue(said, said.startsWith("To KR MRT. A1, leaves 09:09. "))
        assertTrue(said, said.contains("Leave by 09:03"))
        assertFalse(said, said.contains(" · "))
    }

    @Test fun underItsOwnHeadingTheCardDoesNotSayWhereToAgain() {
        val a = golden("place")
        val said = Spoken.summary(true, a, null, before(a), withHead = false, clock = clock)
        assertTrue(said, said.startsWith("A1, leaves 09:09. "))
        assertFalse(said, said.contains("To KR MRT"))
        a.phaseText?.let { assertFalse(said, said.contains(it)) }
    }

    @Test fun aTimetableGuessSaysAboutAndHowSure() {
        val a = golden("scheduled")
        val said = Spoken.summary(true, a, null, before(a), clock = clock)
        assertTrue(said, said.contains("A1, leaves about 09:11"))
        assertTrue(said, said.contains("Timetable estimate"))
        assertFalse(said, said.contains("~"))
    }

    @Test fun aClassSaysItsQualityToo() {
        val a = golden("class-bus")
        val said = Spoken.summary(true, a, null, before(a), clock = clock)
        assertTrue(said, said.contains("Leave by about 09:36"))
        assertTrue(said, said.contains("R2"))
    }

    @Test fun onTheBusItSaysWhereToGetOff() {
        val a = golden("riding")
        val ride = a.card!!.ride!!
        val said = Spoken.summary(true, a, null, ride.arriveMs - 60_000, clock = clock)
        assertTrue(said, said.startsWith("On the R2, to "))
        assertTrue(said, said.contains("Off at UTown"))
        assertTrue(said, said.contains("Timetable estimate"))
    }

    @Test fun noInstructionsInTheSentence() {
        assertEquals("terminus. This phone isn't paired yet.", Spoken.summary(false, null, null, 0, clock = clock))
        assertFalse(Spoken.summary(true, golden("place"), null, 0, clock = clock).contains("Double tap"))
    }

    @Test fun theCountdownIsInWholeMinutes() {
        val a = golden("place")
        assertEquals("Leave in 6 minutes", Spoken.countdown(a, a.leaveAtMs!! - 6 * 60_000))
        assertEquals("Leave in 1 minute", Spoken.countdown(a, a.leaveAtMs!! - 65_000))
        assertEquals("Leave in under a minute", Spoken.countdown(a, a.leaveAtMs!! - 20_000))
    }

    @Test fun theAnnouncementDoesNotTick() {
        val a = golden("class-bus")
        val said = Spoken.announcement(a)
        assertNotNull(said)
        assertTrue(said!!, said.contains("R2"))
        assertFalse(said, Regex("\\d+ min").containsMatchIn(said))
    }

    @Test fun aBusTimeSaysWhetherItsLive() {
        assertEquals("about 6 minutes, timetable", Spoken.eta(360, "scheduled"))
        assertEquals("about 6 minutes", Spoken.eta(360, "scheduled", withQuality = false))
        assertEquals("6 minutes, live", Spoken.eta(360, "live"))
        assertEquals("1 minute, live", Spoken.eta(60, "live"))
        assertEquals("Arriving", Spoken.eta(20, "live"))
        assertEquals(null, Spoken.eta(null, "unknown"))
        // A quality this version doesn't know is no live time.
        assertEquals("about 6 minutes", Spoken.eta(360, "stale"))
    }

    @Test fun inChinese() {
        TestStrings.install("values-zh")
        try {
            assertEquals("约 6 分钟，按时刻表", Spoken.eta(360, "scheduled"))
            assertEquals("6 分钟后出发", L.s(R.string.a11y_leave_in, Spoken.minutes(360)))
            assertEquals("约 09:11", Spoken.spell("~09:11"))
        } finally {
            TestStrings.install()
        }
    }
}
