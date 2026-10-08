package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.LeaveAlerts.State
import sh.rcn.terminus.LeaveAlerts.Step
import java.time.Instant

/** When the leave reminder posts, waits or goes: [LeaveAlerts.decide]. */
class LeaveAlertsTest {
    init { TestStrings.install() }

    private val now = 1_790_000_000_000L
    private val classAt = now + 40 * 60_000
    private fun iso(ms: Long) = Instant.ofEpochMilli(ms).toString()

    /** A class plan leaving at [leaveAt], its reminder five minutes before, as the server words it. */
    private fun plan(
        leaveAt: Long,
        remindAt: Long? = leaveAt - 5 * 60_000,
        remind: Boolean = true,
        phase: String = "idle",
        nextChangeAt: Long? = null,
        leaveBy: String? = "Leave by 09:38",
    ) = NextAnswer.parse(
        JSONObject(
            """{"label":"R2 · 9:42","detail":"","quality":"live","mode":"trip",
            "leave":{"at":"${iso(leaveAt)}","svc":"R2","stop":"PGP"},
            "timing":{"classAt":"${iso(classAt)}"},
            "card":{"kind":"class","phase":"$phase","actions":[],"remind":$remind,
              "leaveBy":${leaveBy?.let { "\"$it\"" } ?: "null"},
              "remindAt":${remindAt?.let { "\"${iso(it)}\"" } ?: "null"},
              "nextChangeAt":${nextChangeAt?.let { "\"${iso(it)}\"" } ?: "null"}}}""",
        ),
    )

    private val fresh = State(alertsOn = true, notifiedFor = 0L)

    /** Runs [decide] the way arm() does, noting the trip after a heads-up. */
    private fun run(answer: NextAnswer, state: State, at: Long, showing: Boolean = true): Pair<Step, State> {
        val step = LeaveAlerts.decide(answer, state, showing, pushActive = false, now = at)
        return step to if (step is Step.HeadsUp) state.copy(notifiedFor = step.trip) else state
    }

    @Test fun theSameClassTwiceIsOneHeadsUp() {
        val a = plan(leaveAt = now + 4 * 60_000)
        val (first, after) = run(a, fresh, now)
        assertEquals(Step.HeadsUp(classAt, now + 4 * 60_000), first)
        val (second, _) = run(a, after, now + 30_000)
        assertTrue("$second", second is Step.Follow)
    }

    @Test fun aLeaveTimeThatMovesIsNotASecondHeadsUp() {
        val (first, after) = run(plan(leaveAt = now + 4 * 60_000), fresh, now)
        assertTrue(first is Step.HeadsUp)
        // The buses moved: leave later, a new remindAt, the same class.
        val (second, _) = run(plan(leaveAt = now + 9 * 60_000), after, now + 60_000)
        assertEquals(Step.Follow(post = true, checkAt = null), second)
        // Dismissed: not posted again.
        val (third, _) = run(plan(leaveAt = now + 9 * 60_000), after, now + 60_000, showing = false)
        assertEquals(Step.Follow(post = false, checkAt = null), third)
    }

    @Test fun nothingOnceTheClassHasStarted() {
        assertEquals(Step.StopChecking, run(plan(leaveAt = now - 10 * 60_000), fresh, classAt).first)
        assertEquals(Step.StopChecking, run(plan(leaveAt = now - 10 * 60_000), fresh, classAt + 1).first)
    }

    @Test fun remindersOffForTheTripCancelEverything() {
        assertEquals(Step.Cancel, run(plan(leaveAt = now + 4 * 60_000, remindAt = null, remind = false), fresh, now).first)
        assertEquals(Step.Cancel, run(plan(leaveAt = now + 4 * 60_000, remind = false), State(true, classAt), now).first)
    }

    @Test fun alertsOffStopTheCheck() {
        assertEquals(Step.StopChecking, run(plan(leaveAt = now + 4 * 60_000), State(alertsOn = false, notifiedFor = 0L), now).first)
    }

    @Test fun aReminderAheadFetchesFreshTimesTwoMinutesBefore() {
        val remindAt = now + 3 * 60_000
        assertEquals(Step.CheckAt(remindAt - 2 * 60_000), run(plan(leaveAt = remindAt + 5 * 60_000), fresh, now).first)
        // Within the two minutes: post now.
        assertTrue(run(plan(leaveAt = now + 6 * 60_000), fresh, now).first is Step.HeadsUp)
    }

    @Test fun withExactAlarmsTheHeadsUpWaitsForRemindAt() {
        val exact = fresh.copy(exact = true)
        val a = plan(leaveAt = now + 6 * 60_000)
        // Fresh times in hand a minute early: posted at remindAt, so "5 minutes before" is true.
        assertEquals(Step.PostAt(now + 60_000), run(a, exact, now).first)
        assertEquals(Step.HeadsUp(classAt, now + 6 * 60_000), run(a, exact, now + 60_000).first)
    }

    @Test fun nothingToSayIsTriedAgainThenGivenUp() {
        // No leave time to word yet (no bus to catch): not marked as shown.
        val quiet = plan(leaveAt = now + 4 * 60_000, leaveBy = null, nextChangeAt = now + 30_000)
        assertEquals(Step.CheckAt(now + 2 * 60_000), run(quiet, fresh, now).first)
        assertEquals(Step.CheckAt(now + 5 * 60_000 + 2_000), run(plan(leaveAt = now + 4 * 60_000, leaveBy = null, nextChangeAt = now + 5 * 60_000), fresh, now).first)
        assertEquals(Step.StopChecking, run(plan(leaveAt = now + 4 * 60_000, leaveBy = null), fresh, now).first)
        // Well past the reminder: counted as done, as a shown heads-up would be.
        val unsaid = plan(leaveAt = now + 30 * 60_000, remindAt = now - 60_000, leaveBy = null)
        assertEquals(Step.GiveUp(classAt), run(unsaid, fresh, now + 11 * 60_000).first)
    }

    @Test fun aLeaveTimeAlreadyPastHasNoLeaveNowAlarm() {
        assertEquals(Step.HeadsUp(classAt, null), run(plan(leaveAt = now - 1), fresh, now).first)
    }

    @Test fun afterTheHeadsUpTheNextChangeIsCheckedWithoutPush() {
        val change = now + 5 * 60_000
        val a = plan(leaveAt = now + 4 * 60_000, nextChangeAt = change)
        val noted = State(true, classAt)
        assertEquals(Step.Follow(true, change + 2_000), LeaveAlerts.decide(a, noted, showing = true, pushActive = false, now = now))
        // With push, the server says when.
        assertEquals(Step.Follow(true, null), LeaveAlerts.decide(a, noted, showing = true, pushActive = true, now = now))
    }

    @Test fun arrivedEndsAFollowedTripOnly() {
        val a = plan(leaveAt = now - 60_000, remindAt = null, phase = "arrived")
        assertEquals(Step.Cancel, run(a, State(true, classAt), now, showing = true).first)
        assertEquals(Step.Keep, run(a, fresh, now).first)
    }
}
