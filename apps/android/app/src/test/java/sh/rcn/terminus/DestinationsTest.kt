package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The widget's places (phase 8.3): favourites by recent use, then the places added from "Go somewhere else". */
class DestinationsTest {
    init { TestStrings.install() }

    private val now = 1_790_000_000_000L
    private val day = 86_400_000L
    private val places = listOf(Place("krmrt", "KR MRT"), Place("utown", "UTown"), Place("deck", "The Deck"))

    private val com3 = Destinations.Dest("stop:COM3", "COM 3")
    private val ea = Destinations.Dest("stop:EA", "EA")

    @Test fun favouritesInTheirOrderWhenNothingIsUsedYet() {
        assertEquals(listOf("place:krmrt", "place:utown", "place:deck"), Destinations.rank(places, emptyList(), emptyMap(), now).map { it.id })
    }

    @Test fun theMostUsedFavouritesFirstThenAddedPlaces() {
        var used = emptyMap<String, Destinations.Use>()
        repeat(3) { used = Destinations.note(used, Destinations.Dest("place:deck", "The Deck"), now) }
        // However often a stop is asked for, it's a button only once added.
        repeat(5) { used = Destinations.note(used, com3, now) }
        assertEquals(listOf("place:deck", "place:krmrt", "place:utown"), Destinations.rank(places, emptyList(), used, now).map { it.id })
        assertEquals(listOf("place:deck", "place:krmrt", "place:utown", "stop:EA", "stop:COM3"), Destinations.rank(places, listOf(ea, com3), used, now).map { it.id })
    }

    @Test fun oldUseFadesSoThisMonthsRoutineWins() {
        var used = emptyMap<String, Destinations.Use>()
        repeat(4) { used = Destinations.note(used, Destinations.Dest("place:utown", "UTown"), now - 60 * day) }
        repeat(2) { used = Destinations.note(used, Destinations.Dest("place:deck", "The Deck"), now) }
        assertEquals("place:deck", Destinations.rank(places, emptyList(), used, now).first().id)
    }

    @Test fun addedNewestFirstAtMostFiveAndNeverAFavourite() {
        var added = emptyList<Destinations.Dest>()
        for (c in listOf("A", "B", "C", "D", "E", "F")) added = Destinations.add(added, Destinations.Dest("stop:$c", c), places)
        assertEquals(listOf("F", "E", "D", "C", "B"), added.map { it.label })
        // Already there: it stays where it is, so the tabs don't jump.
        assertEquals(added, Destinations.add(added, Destinations.Dest("stop:D", "D"), places))
        assertEquals(added, Destinations.add(added, Destinations.Dest("stop:UTOWN", "UTown"), places))
        assertEquals(added, Destinations.parseAdded(Destinations.serialiseAdded(added)))
        assertTrue(Destinations.parseAdded("not json").isEmpty())
    }

    @Test fun aPlaceWithTheSameNameAsAFavouriteShowsOnce() {
        val ranked = Destinations.rank(places, listOf(Destinations.Dest("stop:UTOWN", "UTown")), emptyMap(), now)
        assertEquals(1, ranked.count { it.label == "UTown" })
    }

    @Test fun keptAcrossRestarts() {
        val used = Destinations.note(emptyMap(), Destinations.Dest("stop:COM3", "COM 3"), now)
        assertEquals(used, Destinations.parse(Destinations.serialise(used)))
        assertTrue(Destinations.parse("not json").isEmpty())
    }
}
