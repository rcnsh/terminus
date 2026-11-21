package sh.rcn.terminus

import java.io.File
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.ui.reportReasons
import sh.rcn.terminus.ui.withoutLocalUndo
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.isOld

class AnswerTest {
    init {
        TestStrings.install()
    }

    private fun goldenJson(name: String): JSONObject {
        val dir = listOf("../../../fixtures/answers", "../../fixtures/answers").map(::File).first { it.isDirectory }
        return JSONObject(File(dir, "$name.json").readText())
    }

    private fun golden(name: String): NextAnswer = NextAnswer.parse(goldenJson(name))

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    private fun everyGolden(): List<Pair<String, JSONObject>> {
        val dir = listOf("../../../fixtures/answers", "../../fixtures/answers").map(::File).first { it.isDirectory }
        return listOf(dir, File(dir, "zh")).flatMap { d ->
            d.listFiles { f -> f.extension == "json" }
                .orEmpty()
                .sortedBy { it.name }
                .map { f ->
                    (if (d == dir) f.nameWithoutExtension else "zh/${f.nameWithoutExtension}") to JSONObject(f.readText())
                }
        }
    }

    private fun hasCjk(s: String) = s.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.HAN }

    @Test
    fun everyGoldenAnswerParses() {
        val all = everyGolden()
        assertTrue("found the goldens", all.size >= 40)
        for ((name, json) in all) {
            val zh = name.startsWith("zh/")
            when {
                json.has("stops") -> assertTrue(name, parseNearby(json).isNotEmpty())
                json.has("items") -> assertTrue(name, DayPlan.parse(json).items.isNotEmpty())
                else -> {
                    val a = NextAnswer.parse(json)
                    assertNotNull("$name has a card", a.card)
                    val card = a.card!!
                    val sent = json.getJSONObject("card")
                    for ((key, got) in
                        listOf(
                            "journey" to card.journey,
                            "ride" to card.ride,
                            "upcoming" to card.upcoming,
                            "suggestion" to card.suggestion,
                            "walkTo" to card.walkTo,
                        )) {
                        if (sent.has(key) && !sent.isNull(key)) assertNotNull("$name: card.$key", got)
                    }
                    sent.optJSONObject("journey")?.optJSONObject("change")?.let {
                        assertNotNull("$name: journey.change", card.journey?.change)
                    }
                    sent.optJSONObject("ride")?.optJSONObject("change")?.let { assertNotNull("$name: ride.change", card.ride?.change) }
                    assertEquals("$name: card.actions", sent.optJSONArray("actions")?.length() ?: 0, card.actions.size)
                    if (zh) assertTrue("$name is in Chinese: ${a.label}", hasCjk(a.label) || hasCjk(a.detail))
                }
            }
        }
    }

    @Test
    fun aReplyOfTheWrongShapeIsAParseErrorNotOffline() {
        assertThrows(ParseError::class.java) { parseNearby(JSONObject("""{"stops":[{"board":[]}]}""")) }
        assertThrows(ParseError::class.java) { Campus.parse(JSONObject("{}")) }
        assertThrows(ParseError::class.java) { DayPlan.parse(JSONObject("""{"items":[1]}""")) }
        assertThrows(ParseError::class.java) { ImportResult.parse(JSONObject("{}")) }
    }

    @Test
    fun anythingButALiveTimeIsApproximate() {
        val a = golden("place").copy(card = null)
        val fmt = { _: Long -> "09:42" }
        assertEquals("${a.label.substringBefore(" · ")} · 09:42", a.copy(quality = "live").clockLabel(fmt))
        for (q in listOf("scheduled", "stale", "something-new")) assertEquals(
            "${a.label.substringBefore(" · ")} · ~09:42",
            a.copy(quality = q).clockLabel(fmt),
        )
    }

    @Test
    fun classCardLinesComeFromTheServer() {
        val a = golden("class-bus")
        assertTrue(a.isClassPlan)
        assertEquals("Catch the ~09:42 R2 at PGP", a.catchHow)
        assertEquals("Arrive ~09:51 · 9 min early", a.catchArrive)
        assertEquals("Or go now: R2 at 09:06 · arrive 09:15", a.goNowLine)
        assertEquals("Crowding: medium", a.card?.crowd)
        val at = a.leaveAtMs!!
        assertEquals("Leave by ~09:36", a.leaveHeadline(at - 1))
        assertEquals("Leave now", a.leaveHeadline(at))
    }

    @Test
    fun crowdIsShownOnceWhenTheDetailSaysIt() {
        val a = golden("place")
        assertTrue(a.detail.contains("crowding: high"))
        assertEquals(null, a.crowdText)
    }

    @Test
    fun lateClassIsLate() {
        val a = golden("class-late")
        assertTrue(a.leaveLate)
        assertEquals("Arrive 09:15 · ~10 min late", a.catchArrive)
    }

    @Test
    fun otherKindsAreNotClassCards() {
        for (name in listOf("place", "free", "rest", "arrived", "home", "setup")) assertFalse(name, golden(name).isClassPlan)
        assertEquals("Leave by 09:03", golden("place").leaveHeadline(0))
    }

    @Test
    fun aDayWithoutClassesIsFreeWithNoBus() {
        val a = golden("free")
        assertTrue(a.isFree)
        assertEquals("No classes today", a.label)
        assertNull(a.departsAtMs)
        assertEquals("No classes", a.card!!.glance)
    }

    @Test
    fun theNextClassComesWithItsOwnCard() {
        val u = golden("rest").card?.upcoming
        assertEquals(Upcoming("Today", "CS2030 at 13:00", "At COM 3", null), u)
        assertEquals("CS2030，10:00 开始", golden("zh/free").card?.upcoming?.title)
        assertNull(golden("class-bus").card?.upcoming)
    }

    @Test
    fun cardV2CarriesThePhaseAndOnlyPlans() {
        val a = golden("class-late")
        val card = a.card!!
        assertEquals("heading", card.phase)
        assertEquals("On your way", a.phaseText)
        assertEquals(listOf("skipped"), card.actions.map { it.id })
        assertTrue(card.actions.all { it.trip == "4:545:UTOWN" })
        assertTrue(card.glance!!.length <= 12)
        assertNotNull(card.nextChangeAtMs)
    }

    @Test
    fun aBusGoneWithNothingKnownSaysSoNotLeaveNow() {
        val card = golden("bus-gone").card!!
        assertTrue(card.gone)
        assertTrue(card.line!!.startsWith("The 09:06 has left"))
        assertFalse(golden("class-late").card!!.gone)
    }

    @Test
    fun staleFollowsTheServer() {
        val a = golden("class-bus")
        val at = a.card!!.staleAtMs!!
        assertFalse(isOld(a, at - 1))
        assertTrue(isOld(a, at))
    }

    @Test
    fun onlyAnAnswerWithNoCardIsOldWithoutStaleAt() {
        val old = NextAnswer.parse(JSONObject("""{"label":"D2 · 4 min","departsAt":"2026-08-27T01:04:00Z","mode":"trip"}"""))
        assertNull(old.card)
        assertTrue(isOld(old, ms("2026-08-27T01:00:00Z")))
        for (kind in listOf("setup", "rest", "free", "trip")) {
            val a = NextAnswer.parse(JSONObject("""{"label":"x","mode":"free","card":{"kind":"$kind","staleAt":null}}"""))
            assertFalse(kind, isOld(a, ms("2030-01-01T00:00:00Z")))
        }
    }

    @Test
    fun aSuggestionParsesAndAnOldQuestionIsIgnored() {
        val a =
            NextAnswer.parse(
                JSONObject(
                    """{"label":"On the R2","detail":"Off at UTown · arrive ~9:52","mode":"trip","card":{"kind":"trip","phase":"riding",
                "ask":{"trip":"4:600:UTOWN","question":"On the 9:41 R2?","actions":[{"id":"boarded","label":"On it","trip":"4:600:UTOWN"},
                {"id":"missed","label":"Missed it","trip":"4:600:UTOWN"},{"id":"skipped","label":"Not going","trip":"4:600:UTOWN"}]},
                "askMuted":false,"remind":false,
                "suggestion":{"id":"earlier:4:600:UTOWN","text":"Leave one bus earlier?","accept":"Leave earlier","dismiss":"No thanks"}}}"""
                )
            )
        val card = a.card!!
        assertFalse(card.remind)
        assertEquals("earlier:4:600:UTOWN", card.suggestion!!.id)
        val golden = golden("class-bus").card!!
        assertNull(golden.suggestion)
        assertTrue(golden.remind)
    }

    @Test
    fun notJsonIsAParseErrorNotOffline() {
        try {
            NextAnswer.parse(JSONObject("""{"detail":"no label"}"""))
            throw AssertionError("should not parse")
        } catch (_: ParseError) {}
    }

    @Test
    fun anOfflineRedrawKeepsTheAnswersOwnMoments() {
        val a = golden("class-bus")
        val fetched = ms(a.asOf)
        val card = a.card!!
        val first = listOfNotNull(card.nextChangeAtMs, card.staleAtMs, a.leaveAtMs).filter { it > fetched }.min()
        assertEquals(first, Refresher.redrawAt(a, fetched))
        a.leaveAtMs?.let { leave -> assertTrue(Refresher.redrawAt(a, leave - 1)!! <= leave) }
        assertNull(Refresher.redrawAt(a, listOfNotNull(card.nextChangeAtMs, card.staleAtMs, a.leaveAtMs).max()))
        val r = golden("riding")
        val ride = r.card!!.ride!!
        assertTrue(Refresher.redrawAt(r, ride.boardMs)!! <= RideStyle.nextRedrawAt(ride, ride.boardMs)!!)
    }

    @Test
    fun refreshWaitsForTheNextChangeButNotTooSoon() {
        val a = golden("class-bus")
        val fetched = ms(a.asOf)
        assertEquals(a.card!!.nextChangeAtMs, Refresher.nextRefreshAt(a, fetched, fetched))
        val change = a.card.nextChangeAtMs!!
        assertEquals(change - 5_000 + 15_000, Refresher.nextRefreshAt(a, fetched, change - 5_000))
        assertEquals(a.refreshAtMs, Refresher.nextRefreshAt(a, fetched, fetched, widget = false))
    }

    @Test
    fun onlyTheServersMomentsWakeThePhone() {
        val a = golden("class-bus")
        val fetched = ms(a.asOf)
        val change = a.card!!.nextChangeAtMs!!
        val plan = a.refreshAtMs!!
        assertTrue("the card changes before the plan does", change < plan)
        assertEquals(change to null, Refresher.refreshAlarms(a, fetched, fetched, widget = true, notifying = false))
        assertEquals(null to plan, Refresher.refreshAlarms(a, fetched, fetched, widget = false, notifying = true))
        assertEquals(change to plan, Refresher.refreshAlarms(a, fetched, fetched, widget = true, notifying = true))
        assertEquals(null to plan, Refresher.refreshAlarms(a, fetched, change + 1, widget = true, notifying = true))
    }

    @Test
    fun theFallbackCountsFromWhenTheAnswerCameNotItsAsOf() {
        val a = golden("class-bus")
        val card = a.card!!
        val fetched = listOfNotNull(a.refreshAtMs, card.nextChangeAtMs, card.staleAtMs).max() + 60_000
        assertTrue(fetched > ms(a.asOf))
        assertEquals(fetched + 15 * 60_000L, Refresher.nextRefreshAt(a, fetched, fetched))
        assertEquals(fetched + 15 * 60_000L, Refresher.nextRefreshAt(a, fetched, fetched, widget = false))
    }

    @Test
    fun refreshDoesNotChaseTheLeaveTimeOrTheRidesStops() {
        val a = golden("class-bus")
        val now = ms("2026-08-27T01:10:00Z")
        assertEquals(a.refreshAtMs, Refresher.nextRefreshAt(a, ms(a.asOf), now))
        assertEquals(a.leaveAtMs, Refresher.redrawAt(a, now))
        val r = golden("riding")
        val ride = r.card!!.ride!!
        assertEquals(r.refreshAtMs, Refresher.nextRefreshAt(r, ms(r.asOf), ride.boardMs))
        assertEquals(RideStyle.nextRedrawAt(ride, ride.boardMs), Refresher.redrawAt(r, ride.boardMs))
    }

    @Test
    fun theFloorLeavesTheNetworkAloneWhileOnTrack() {
        val a = golden("rest")
        val now = ms(a.asOf)
        val alarm = a.card!!.nextChangeAtMs!!
        assertTrue(Refresher.onTrack(a, null, alarm, now))
        assertFalse(Refresher.onTrack(a, "Offline", alarm, now))
        assertFalse(Refresher.onTrack(a, null, now - 1, now))
        assertFalse(Refresher.onTrack(a, null, alarm + 60_000, a.card.staleAtMs!!))
        assertFalse(Refresher.onTrack(null, null, alarm, now))
    }

    @Test
    fun aBrokenPartOfTheCardIsLeftOutAndTheRestStands() {
        val json = goldenJson("class-room")
        val card = json.getJSONObject("card")
        card.getJSONArray("actions").getJSONObject(0).remove("label")
        card.getJSONArray("actions").put("not an action")
        card.getJSONObject("walkTo").put("lat", "north")
        card.put("suggestion", JSONObject().put("id", "earlier:x"))
        card.put(
            "ride",
            JSONObject("""{"svc":"R2","stops":[{"name":"PGP"},7],"board":"2026-08-27T01:42:00Z","arrive":"2026-08-27T01:53:00Z"}"""),
        )
        card.put("upcoming", JSONObject().put("when", "Today"))
        card.getJSONObject("journey").put("bus", JSONObject().put("color", "#34a853"))
        json.put("detail", JSONObject.NULL).put("asOf", JSONObject.NULL)
        val a = NextAnswer.parse(json)
        val c = a.card!!
        assertEquals(listOf("away"), c.actions.map { it.id })
        assertNull(c.walkTo)
        assertNull(c.suggestion)
        assertNull(c.ride)
        assertNull(c.upcoming)
        assertNull(c.journey)
        assertEquals("", a.detail)
        assertEquals("", a.asOf)
        val whole = golden("class-room")
        assertNotNull(c.leaveBy)
        assertEquals(whole.card!!.leaveBy, c.leaveBy)
        assertEquals(whole.catchHow, a.catchHow)
        assertEquals(whole.card.staleAtMs, c.staleAtMs)
        assertEquals(whole.destLabel, a.destLabel)
        assertEquals(whole.leaveAtMs, a.leaveAtMs)
    }

    @Test
    fun nullTextInTheJourneyIsNotTheWordNull() {
        val json = goldenJson("class-bus")
        val journey = json.getJSONObject("card").getJSONObject("journey")
        journey.put("to", JSONObject.NULL).put("toStop", JSONObject.NULL)
        journey.getJSONObject("backup").put("stop", JSONObject.NULL).put("board", JSONObject.NULL)
        json.getJSONObject("card").put("upcoming", JSONObject("""{"when":null,"title":"CS2030 at 13:00","where":null,"off":null}"""))
        val c = NextAnswer.parse(json).card!!
        assertEquals("", c.journey!!.to)
        assertEquals("", c.journey.toStop)
        assertEquals("", c.journey.backup!!.stop)
        assertEquals("", c.journey.backup.board)
        assertEquals(Upcoming("", "CS2030 at 13:00", "", null), c.upcoming)
    }

    @Test
    fun theHeadlineAndHeadingAreTheServers() {
        val bus = golden("class-bus")
        assertEquals("R2 · 09:06", bus.card!!.title)
        assertEquals("R2 · 09:06", bus.clockLabel { "never" })
        assertEquals("Next class · GEA1000 @ UTown", bus.card.heading)
        val scheduled = golden("scheduled")
        assertEquals("A1 · ~09:11", scheduled.title)
        assertEquals("Going to KR MRT", scheduled.card!!.heading)
        assertEquals("A1 · 约 09:11", golden("zh/scheduled").title)
        val none = golden("no-timetable")
        assertEquals("No timetable yet", none.title)
        assertNull(none.card!!.heading)
        assertFalse(
            "a card without staleAt never dims",
            isOld(golden("setup").copy(card = golden("setup").card!!.copy(staleAtMs = null)), ms("2030-01-01T00:00:00Z")),
        )
    }

    @Test
    fun theReminderIsWhenTheServerSays() {
        val a = golden("class-bus")
        assertEquals(a.leaveAtMs!! - 5 * 60_000, a.card!!.remindAtMs)
        assertNull(golden("class-late").card!!.remindAtMs)
        assertNull(golden("riding").card!!.remindAtMs)
        assertNull(golden("place").card!!.remindAtMs)
    }

    @Test
    fun theJourneyIsWordedByTheServer() {
        val j = golden("class-bus").card!!.journey!!
        assertEquals("arrive ~09:51 · R2 ~09:42 at PGP", j.text.summary)
        assertEquals("To GEA1000 @ UTown · starts 10:00", j.text.title)
        assertEquals("by ~09:36", j.text.by)
        assertEquals("5 min walk", JourneyText.walk(j))
        assertEquals("Arrive ~09:51 · 9 min early", JourneyText.arrive(j))
    }

    @Test
    fun onTheBusTheRideComesWithIt() {
        val a = golden("riding")
        val c = a.card!!
        assertEquals("riding", c.phase)
        assertEquals("On the R2", c.title)
        assertNull(c.journey)
        val ride = c.ride!!
        assertEquals("R2", ride.svc)
        assertEquals("PGP", ride.stops.first())
        assertEquals("UTown", ride.stops.last())
        assertTrue(ride.arriveMs > ride.boardMs)
        assertEquals("Next: Opp HSSML · 6 stops to go", ride.nextText(ride.boardMs))
    }

    @Test
    fun aTripThatChangesBusesCarriesTheSecondBus() {
        val j = golden("change-class").card!!.journey!!
        assertEquals("K", j.bus!!.svc)
        assertEquals("14 min, then P", j.ride)
        assertEquals("14 min ride · change at Kent Vale to the 09:42 P · 14 min ride", JourneyText.ride(j))
        val c = j.change!!
        assertEquals("Kent Vale", c.from)
        assertEquals("P", c.bus.svc)
        assertEquals(ms("2026-08-27T01:42:00Z"), c.boardAtMs)
        assertEquals("14 min ride · off at Kent Vale", c.firstRideText)
        assertEquals("Change at Kent Vale · 5 min wait", c.changeText)
        assertNull(c.walk)
        assertNull(golden("class-bus").card!!.journey!!.change)
    }

    @Test
    fun onTheFirstBusTheSecondIsSaidNearTheChange() {
        val ride = golden("change-riding").card!!.ride!!
        assertEquals("R2", ride.svc)
        assertEquals("Kent Vale", ride.stops.last())
        val change = ride.change!!
        assertEquals("P", change.svc)
        assertEquals("Then P at 09:42 from Kent Vale", change.text)
        assertFalse(ride.nextText(ride.boardMs).contains("Then P"))
        assertEquals("Getting off at Kent Vale · Then P at 09:42 from Kent Vale", ride.nextText(ride.arriveMs))
        assertEquals("Getting off at Kent Vale", ride.nextText(ride.arriveMs, withChange = false))
    }

    @Test
    fun aClassToARoomWalksOnFromItsStop() {
        val a = golden("class-room")
        assertTrue(a.isClassPlan)
        val j = a.card!!.journey!!
        assertEquals("2 min", j.walkEnd)
        assertEquals("~09:51", j.arriveStop)
        assertEquals("~09:53", j.arrive)
        assertEquals(listOf("skipped", "away"), a.card.actions.map { it.id })
        assertEquals("PGP", a.card.walkTo!!.name)
    }

    @Test
    fun versionsCompareNumerically() {
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
        assertEquals(
            "Nothing imported: no stop. Your timetable was not changed.",
            sentence("Nothing imported: no stop. Your timetable was not changed."),
        )
        assertEquals("terminus is busy, try again in a minute.", sentence("terminus is busy, try again in a minute"))
    }

    @Test
    fun theJourneyComesFromTheServer() {
        val j = golden("class-bus").card!!.journey!!
        assertEquals("R2", j.bus!!.svc)
        assertEquals(0xFF34A853, j.bus.color)
        assertEquals("PGP", j.bus.stop)
        assertEquals("~09:36", j.leave)
        assertEquals("5 min", j.walk)
        assertEquals("UTown", j.toStop)
        assertEquals("9 min early", j.slack)
        assertEquals(ms("2026-08-27T01:42:00Z"), j.boardAtMs)
        assertEquals("09:06", j.backup?.board)
        assertNull(j.why)
    }

    @Test
    fun onFootTheJourneyIsTheWalkAlone() {
        val c = golden("class-walk")
        val j = c.card!!.journey!!
        assertNull(j.bus)
        assertNull(j.boardAtMs)
        assertNull(j.ride)
        assertEquals("09:53", j.leave)
        assertEquals("3 min", j.walk)
        assertEquals("09:57", j.arrive)
        assertEquals("3 min early", j.slack)
        assertEquals("CS2030", j.place)
        assertNull(JourneyText.busIn(j, 0))
        assertEquals("D1 would be 13 min", JourneyText.backup(c, j))
        val h = golden("heat-walk")
        val home = h.card!!.journey!!
        assertNull(home.leave)
        assertEquals("13 min", home.walk)
        assertEquals("Leave now", JourneyText.leaveIn(h, home, ms("2026-08-27T01:00:00Z")))
        assertEquals("D2 would be 16 min", JourneyText.backup(h, home))
    }

    @Test
    fun theJourneyCountsDownToLeaving() {
        val a = golden("place")
        val j = a.card!!.journey!!
        val at = a.leaveAtMs!!
        assertEquals("Leave in 5 min", JourneyText.leaveIn(a, j, at - 5 * 60_000 + 10_000))
        assertEquals("Leave in 1 min 5 s", JourneyText.leaveIn(a, j, at - 65_000))
        assertEquals("Leave in 45 s", JourneyText.leaveIn(a, j, at - 45_000))
        assertEquals("Leave now", JourneyText.leaveIn(a, j, at))
        assertEquals("5 min", JourneyText.leaveTime(a, j, at - 5 * 60_000 + 10_000))
        assertEquals("1 min 5 s", JourneyText.leaveTime(a, j, at - 65_000))
        assertEquals("45 s", JourneyText.leaveTime(a, j, at - 45_000))
        assertNull(JourneyText.leaveTime(a, j, at))
        assertEquals("by 09:03", JourneyText.by(a, j, at - 45_000))
        assertNull(JourneyText.by(a, j, at))
        assertEquals("Or D2 at 09:14 from PGP", JourneyText.backup(a, j))
        assertEquals("Arrive 09:10", JourneyText.arrive(j))
    }

    @Test
    fun aRoomJourneyWalksOnFromItsStop() {
        val j = golden("room").card!!.journey!!
        assertEquals("IT", j.toStop)
        assertEquals("LT3", j.place)
        assertEquals("1 min", j.walkEnd)
        assertEquals("09:12", j.arriveStop)
        assertEquals("09:13", j.arrive)
        val p = golden("place").card!!.journey!!
        assertNull(p.walkEnd)
        assertEquals(p.arrive, p.arriveStop)
    }

    @Test
    fun aClassJourneyOffersTheSoonerBusToGoNowOn() {
        val a = golden("class-bus")
        assertEquals("Or go now: R2 at 09:06 from PGP", JourneyText.backup(a, a.card!!.journey!!))
        assertEquals("Arrive ~09:51 · 9 min early", JourneyText.arrive(a.card.journey))
    }

    @Test
    fun aClassJourneySaysWhenTheClassStarts() {
        val a = golden("class-bus")
        assertEquals("To GEA1000 @ UTown · starts 10:00", JourneyText.to(a, a.card!!.journey!!) { "10:00" })
        val p = golden("place")
        assertEquals("To KR MRT", JourneyText.to(p, p.card!!.journey!!) { "10:00" })
    }

    @Test
    fun aOneOffTripSaysArriveByNotStarts() {
        val untitled = { name: String -> goldenJson(name).apply { getJSONObject("card").getJSONObject("journey").remove("title") } }
        val once = NextAnswer.parse(untitled("once-from-home"))
        assertTrue(once.destPlace)
        assertEquals("To COM 3 · arrive by 12:00", JourneyText.to(once, once.card!!.journey!!) { "12:00" })
        val lesson = NextAnswer.parse(untitled("class-bus"))
        assertFalse(lesson.destPlace)
        assertEquals("To GEA1000 @ UTown · starts 10:00", JourneyText.to(lesson, lesson.card!!.journey!!) { "10:00" })
    }

    @Test
    fun anUnknownPhaseAndQualityAreNeitherATripNorLive() {
        val json = goldenJson("class-bus").put("quality", "predicted")
        json.getJSONObject("card").put("phase", "boarding")
        val a = NextAnswer.parse(json)
        assertEquals("boarding", a.card?.phase)
        assertEquals("predicted", a.quality)
        assertEquals("Leave by ~09:36", a.leaveHeadline(0))
        assertFalse(a.card?.phase in LiveService.TRIP_PHASES)
        val utown = sh.rcn.terminus.widget.Mode.To(Destinations.Dest("place:utown", "UTown"))
        val now = a.leaveAtMs!!
        assertEquals(utown, sh.rcn.terminus.widget.WidgetModes.effective(utown, now - 10 * 60_000, a, rowShown = true, now = now))
        assertEquals(Spoken.eta(300, "unknown"), Spoken.eta(300, a.quality))
        assertFalse(Spoken.eta(300, a.quality)!!.contains("live"))
    }

    @Test
    fun theCardsUndoHidesOnlyForTheTripInTheUndoBar() {
        val a = golden("skipped-undo")
        val trip = a.card!!.actions.single { it.id == "reset" }.trip
        assertEquals(listOf("reset"), withoutLocalUndo(a, null)!!.card!!.actions.map { it.id })
        assertEquals(listOf("reset"), withoutLocalUndo(a, "another:trip")!!.card!!.actions.map { it.id })
        assertTrue(withoutLocalUndo(a, trip)!!.card!!.actions.isEmpty())
        assertNull(withoutLocalUndo(null, trip))
    }

    @Test
    fun theBusesEitherSideComeWithTheCardAndGoBackAsTheyCame() {
        val step = golden("class-bus").card!!.step!!
        assertEquals("4:600:UTOWN", step.trip)
        val earlier = step.earlier!!
        val later = step.later!!
        assertEquals("D2", earlier.svc)
        assertEquals("PGP", earlier.stop)
        assertEquals(ms("2026-08-27T01:38:00Z"), earlier.boardMs)
        assertEquals(ms("2026-08-27T01:50:00Z"), later.boardMs)
        assertFalse(step.moved)
        assertEquals("Earlier bus", step.earlierLabel)
        assertEquals("Later bus", step.laterLabel)
        assertEquals("Best bus", step.bestLabel)
        val sent = goldenJson("class-bus").getJSONObject("card").getJSONObject("step").getJSONObject("later")
        assertEquals(sent.toString(), JSONObject(later.json).toString())
        val first = golden("scheduled").card!!.step!!
        assertNull(first.earlier)
        assertNotNull(first.later)
        assertEquals("早一班", golden("zh/class-bus").card!!.step!!.earlierLabel)
        assertNull(golden("riding").card!!.step)
        assertNull(golden("home").card!!.step)
        val moved =
            NextAnswer.parse(
                JSONObject(
                    """{"label":"D2 · 9:50","detail":"","mode":"trip","card":{"kind":"class","step":{"trip":"4:600:UTOWN",
                "earlier":{"svc":"D2","stop":"PGP","board":"2026-08-27T01:38:00Z"},"later":null,"moved":true,
                "earlierLabel":"Earlier bus","laterLabel":"Later bus","bestLabel":"Best bus"}}}"""
                )
            )
        val movedStep = moved.card!!.step!!
        assertTrue(movedStep.moved)
        assertNull(movedStep.later)
        val broken =
            NextAnswer.parse(
                JSONObject("""{"label":"D2","detail":"","mode":"trip","card":{"kind":"class","step":{"trip":"4:600:UTOWN"}}}""")
            )
        assertNotNull(broken.card)
        assertNull(broken.card!!.step)
    }

    @Test
    fun theReportSheetKnowsWhenTimesAreNUSs() {
        assertTrue(golden("class-late").card!!.fromNus)
        assertFalse("a public bus's times are LTA's", golden("public-wins").card!!.fromNus)
        assertFalse("an estimate is ours", golden("scheduled").card!!.fromNus)
    }

    private fun offered(card: Card?) = reportReasons(card?.reasons).map { it.first }

    @Test
    fun `the report sheet offers the reasons that fit the card`() {
        val all = listOf("never-came", "times-off", "wrong-stop", "walk-longer", "wrong-class")
        assertEquals(all, offered(golden("class-bus").card))
        assertEquals(all - "never-came", offered(golden("riding").card))
        assertEquals(listOf("wrong-class"), offered(golden("rest").card))
    }

    @Test
    fun `a card from a server without reasons offers them all`() {
        val json = goldenJson("class-bus")
        json.getJSONObject("card").remove("reasons")
        val card = NextAnswer.parse(json).card
        assertNull(card?.reasons)
        assertEquals(5, offered(card).size)
    }
}
