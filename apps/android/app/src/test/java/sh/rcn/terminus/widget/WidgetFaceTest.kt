package sh.rcn.terminus.widget

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.TestStrings
import java.io.File
import java.time.Instant
import java.time.ZoneId

/** What every widget says, from the server's golden answers (the API's tests pin them), and how it picks a layout. */
class WidgetFaceTest {
    private val dir = listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }

    /** Not /me/next answers. */
    private val notAnswers = setOf("day.json", "nearby-list.json", "setup.json")

    private fun answers(sub: String = ""): Map<String, NextAnswer> =
        File(dir, sub).listFiles { f -> f.name.endsWith(".json") && f.name !in notAnswers }!!.sortedBy { it.name }
            .associate { it.name to NextAnswer.parse(JSONObject(it.readText())) }

    /** While the answer holds: just before it goes stale, or at the goldens' morning. */
    private fun fresh(a: NextAnswer): Long = a.card?.staleAtMs?.minus(1) ?: Instant.parse("2026-08-27T01:05:00Z").toEpochMilli()

    private fun face(a: NextAnswer, error: String? = null, now: Long = fresh(a)) =
        Face.of(true, Mode.Timetable, a, error, null, now) { "%tR".format(it) }

    private fun load(name: String, sub: String = "") = NextAnswer.parse(JSONObject(File(File(dir, sub), name).readText()))

    @Test fun everyAnswerHasAHeadlineAndItsAccentIsInIt() {
        for (lang in listOf("values" to "", "values-zh" to "zh")) {
            TestStrings.install(lang.first)
            for ((name, a) in answers(lang.second)) {
                val f = face(a)
                assertTrue("$name: headline", f.headline.isNotBlank())
                f.accent?.let { assertTrue("$name: accent '$it' in '${f.headline}'", f.headline.contains(it)) }
                // A bus to catch: its badge on the ground, and how sure its time is.
                val bus = a.card?.journey?.bus
                if (bus != null && a.card.phase != "riding" && !isOld(a, fresh(a))) {
                    assertEquals("$name: leg", bus.svc, f.leg?.svc)
                    assertNotNull("$name: pill", f.pill)
                    assertTrue("$name: your stop on the road", f.road.stop)
                }
            }
        }
        TestStrings.install()
    }

    @Test fun theLeaveTimeIsTheBigPart() {
        TestStrings.install()
        val f = face(load("class-bus.json"))
        assertEquals("~09:36", f.big)
        assertEquals("Leave by", f.bigLabel)
        assertFalse(f.bigFirst)
        // The golden's time is a timetable guess: Scheduled, never Live.
        assertEquals(false, f.pill?.good)
        assertEquals("R2", f.leg?.svc)
        assertTrue(f.leg!!.text.contains("PGP"))
    }

    @Test fun inChineseTheTimeComesFirstAndItsLabelGoesUnder() {
        TestStrings.install("values-zh")
        val f = face(load("class-bus.json", "zh"))
        assertEquals("约 09:36", f.big)
        assertEquals("前出发", f.bigLabel)
        assertTrue(f.bigFirst)
        TestStrings.install()
    }

    @Test fun onFootThereIsNoPillAndTheLegIsTheBusItBeats() {
        TestStrings.install()
        val f = face(load("class-walk.json"))
        assertNull(f.pill)
        assertEquals("D1 would be 16 min", f.leg?.text)
        assertNull(f.leg?.svc)
    }

    @Test fun ridingShowsWhereYouGetOffAndTheBusNearingIt() {
        TestStrings.install()
        val a = load("riding.json")
        val f = face(a, now = a.card!!.ride!!.boardMs + 1)
        assertNotNull(f.accent)
        assertTrue(f.headline.contains(f.accent!!))
        assertNotNull(f.leg?.svc)
        val bus = f.road.bus
        assertNotNull(bus)
        assertTrue("just boarded: far from the stop", bus!!.far > 0.9f)
    }

    @Test fun aFreeDayShowsTheNextClassInATile() {
        TestStrings.install()
        val a = load("free.json")
        val f = face(a)
        if (a.card?.upcoming != null) {
            assertEquals(a.card.upcoming!!.title, f.tile?.title)
            assertNull(f.sub)
        }
        assertNull(f.leg)
    }

    @Test fun aProblemTakesTheLineUnderTheHeadline() {
        TestStrings.install()
        val a = load("class-bus.json")
        assertEquals("No connection", face(a, error = "No connection").sub)
        assertEquals("Updating…", face(a, error = UPDATING).sub)
    }

    @Test fun signedOutAndNothingYet() {
        TestStrings.install()
        assertEquals("terminus", Face.of(false, Mode.Timetable, null, null, null, 0) { "" }.headline)
        val loading = Face.of(true, Mode.Timetable, null, null, null, 0) { "" }
        assertEquals("Loading…", loading.headline)
        assertEquals("Tap to refresh", loading.sub)
    }

    @Test fun shapeFollowsTheSize() {
        // One row is a bar whatever its width; narrow is the square; tall and wide is your day.
        assertEquals(WidgetShape.BAR, WidgetShape.of(340f, 100f))
        assertEquals(WidgetShape.BAR, WidgetShape.of(180f, 110f))
        assertEquals(WidgetShape.SQUARE, WidgetShape.of(170f, 170f))
        assertEquals(WidgetShape.TRIP, WidgetShape.of(340f, 210f))
        assertEquals(WidgetShape.DAY, WidgetShape.of(340f, 420f))
        assertEquals(WidgetShape.SQUARE, WidgetShape.of(170f, 420f))
    }

    @Test fun theSkyIsRedrawnWhenItsHourChanges() {
        // Dawn at 6:30, day at 8:30, the golden hour at 4:30 PM, dusk at 6:45 PM, night at 7:40 PM.
        assertEquals(390, minutesToNextPhase(0))
        assertEquals(1, minutesToNextPhase(389))
        assertEquals(120, minutesToNextPhase(390))
        assertEquals(55, minutesToNextPhase(1125))
        assertEquals(24 * 60 - 1180 + 390, minutesToNextPhase(1180))
        val sgt = ZoneId.of("Asia/Singapore")
        val at = Instant.parse("2026-10-08T22:29:30Z").toEpochMilli() // 6:29:30 AM in Singapore
        assertEquals(Instant.parse("2026-10-08T22:30:00Z").toEpochMilli(), nextPhaseAt(at, sgt))
    }
}
