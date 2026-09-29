package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.widget.MAX_AGE_MS
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.isOld
import java.io.File
import java.time.Instant

/**
 * Parses the API's golden answers (apps/api/test/fixtures/answers, checked by
 * the API's own tests), so a change in the response shape fails here too.
 */
class AnswerTest {
    private fun golden(name: String): NextAnswer {
        val dir = listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }
        return NextAnswer.parse(JSONObject(File(dir, "$name.json").readText()))
    }

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun everyGoldenAnswerParses() {
        for (name in listOf("class-bus", "class-walk", "class-late", "class-from-dorm", "place", "landmark", "arrived", "nearby", "rest", "home", "setup")) {
            val a = golden(name)
            assertNotNull("$name has a card", a.card)
        }
    }

    @Test fun classCardLinesComeFromTheServer() {
        val a = golden("class-bus")
        assertTrue(a.isClassPlan)
        assertEquals("Catch the ~09:42 R2 at PGP", a.catchHow)
        assertEquals("Arrive ~09:51 · 9 min early", a.catchArrive)
        assertEquals("Or go now: R2 at 09:06 · arrive 09:15", a.goNowLine)
        assertEquals("Filling", a.crowdText)
        // The headline ticks on the phone: "Leave now" once leave.at passes.
        val at = a.leaveAtMs!!
        assertEquals("Leave by ~09:36", a.leaveHeadline(at - 1))
        assertEquals("Leave now", a.leaveHeadline(at))
    }

    @Test fun lateClassIsLate() {
        val a = golden("class-late")
        assertTrue(a.leaveLate)
        assertEquals("Arrive 09:15 · ~10 min late", a.catchArrive)
    }

    @Test fun otherKindsAreNotClassCards() {
        for (name in listOf("place", "nearby", "rest", "arrived", "home", "setup")) assertFalse(name, golden(name).isClassPlan)
        assertEquals("Leave by 09:03", golden("place").leaveHeadline(0))
    }

    @Test fun staleFollowsTheServer() {
        val a = golden("class-bus")
        val at = a.card!!.staleAtMs!!
        assertFalse(isOld(a, at - MAX_AGE_MS, at - 1))
        assertTrue(isOld(a, at - MAX_AGE_MS, at))
    }

    @Test fun anAnswerCachedBeforeCardsStillDims() {
        val old = NextAnswer.parse(JSONObject("""{"label":"D2 · 4 min","departsAt":"2026-08-27T01:04:00Z","mode":"trip"}"""))
        assertNull(old.card)
        assertFalse(isOld(old, ms("2026-08-27T01:00:00Z"), ms("2026-08-27T01:04:20Z")))
        assertTrue(isOld(old, ms("2026-08-27T01:00:00Z"), ms("2026-08-27T01:04:31Z")))
    }

    @Test fun notJsonIsAParseErrorNotOffline() {
        try {
            NextAnswer.parse(JSONObject("""{"detail":"no label"}"""))
            throw AssertionError("should not parse")
        } catch (_: ParseError) {}
    }

    @Test fun refreshWaitsForTheNextChangeButNotTooSoon() {
        val a = golden("class-bus")
        val fetched = ms(a.asOf)
        val next = Refresher.nextRefreshAt(a, fetched, fetched)
        assertTrue(next >= fetched + 60_000)
        assertTrue(next <= fetched + MAX_AGE_MS)
    }

    @Test fun versionsCompareNumerically() {
        assertTrue(isNewer("1.0.10", "1.0.9"))
        assertFalse(isNewer("1.3.5", "1.3.5"))
        assertFalse(isNewer("1.2", "1.10"))
    }
}
