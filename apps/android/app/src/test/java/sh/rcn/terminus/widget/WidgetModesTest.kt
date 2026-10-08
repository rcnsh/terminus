package sh.rcn.terminus.widget

import sh.rcn.terminus.TestStrings
import org.json.JSONObject
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.mutablePreferencesOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.NextAnswer

/** What a widget shows (phase 8.3), and when it goes back to the timetable by itself. */
class WidgetModesTest {
    init { TestStrings.install() }

    private val now = 1_790_000_000_000L
    private val utown = Mode.To(Destinations.Dest("place:utown", "UTown"))

    @Test fun asManyButtonsAsFitAndNoneIfTimetableAndNearbyDont() {
        val labels = listOf("Timetable", "Nearby", "KR MRT", "The Deck", "UTown")
        assertEquals(5, WidgetModes.fitting(labels, 420f))
        assertEquals(4, WidgetModes.fitting(labels, 400f))
        assertEquals(3, WidgetModes.fitting(labels, 250f))
        assertEquals(1, WidgetModes.fitting(labels, 120f))
    }

    @Test fun modesSurviveBeingStored() {
        assertEquals(Mode.Timetable, Mode.of(null, null))
        assertEquals(Mode.Nearby, Mode.of("nearby", "Nearby"))
        assertEquals(utown, Mode.of("place:utown", "UTown"))
        assertEquals(sh.rcn.terminus.Target.Code("COM3", "COM 3"), (Mode.of("stop:COM3", "COM 3") as Mode.To).target)
        assertEquals(Mode.Timetable, Mode.of("place:utown", null))
    }

    @Test fun aChosenPlaceStandsForHalfAnHourThenTheTimetable() {
        assertEquals(utown, WidgetModes.effective(utown, now - 10 * 60_000, null, rowShown = true, now = now))
        assertEquals(Mode.Timetable, WidgetModes.effective(utown, now - 31 * 60_000, null, rowShown = true, now = now))
    }

    @Test fun tooSmallForTheButtonsMeansTheTimetable() {
        assertEquals(Mode.Timetable, WidgetModes.effective(Mode.Nearby, now - 60_000, null, rowShown = false, now = now))
    }

    @Test fun aTripThatBecomesDueTakesTheWidgetBack() {
        val leaveAt = now + 3 * 60_000
        val plan = NextAnswer.parse(JSONObject(answer(leaveAt, "due")))
        // Chosen before the trip was due: the trip wins.
        assertEquals(Mode.Timetable, WidgetModes.effective(utown, now - 10 * 60_000, plan, rowShown = true, now = now))
        // Chosen during it: the choice stands.
        assertEquals(utown, WidgetModes.effective(utown, now - 30_000, plan, rowShown = true, now = now))
    }

    private fun answer(leaveAt: Long, phase: String) = """{
        "label":"D2 · 9:41","detail":"","quality":"live","asOf":"${java.time.Instant.ofEpochMilli(now)}",
        "arrivals":[],"stop":{"code":"PGP","name":"PGP","confidence":1},"places":[],
        "leave":{"at":"${java.time.Instant.ofEpochMilli(leaveAt)}","svc":"D2","stop":"PGP"},
        "card":{"kind":"trip","phase":"$phase","actions":[],"remindAt":"${java.time.Instant.ofEpochMilli(leaveAt - 5 * 60_000)}"}
    }"""

    @Test fun theNewestAddedPlaceKeepsTheLastButton() {
        val fav = listOf("KR MRT", "UTown", "The Deck").map { Mode.To(Destinations.Dest("place:$it", it)) }
        val com3 = Mode.To(Destinations.Dest("stop:COM3", "COM 3"))
        val all = listOf(Mode.Timetable, Mode.Nearby) + fav + com3
        // Room for four: Timetable, Nearby, the top favourite, then COM 3.
        assertEquals(listOf("Timetable", "Nearby", "KR MRT", "COM 3"), WidgetModes.pick(all, com3, 330f).map { it.label })
        // Room for all: nothing moves.
        assertEquals(all, WidgetModes.pick(all, com3, 600f))
        // Nothing added: as before.
        assertEquals(listOf("Timetable", "Nearby", "KR MRT", "UTown"), WidgetModes.pick(all.dropLast(1), null, 330f).map { it.label })
        // However wide, no more than a Glance Row can hold.
        val many = listOf(Mode.Timetable, Mode.Nearby) + (1..10).map { Mode.To(Destinations.Dest("stop:S$it", "S$it")) }
        assertEquals(WidgetModes.MAX_BUTTONS, WidgetModes.pick(many, null, 2000f).size)
        // Only Timetable and Nearby fit: they stay.
        assertEquals(listOf("Timetable", "Nearby"), WidgetModes.pick(all, com3, 175f).map { it.label })
    }

    @Test fun aChosenWidgetIsRedrawnAsItsTimesAgeAndItsChoiceRunsOut() {
        sh.rcn.terminus.ServerClock.reset()
        // Nearby: when its times turn old, three minutes after they came.
        assertEquals(now + WidgetModes.NEARBY_OLD_MS, WidgetModes.redrawAt(Mode.Nearby, now, now, null, now))
        // A place: its leave-by turning into "Leave now", before the half hour is up.
        val leaveAt = now + 10 * 60_000
        val place = NextAnswer.parse(JSONObject(answer(leaveAt, "idle")))
        assertEquals(leaveAt, WidgetModes.redrawAt(utown, now, now, place, now))
        // Past it, the choice running out; then nothing.
        assertEquals(now + WidgetModes.KEEP_MS, WidgetModes.redrawAt(utown, now, now, place, leaveAt))
        assertEquals(null, WidgetModes.redrawAt(utown, now, now, place, now + WidgetModes.KEEP_MS))
    }

    /**
     * Signing out leaves no widget holding the old account's place or
     * answer. Every key the modes and the nearby swap declare is filled,
     * so a key added later and left out of forget() fails here.
     */
    @Test fun forgetLeavesNothingOfTheOldAccount() {
        val keys = listOf(WidgetModes, NearbySwap).flatMap { o ->
            o.javaClass.declaredFields.filter { Preferences.Key::class.java.isAssignableFrom(it.type) }.map { f ->
                f.isAccessible = true
                f.get(o) as Preferences.Key<*>
            }
        }
        assertTrue("found the keys: $keys", keys.size >= 9)
        val prefs = mutablePreferencesOf()
        @Suppress("UNCHECKED_CAST")
        for (k in keys) {
            if (k.name.endsWith("-at") || k.name.endsWith("-fetched")) prefs[k as Preferences.Key<Long>] = now
            else prefs[k as Preferences.Key<String>] = "place:utown"
        }
        assertEquals(keys.size, prefs.asMap().size)
        WidgetModes.forget(prefs)
        assertEquals(emptyMap<Preferences.Key<*>, Any>(), prefs.asMap())
        assertEquals(Mode.Timetable, Mode.of(prefs[WidgetModes.MODE], prefs[WidgetModes.MODE_LABEL]))
    }
}
