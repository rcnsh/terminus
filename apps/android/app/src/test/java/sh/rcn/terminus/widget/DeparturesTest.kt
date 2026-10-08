package sh.rcn.terminus.widget

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.rcn.terminus.BoardRow
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.TestStrings

/** Nearby on the widget: the server's words while fresh, then its own countdown. */
class DeparturesTest {
    init { TestStrings.install() }

    private val stop = NearbyStop(
        "PGP", "PGP", 200, true,
        listOf(
            BoardRow("D2", 200, "live", eta = "3 min"),
            BoardRow("A1", 500, "scheduled", eta = "~8 min"),
            BoardRow("E", null, "ended"),
        ),
    )

    @Test fun freshIsTheServersWords() {
        assertEquals("D2 3 min · A1 ~8 min", BaseWidget.departures(stop, 10, 3))
    }

    @Test fun olderIsCountedDownOnThePhone() {
        // 200 s less 40: 2 min 40 s, rounded.
        assertEquals("D2 3 min · A1 ~8 min", BaseWidget.departures(stop, 40, 3))
        assertEquals("D2 2 min · A1 ~7 min", BaseWidget.departures(stop, 90, 3))
    }

    @Test fun aClockMovedBackKeepsTheServersWords() {
        assertEquals("D2 3 min · A1 ~8 min", BaseWidget.departures(stop, -5, 3))
    }

    @Test fun aBusThatShouldHaveComeIsNow() {
        assertEquals("D2 now · A1 ~3 min", BaseWidget.departures(stop, 300, 3))
    }

    @Test fun onlyBusesWithATimeAndAsManyAsAsked() {
        assertEquals("D2 3 min", BaseWidget.departures(stop, 0, 1))
        assertEquals("A1 ~8 min", BaseWidget.departures(stop, 0, 3, skip = 1))
    }
}
