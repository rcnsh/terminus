package sh.rcn.terminus.widget

import java.io.File
import java.time.Instant
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.TestStrings
import sh.rcn.terminus.widget.BaseWidget.Tap

class WidgetFrameTest {
    init {
        TestStrings.install()
    }

    private val dir = listOf("../../../fixtures/answers", "../../fixtures/answers").map(::File).first { it.isDirectory }
    private val day = DayPlan.parse(JSONObject(File(dir, "day.json").readText()))
    private val plan = NextAnswer.parse(JSONObject(File(dir, "class-bus.json").readText()))
    private val staleAt = plan.card!!.staleAtMs!!
    private val morning = Instant.parse("2026-08-27T01:05:00Z").toEpochMilli()

    private fun frame(
        answer: NextAnswer? = plan,
        error: String? = "No connection",
        now: Long = staleAt,
        live: Boolean = false,
        mode: Mode = Mode.Timetable,
        paired: Boolean = true,
    ) = BaseWidget.frame(paired, mode, answer, error, live, now) { day }

    @Test
    fun offlineWithThePlanOldTheDayPlanTakesOver() {
        assertNotNull(frame(now = maxOf(staleAt, morning)).offline)
        assertNotNull(frame(answer = null, now = morning).offline)
    }

    @Test
    fun theAnswerStaysWhileItHolds() {
        assertNull(frame(now = staleAt - 1).offline)
        assertNull(frame(error = null).offline)
        assertNull(frame(error = UPDATING).offline)
        assertNull(frame(mode = Mode.Nearby).offline)
        assertNull(frame(paired = false).offline)
        assertNull(BaseWidget.frame(true, Mode.Timetable, plan, "No connection", false, staleAt) { null }.offline)
    }

    @Test
    fun theDayPlanIsReadOnlyWhenNeeded() {
        var read = false
        BaseWidget.frame(true, Mode.Timetable, plan, null, false, staleAt) {
            read = true
            day
        }
        assertEquals(false, read)
    }

    @Test
    fun theLiveNotificationKeepsThePlanSoNoRefreshButton() {
        assertEquals(false, frame(live = true).refreshButton)
        assertEquals(true, frame(live = false).refreshButton)
        assertEquals(true, frame(live = true, mode = Mode.Nearby).refreshButton)
        assertEquals(false, frame(paired = false).refreshButton)
    }

    @Test
    fun aTapOpensTheSameView() {
        assertEquals(Tap.Plan, frame().tap)
        assertEquals(Tap.Nearby, frame(mode = Mode.Nearby).tap)
        assertEquals(Tap.Place("mrt"), frame(mode = Mode.To(Destinations.Dest("place:mrt", "KR MRT"))).tap)
        assertEquals(Tap.Stop("COM3", "COM 3"), frame(mode = Mode.To(Destinations.Dest("stop:COM3", "COM 3"))).tap)
    }
}
