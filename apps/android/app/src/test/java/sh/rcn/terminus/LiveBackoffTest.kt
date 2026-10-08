package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/** The live notification asks less often while refreshes fail, and as usual once one works. */
class LiveBackoffTest {
    @Test fun nothingExtraAfterASuccess() {
        assertEquals(0L, liveBackoffMs(0))
    }

    @Test fun doublesToEightMinutes() {
        assertEquals(listOf(1, 2, 4, 8, 8, 8), (1..6).map { (liveBackoffMs(it) / 60_000).toInt() })
        assertEquals(8 * 60_000L, liveBackoffMs(1_000))
    }
}

/** A push address belongs to the session it was sent with. */
class PushTagTest {
    @Test fun sameSessionSameTag() {
        assertEquals(Push.tag("abc"), Push.tag("abc"))
        assertEquals(16, Push.tag("abc").length)
    }

    @Test fun anotherSessionAnotherTag() {
        assertNotEquals(Push.tag("abc"), Push.tag("abd"))
    }
}
