package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pull to refresh: the sky's stretch, when letting go asks, what the pill says, and the bus on the horizon. */
class PullTest {
    /** Now's horizon on a 393 dp phone, drawn 1.25 times: the card's bus a little way down the road. */
    private val width = 393f / 1.25f
    private val sign = Pull.roadSign(width)
    private val road = PullScene(width, sign, home = Pull.roadBus(sign, 0.5f))

    /** The Buses tab's low hills: no bus of the card's. */
    private val hill = PullScene(393f, Pull.hillSign(393f))

    private fun motion(scene: PullScene = road, calm: Boolean = false) = PullMotion(scene, others = 6, calm = calm)

    /** Steps [ms] of frames at 60 a second. */
    private fun PullMotion.run(ms: Int) = repeat(ms * 60 / 1000) { step(1 / 60f) }

    @Test fun theSkyStretchesLessTheFurtherItGoes() {
        assertEquals(0f, Pull.rubber(0f), 0.001f)
        // The web's numbers: 170 * (1 - e^(-raw / 200)).
        assertEquals(170f * (1 - kotlin.math.exp(-1f)), Pull.rubber(200f), 0.01f)
        val a = Pull.rubber(50f)
        val b = Pull.rubber(100f) - a
        assertTrue(a in 30f..50f)
        assertTrue(b < a)
        assertTrue(Pull.rubber(10_000f) <= Pull.MAX)
        for (raw in listOf(0f, 30f, 120f, 400f)) assertEquals(raw, Pull.unrubber(Pull.rubber(raw)), 0.5f)
    }

    @Test fun theHeaderComesDownALittleAndThePillSitsInTheRoom() {
        assertEquals(0f, Pull.lead(0f), 0.001f)
        assertEquals(12f, Pull.lead(100f), 0.001f)
        // Halfway between the chips (14 dp over the room, come down by the lead) and the words at the room's foot.
        val pull = 84f
        val room = 34f + pull
        val centre = Pull.pillCentre(14f, room, pull)
        assertEquals((Pull.lead(pull) - 14f + room) / 2, centre, 0.001f)
        assertTrue(centre > Pull.lead(pull) - 14f && centre < room)
        // No pill until there's room for it, then all the while it waits.
        assertEquals(0f, Pull.hintAlpha(20f, held = false), 0.001f)
        assertEquals(1f, Pull.hintAlpha(44f, held = false), 0.001f)
        assertEquals(1f, Pull.hintAlpha(0f, held = true), 0.001f)
    }

    @Test fun anAnswerUnderFifteenSecondsOldIsNotAskedAgain() {
        val now = 1_000_000L
        assertTrue(Pull.shouldFetch(null, now))
        assertFalse(Pull.shouldFetch(now - 1_000, now))
        assertFalse(Pull.shouldFetch(now - 14_999, now))
        assertTrue(Pull.shouldFetch(now - 15_000, now))
        // A clock set back since: asked again, rather than never.
        assertTrue(Pull.shouldFetch(now + 60_000, now))
    }

    @Test fun thePillSaysWhatHappened() {
        assertEquals(PullOutcome.UpToDate, Pull.outcome(fetched = false, ok = false))
        assertEquals(PullOutcome.Updated, Pull.outcome(fetched = true, ok = true))
        assertEquals(PullOutcome.Failed, Pull.outcome(fetched = true, ok = false))
        assertEquals(600L, Pull.minShowMs(PullOutcome.UpToDate))
        assertEquals(700L, Pull.minShowMs(PullOutcome.Updated))
    }

    @Test fun upToDateSaysWhenTheNextTimesCome() {
        val now = 1_000_000L
        assertEquals(9, Pull.inS(now + 8_200, now))
        assertEquals(1, Pull.inS(now + 30, now))
        assertNull("no timed refresh due", Pull.inS(null, now))
        assertNull("one already past says nothing", Pull.inS(now - 1, now))
    }

    @Test fun theHorizonsPlacesAreTheOnesItDraws() {
        // Your stop's sign left of the flag (at 0.76 across), the bus short of it.
        assertTrue(sign < width * 0.76f - 6)
        assertEquals(sign - Pull.SHORT_OF_SIGN, Pull.roadBus(sign, 0f), 0.5f)
        assertTrue(Pull.roadBus(sign, 1f) < Pull.roadBus(sign, 0.5f))
        assertEquals(road.home!!, road.from, 0f)
        assertEquals(road.home!!, road.rest, 0f)
        // With no bus of the card's: in from off the left, and back to the stop.
        assertEquals(Pull.START, hill.from, 0f)
        assertEquals(hill.stop, hill.rest, 0f)
    }

    @Test fun theCardsBusDrivesToTheStopAsTheSkyStretches() {
        assertEquals(road.from, Pull.busX(0f, road.from, road.stop), 0.001f)
        assertEquals(road.stop, Pull.busX(1f, road.from, road.stop), 0.001f)
        assertEquals(road.stop, Pull.busX(2f, road.from, road.stop), 0.001f)
        // Eased: past halfway at half the pull.
        assertTrue(Pull.busX(0.5f, road.from, road.stop) > (road.from + road.stop) / 2)
        assertEquals(1f, Pull.progress(Pull.ARM), 0.001f)
        val m = motion()
        m.drag(0.2f)
        m.step(1 / 60f)
        // It starts where the card had it, so nothing jumps.
        assertEquals(road.home!!, m.busX, 0.5f)
    }

    @Test fun theOtherBusesGoRoundInTurnNeverInTheFirstsColour() {
        assertEquals(listOf(1, 2, 3, 1, 2), generateSequence(0) { Pull.nextColour(it, 3) }.drop(1).take(5).toList())
        assertEquals(0, Pull.nextColour(0, 0))
    }

    @Test fun armedItTicksOnceAndLettingGoAsks() {
        val m = motion()
        var ticks = 0
        repeat(40) { if (m.drag(8f)) ticks++ }
        assertTrue(m.armed)
        assertEquals(PullHint.LetGo, m.hint)
        assertTrue(m.lit)
        assertEquals(1, ticks)
        // Back up a little and down again: a tick each time it crosses.
        m.drag(-200f)
        assertFalse(m.armed)
        assertEquals(PullHint.Pull, m.hint)
        if (m.drag(200f)) ticks++
        assertEquals(2, ticks)
        assertTrue(m.release())
        assertEquals(PullMotion.Phase.Busy, m.phase)
        assertEquals(PullHint.Checking, m.hint)
        // It waits at the hold while it asks, however long that takes.
        m.run(2_000)
        assertEquals(Pull.HOLD, m.pull, 1f)
        assertTrue(m.lit)
        assertNull(m.result)
    }

    @Test fun onlyATouchThatStartsAtTheTopPulls() {
        val m = motion()
        // Scrolling up into the top and on: the rest of that drag doesn't pull.
        m.touch()
        m.contentScrolled()
        assertFalse(m.drag(400f))
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.pull, 0.001f)
        // A new touch, at the top: it pulls.
        m.touch()
        m.drag(400f)
        assertEquals(PullMotion.Phase.Drag, m.phase)
        assertTrue(m.armed)
        // Pushed back past the top, the content scrolls: down again in the same touch doesn't pull.
        m.drag(-1_000f)
        m.contentScrolled()
        m.drag(400f)
        assertEquals(PullMotion.Phase.Idle, m.phase)
    }

    @Test fun theBusBoardsThenDrivesOffAndOthersGoRound() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(300)
        assertEquals(PullMotion.Drive.Boarding, m.drive)
        assertEquals(road.stop, m.busX, 0.001f)
        m.run(500)
        assertEquals(PullMotion.Drive.Departing, m.drive)
        assertTrue(m.busX > road.stop)
        assertTrue(m.puffs.isNotEmpty())
        m.run(1_500)
        assertEquals(PullMotion.Drive.Looping, m.drive)
        assertTrue(m.colour > 0)
    }

    @Test fun theAnswerIsSaidThenTheCardsBusComesBackAndItCloses() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(100)
        m.done(PullOutcome.Updated)
        m.run(400)
        assertEquals(PullMotion.Phase.Busy, m.phase)
        m.run(300)
        assertEquals(PullMotion.Phase.Shown, m.phase)
        assertEquals(PullHint.Updated, m.hint)
        assertEquals(PullOutcome.Updated, m.result)
        assertTrue(m.good)
        assertFalse(m.lit)
        // Said for a second, then the sky closes whether or not the bus is back.
        m.run(800)
        assertEquals(PullMotion.Phase.Shown, m.phase)
        m.run(250)
        assertEquals(PullMotion.Phase.Closing, m.phase)
        // The sky shuts first; the bus drives on home at its own pace, the scene still on the horizon.
        var frames = 0
        while (m.pull > 0f && frames++ < 120) m.step(1 / 60f)
        assertEquals(0f, m.pull, 0f)
        assertTrue(m.open)
        assertEquals(PullMotion.Drive.Return, m.drive)
        assertTrue(kotlin.math.abs(m.busX - road.home!!) > 1f)
        assertEquals(0, m.colour)
        assertFalse(m.good)
        m.run(2_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.pull, 0.001f)
        // Back where the card has it.
        assertEquals(road.home!!, m.busX, 0.5f)
    }

    @Test fun theBusComesBackToWhereTheNewAnswerPutsIt() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.done(PullOutcome.Updated)
        m.scene = road.copy(home = Pull.roadBus(sign, 0.1f))
        m.run(3_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(Pull.roadBus(sign, 0.1f), m.busX, 0.5f)
    }

    @Test fun aSlowAnswerIsSaidAsSoonAsItsIn() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(3_000)
        m.done(PullOutcome.Failed)
        m.step(1 / 60f)
        assertEquals(PullMotion.Phase.Shown, m.phase)
        assertEquals(PullHint.Failed, m.hint)
        // Not green: it didn't update.
        assertFalse(m.good)
    }

    @Test fun lettingGoShortAsksNothing() {
        val m = motion()
        m.drag(40f)
        assertFalse(m.armed)
        assertFalse(m.release())
        assertEquals(PullMotion.Phase.Cancel, m.phase)
        m.run(1_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.pull, 0.001f)
        assertNull(m.result)
        assertNull(m.hint)
        assertEquals(road.home!!, m.busX, 0.5f)
    }

    @Test fun upwardTheFingerTakesTheSkyBackFirst() {
        val m = motion()
        m.drag(50f)
        assertEquals(-50f, m.takeBack(-80f), 0.001f)
        assertEquals(0f, m.pull, 0.001f)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.takeBack(-10f), 0.001f)
    }

    @Test fun onTheHillsASignGrowsAndABusDrivesInFromTheLeft() {
        val m = motion(hill)
        m.drag(1f)
        m.step(1 / 60f)
        assertTrue(m.busX < 0f)
        assertEquals(0f, m.signGrow, 0.001f)
        m.drag(400f)
        m.step(1 / 60f)
        assertEquals(1f, m.signGrow, 0.001f)
        assertEquals(hill.stop, m.busX, 0.5f)
    }

    @Test fun withoutAnimationsNothingDrivesAndTheSkyEasesBack() {
        // Now: the card's bus stays in its place; only the sign lights.
        val m = motion(calm = true)
        m.drag(400f)
        m.step(1 / 60f)
        assertEquals(road.home!!, m.busX, 0.001f)
        assertEquals(1f, m.alpha, 0.001f)
        assertTrue(m.lit)
        m.release()
        m.done(PullOutcome.UpToDate)
        var lowest = Float.MAX_VALUE
        repeat(30) {
            m.step(1 / 60f)
            assertEquals(road.home!!, m.busX, 0.001f)
            assertEquals(0f, m.bob, 0.001f)
            lowest = minOf(lowest, m.pull)
        }
        // Eased down to the hold, never below it.
        assertTrue(lowest >= Pull.HOLD - 0.01f)
        m.run(3_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertTrue(m.puffs.isEmpty())

        // Buses: one stands at the stop, faded in as the sky opens.
        val h = motion(hill, calm = true)
        h.drag(5f)
        h.step(1 / 60f)
        assertEquals(0f, h.alpha, 0.001f)
        h.drag(400f)
        h.step(1 / 60f)
        assertEquals(hill.stop, h.busX, 0.001f)
        assertEquals(1f, h.alpha, 0.001f)
    }
}
