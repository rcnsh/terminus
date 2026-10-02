package sh.rcn.terminus

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * The offline fallback, against the cases the web and Mac apps are checked
 * against too (apps/api/test/fixtures/offline-day.json), on the API's own
 * /me/day golden.
 */
class OfflineDayTest {
    init { TestStrings.install() }

    private val dir = listOf("../../api/test/fixtures", "../api/test/fixtures").map(::File).first { it.isDirectory }
    private val spec = JSONObject(File(dir, "offline-day.json").readText())
    private val day = DayPlan.parse(JSONObject(File(dir, spec.getString("day")).readText()))

    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    @Test fun theDayPlanGivesTheNextThingAtEachMoment() {
        assertEquals("2026-08-27", day.date)
        val cases = spec.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val at = c.getString("at")
            val got = OfflineDay.next(day, ms(at))
            if (c.isNull("key")) {
                assertNull(at, got)
                continue
            }
            assertEquals(at, c.getString("key"), got?.item?.key)
            val step = when (c.getString("step")) {
                "leaveBy" -> OfflineDay.Step.LeaveBy
                "leaveNow" -> OfflineDay.Step.LeaveNow
                else -> OfflineDay.Step.Home
            }
            assertEquals(at, step, got?.step)
        }
    }

    @Test fun theWidgetIsRedrawnWhenTheLineMovesOn() {
        // 09:00: the first class's leave-by (09:36:40) is the next change.
        assertEquals(ms("2026-08-27T01:36:40Z"), OfflineDay.nextChangeAt(day, ms("2026-08-27T01:00:00Z")))
        // After the last trip home has ended: nothing more.
        assertNull(OfflineDay.nextChangeAt(day, ms("2026-08-27T08:10:00Z")))
    }

    @Test fun linesAreWordedLikeTheTodayList() {
        val first = OfflineDay.next(day, ms("2026-08-27T01:00:00Z"))!!
        val lines = OfflineDay.lines(first) { "09:36" }
        assertEquals("GEA1000 @ UTown", lines.head)
        assertEquals("Leave by ~09:36", lines.big)
        assertEquals("R2 from PGP", lines.how)
        val home = OfflineDay.lines(OfflineDay.next(day, ms("2026-08-27T07:30:00Z"))!!) { it.toString() }
        assertEquals("Home, from COM 3", home.big)
    }
}
