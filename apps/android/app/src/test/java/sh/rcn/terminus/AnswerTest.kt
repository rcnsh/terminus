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
    init { TestStrings.install() }

    private fun golden(name: String): NextAnswer {
        val dir = listOf("../../api/test/fixtures/answers", "../api/test/fixtures/answers").map(::File).first { it.isDirectory }
        return NextAnswer.parse(JSONObject(File(dir, "$name.json").readText()))
    }

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun everyGoldenAnswerParses() {
        for (name in listOf("class-bus", "class-walk", "class-late", "class-from-dorm", "class-started", "place", "landmark", "arrived", "free", "rest", "home", "home-reached", "evening-home", "setup")) {
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
        assertEquals("Crowding: medium", a.card?.crowd)
        // The headline ticks on the phone: "Leave now" once leave.at passes.
        val at = a.leaveAtMs!!
        assertEquals("Leave by ~09:36", a.leaveHeadline(at - 1))
        assertEquals("Leave now", a.leaveHeadline(at))
    }

    @Test fun crowdIsShownOnceWhenTheDetailSaysIt() {
        // "… · crowding: high · or D2 in 14 min": not said again under it.
        val a = golden("place")
        assertTrue(a.detail.contains("crowding: high"))
        assertEquals(null, a.crowdText)
    }

    @Test fun lateClassIsLate() {
        val a = golden("class-late")
        assertTrue(a.leaveLate)
        assertEquals("Arrive 09:15 · ~10 min late", a.catchArrive)
    }

    @Test fun otherKindsAreNotClassCards() {
        for (name in listOf("place", "free", "rest", "arrived", "home", "setup")) assertFalse(name, golden(name).isClassPlan)
        assertEquals("Leave by 09:03", golden("place").leaveHeadline(0))
    }

    @Test fun aDayWithoutClassesIsFreeWithNoBus() {
        val a = golden("free")
        assertTrue(a.isFree)
        assertEquals("No classes today", a.label)
        assertNull(a.departsAtMs)
        assertEquals("No classes", a.card!!.glance)
    }

    @Test fun cardV2CarriesThePhaseAndOnlyPlans() {
        val a = golden("class-late")
        assertEquals("heading", a.card!!.phase)
        assertEquals("On your way", a.phaseText)
        assertEquals(listOf("skipped"), a.card!!.actions.map { it.id })
        assertTrue(a.card!!.actions.all { it.trip == "4:545:UTOWN" })
        assertTrue(a.card!!.glance!!.length <= 12)
        assertNotNull(a.card!!.nextChangeAtMs)
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

    @Test fun aSuggestionParsesAndAnOldQuestionIsIgnored() {
        val a = NextAnswer.parse(
            JSONObject(
                """{"label":"On the R2","detail":"Off at UTown · arrive ~9:52","mode":"trip","card":{"kind":"trip","phase":"riding",
                "ask":{"trip":"4:600:UTOWN","question":"On the 9:41 R2?","actions":[{"id":"boarded","label":"On it","trip":"4:600:UTOWN"},
                {"id":"missed","label":"Missed it","trip":"4:600:UTOWN"},{"id":"skipped","label":"Not going","trip":"4:600:UTOWN"}]},
                "askMuted":false,"remind":false,
                "suggestion":{"id":"earlier:4:600:UTOWN","text":"Leave one bus earlier?","accept":"Leave earlier","dismiss":"No thanks"}}}""",
            ),
        )
        // A question from an older server is simply not shown: nothing asks any more.
        val card = a.card!!
        assertFalse(card.remind)
        assertEquals("earlier:4:600:UTOWN", card.suggestion!!.id)
        // Older cards have none of it, and still remind.
        val golden = golden("class-bus").card!!
        assertNull(golden.suggestion)
        assertTrue(golden.remind)
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
        assertTrue(isNewer("2.0.0-beta", "1.3.10"))
        assertTrue(isNewer("2.0.0", "2.0.0-beta"))
        assertTrue(isNewer("2.0.0-beta.2", "2.0.0-beta"))
        assertFalse(isNewer("2.0.0-beta", "2.0.0"))
        assertFalse(isNewer("2.0.0-beta", "2.0.0-beta"))
    }

    @Test
    fun `the server's errors are shown as sentences`() {
        assertEquals("Not a valid NUSMods share link.", ApiError(400, "not a valid NUSMods share link").message)
        assertEquals("Nothing imported: no stop. Your timetable was not changed.", sentence("Nothing imported: no stop. Your timetable was not changed."))
    }

    @Test fun theJourneyComesFromTheServer() {
        val j = golden("class-bus").card!!.journey!!
        assertEquals("R2", j.bus.svc)
        assertEquals(0xFF34A853, j.bus.color)
        assertEquals("PGP", j.bus.stop)
        assertEquals("~09:36", j.leave)
        assertEquals("5 min", j.walk)
        assertEquals("UTown", j.toStop)
        assertEquals("9 min early", j.slack)
        assertEquals(ms("2026-08-27T01:42:00Z"), j.boardAtMs)
        assertEquals("09:06", j.backup?.board)
        // On foot, there's no journey to draw.
        assertNull(golden("evening-home").card!!.journey)
        assertNull(golden("class-walk").card!!.journey)
    }

    @Test fun theJourneyCountsDownToLeaving() {
        val a = golden("place")
        val j = a.card!!.journey!!
        val at = a.leaveAtMs!!
        assertEquals("Leave in 5 min", JourneyText.leaveIn(a, j, at - 5 * 60_000 + 10_000))
        assertEquals("Leave in 1 min 5 s", JourneyText.leaveIn(a, j, at - 65_000))
        assertEquals("Leave in 45 s", JourneyText.leaveIn(a, j, at - 45_000))
        assertEquals("Leave now", JourneyText.leaveIn(a, j, at))
        assertEquals("by 09:03", JourneyText.by(a, j, at - 45_000))
        assertNull(JourneyText.by(a, j, at))
        assertEquals("Or D2 at 09:14 from PGP", JourneyText.backup(a, j))
        assertEquals("Arrive 09:10", JourneyText.arrive(j))
    }

    @Test fun aClassJourneyOffersTheSoonerBusToGoNowOn() {
        val a = golden("class-bus")
        assertEquals("Or go now: R2 at 09:06 from PGP", JourneyText.backup(a, a.card!!.journey!!))
        assertEquals("Arrive ~09:51 · 9 min early", JourneyText.arrive(a.card.journey!!))
    }
}
