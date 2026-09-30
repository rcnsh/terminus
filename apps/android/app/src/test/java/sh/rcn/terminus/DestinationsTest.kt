package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The widget's usual places (phase 8.3): saved places, and stops asked for, by recent use. */
class DestinationsTest {
    private val now = 1_790_000_000_000L
    private val day = 86_400_000L
    private val places = listOf(Place("krmrt", "KR MRT"), Place("utown", "UTown"), Place("deck", "The Deck"))

    @Test fun savedPlacesInTheirOrderWhenNothingIsUsedYet() {
        assertEquals(listOf("place:krmrt", "place:utown", "place:deck"), Destinations.rank(places, emptyMap(), now).map { it.id })
    }

    @Test fun theMostUsedComeFirstAndAStopNeedsTwoUses() {
        var used = emptyMap<String, Destinations.Use>()
        repeat(3) { used = Destinations.note(used, Destinations.Dest("place:deck", "The Deck"), now) }
        used = Destinations.note(used, Destinations.Dest("stop:COM3", "COM 3"), now)
        assertEquals(listOf("place:deck", "place:krmrt", "place:utown", "place:deck").distinct(), Destinations.rank(places, used, now).map { it.id })
        used = Destinations.note(used, Destinations.Dest("stop:COM3", "COM 3"), now)
        assertEquals(listOf("place:deck", "stop:COM3", "place:krmrt", "place:utown"), Destinations.rank(places, used, now).map { it.id })
    }

    @Test fun oldUseFadesSoThisMonthsRoutineWins() {
        var used = emptyMap<String, Destinations.Use>()
        repeat(4) { used = Destinations.note(used, Destinations.Dest("place:utown", "UTown"), now - 60 * day) }
        repeat(2) { used = Destinations.note(used, Destinations.Dest("place:deck", "The Deck"), now) }
        assertEquals("place:deck", Destinations.rank(places, used, now).first().id)
    }

    @Test fun aStopWithTheSameNameAsASavedPlaceShowsOnce() {
        var used = emptyMap<String, Destinations.Use>()
        repeat(2) { used = Destinations.note(used, Destinations.Dest("stop:UTOWN", "UTown"), now) }
        val ranked = Destinations.rank(places, used, now)
        assertEquals(1, ranked.count { it.label == "UTown" })
    }

    @Test fun keptAcrossRestarts() {
        val used = Destinations.note(emptyMap(), Destinations.Dest("stop:COM3", "COM 3"), now)
        assertEquals(used, Destinations.parse(Destinations.serialise(used)))
        assertTrue(Destinations.parse("not json").isEmpty())
    }

    @Test fun speedFromTwoFixes() {
        // About 111 m north in 20 s: a bus, not a walk.
        val v = TripWatch.speedBetween(1.2900, 103.7800, 0, 1.2910, 103.7800, 20_000)!!
        assertEquals(5.56, v, 0.05)
        assertEquals(null, TripWatch.speedBetween(1.29, 103.78, 0, 1.2901, 103.78, 1_000))
    }
}
