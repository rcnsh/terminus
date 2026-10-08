package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pull to refresh: the page's travel, when letting go asks, what it says, and the bus. */
class PullTest {
    private val top = 24f
    private val scene = PullScene(393f)

    private fun motion(calm: Boolean = false) = PullMotion(scene, top, others = 6, calm = calm)

    /** Steps [ms] of frames at 60 a second. */
    private fun PullMotion.run(ms: Int) = repeat(ms * 60 / 1000) { step(1 / 60f) }

    @Test fun thePageFollowsLessTheFurtherItGoes() {
        assertEquals(0f, Pull.rubber(0f, Pull.MAX), 0.001f)
        val a = Pull.rubber(50f, Pull.MAX)
        val b = Pull.rubber(100f, Pull.MAX) - a
        assertTrue(a in 40f..50f)
        assertTrue(b < a)
        assertTrue(Pull.rubber(10_000f, Pull.MAX) <= Pull.MAX)
        for (raw in listOf(0f, 30f, 120f, 400f)) assertEquals(raw, Pull.unrubber(Pull.rubber(raw, Pull.MAX), Pull.MAX), 0.5f)
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

    @Test fun theChipSaysWhatHappened() {
        assertEquals(PullOutcome.UpToDate, Pull.outcome(fetched = false, ok = false))
        assertEquals(PullOutcome.Updated, Pull.outcome(fetched = true, ok = true))
        assertEquals(PullOutcome.Failed, Pull.outcome(fetched = true, ok = false))
        assertEquals(600L, Pull.minShowMs(PullOutcome.UpToDate))
        assertEquals(700L, Pull.minShowMs(PullOutcome.Updated))
    }

    @Test fun theBusRollsInToTheStopAsThePageComesDown() {
        assertEquals(scene.start, Pull.busX(0f, scene.start, scene.stop), 0.001f)
        assertEquals(scene.stop, Pull.busX(1f, scene.start, scene.stop), 0.001f)
        assertEquals(scene.stop, Pull.busX(2f, scene.start, scene.stop), 0.001f)
        // Eased: past halfway at half the pull.
        assertTrue(Pull.busX(0.5f, scene.start, scene.stop) > (scene.start + scene.stop) / 2)
        assertTrue(scene.stop < scene.sign)
        assertEquals(0f, Pull.progress(top, top), 0.001f)
        assertEquals(1f, Pull.progress(top + Pull.THRESHOLD, top), 0.001f)
    }

    @Test fun theOtherBusesGoRoundInTurnNeverInTheFirstsColour() {
        assertEquals(listOf(1, 2, 3, 1, 2), generateSequence(0) { Pull.nextColour(it, 3) }.drop(1).take(5).toList())
        assertEquals(0, Pull.nextColour(0, 0))
    }

    @Test fun pastTheStopItArmsOnceAndLettingGoAsks() {
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
        assertEquals(top + Pull.HOLD, m.pull, 1f)
        assertNull(m.result)
    }

    @Test fun theBusBoardsThenDrivesOffAndOthersGoRound() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(300)
        assertEquals(PullMotion.Drive.Boarding, m.drive)
        assertEquals(scene.stop, m.busX, 0.001f)
        m.run(500)
        assertEquals(PullMotion.Drive.Departing, m.drive)
        assertTrue(m.busX > scene.stop)
        assertTrue(m.puffs.isNotEmpty())
        m.run(1_500)
        assertEquals(PullMotion.Drive.Looping, m.drive)
        assertTrue(m.colour > 0)
    }

    @Test fun itClosesSoonAfterTheAnswerButNotBeforeItsBeenSeen() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(100)
        m.done(PullOutcome.Updated)
        m.run(400)
        assertEquals(PullMotion.Phase.Busy, m.phase)
        m.run(300)
        assertEquals(PullMotion.Phase.Closing, m.phase)
        assertEquals(PullOutcome.Updated, m.result)
        m.run(1_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.pull, 0.001f)
    }

    @Test fun aSlowAnswerClosesAsSoonAsItsIn() {
        val m = motion()
        m.drag(400f)
        m.release()
        m.run(3_000)
        m.done(PullOutcome.Failed)
        m.step(1 / 60f)
        // Not waiting for a bus to come round to the stop.
        assertEquals(PullMotion.Phase.Closing, m.phase)
        assertEquals(PullOutcome.Failed, m.result)
    }

    @Test fun lettingGoShortOfTheStopAsksNothing() {
        val m = motion()
        m.drag(top + 40f)
        assertFalse(m.armed)
        assertFalse(m.release())
        assertEquals(PullMotion.Phase.Cancel, m.phase)
        m.run(1_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.pull, 0.001f)
        assertNull(m.result)
    }

    @Test fun upwardTheFingerTakesThePageBackFirst() {
        val m = motion()
        m.drag(50f)
        assertEquals(-50f, m.takeBack(-80f), 0.001f)
        assertEquals(0f, m.pull, 0.001f)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertEquals(0f, m.takeBack(-10f), 0.001f)
    }

    @Test fun withoutAnimationsTheBusWaitsAtTheStopAndNothingBounces() {
        val m = motion(calm = true)
        m.drag(top + 10f)
        m.step(1 / 60f)
        assertEquals(0f, m.alpha, 0.001f)
        m.drag(400f)
        m.step(1 / 60f)
        assertEquals(scene.stop, m.busX, 0.001f)
        assertEquals(1f, m.alpha, 0.001f)
        assertTrue(m.lit)
        m.release()
        m.done(PullOutcome.UpToDate)
        var lowest = Float.MAX_VALUE
        repeat(30) {
            m.step(1 / 60f)
            assertEquals(scene.stop, m.busX, 0.001f)
            assertEquals(0f, m.bob, 0.001f)
            lowest = minOf(lowest, m.pull)
        }
        // Eased down to the hold, never below it.
        assertTrue(lowest >= top + Pull.HOLD - 0.01f)
        assertTrue(m.lit)
        m.run(2_000)
        assertEquals(PullMotion.Phase.Idle, m.phase)
        assertTrue(m.puffs.isEmpty())
    }
}
