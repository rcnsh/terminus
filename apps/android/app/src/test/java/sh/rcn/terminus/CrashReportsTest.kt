package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashReportsTest {
    private fun deep(depth: Int): Nothing = if (depth == 0) throw IllegalStateException("bottom") else deep(depth - 1)

    private fun thrown(depth: Int): Throwable = try {
        deep(depth)
    } catch (e: Throwable) {
        e
    }

    @Test
    fun theBodyIsWhatTheServerTakesAndNothingAboutWho() {
        val body = CrashReports.body(IllegalStateException("broke"), "3.1.0", "8.1.0", fatal = true)
        assertEquals(setOf("platform", "version", "os", "type", "message", "stack", "fatal"), body.keys().asSequence().toSet())
        assertEquals("android", body.getString("platform"))
        assertEquals("3.1.0", body.getString("version"))
        assertEquals("Android 8", body.getString("os"))
        assertEquals("java.lang.IllegalStateException", body.getString("type"))
        assertEquals("broke", body.getString("message"))
        assertTrue(body.getBoolean("fatal"))
        assertEquals("Android 15", CrashReports.body(RuntimeException(), "3.1.0", "15", fatal = false).getString("os"))
    }

    @Test
    fun aLongMessageIsCutAndNoMessageIsEmpty() {
        assertEquals(CrashReports.MAX_MESSAGE, CrashReports.body(RuntimeException("x".repeat(5_000)), "1", "15", true).getString("message").length)
        assertEquals("", CrashReports.body(RuntimeException(), "1", "15", true).getString("message"))
    }

    @Test
    fun theStackKeepsItsCausesWithinTheLimit() {
        val e = RuntimeException("top", IllegalArgumentException("middle", thrown(80)))
        val lines = CrashReports.stack(e).lines()
        assertTrue(lines.size <= CrashReports.MAX_LINES)
        assertTrue(lines[0].startsWith("java.lang.RuntimeException: top"))
        assertTrue(lines.any { it == "Caused by: java.lang.IllegalArgumentException: middle" })
        // The root cause isn't crowded out by the long trace above it.
        assertTrue(lines.any { it == "Caused by: java.lang.IllegalStateException: bottom" })
        assertTrue(lines.any { it.startsWith("\t... ") && it.endsWith(" more") })
    }

    @Test
    fun aCauseLoopEnds() {
        val a = RuntimeException("a")
        val b = RuntimeException("b", a)
        a.initCause(b)
        assertTrue(CrashReports.stack(a).lines().size <= CrashReports.MAX_LINES)
    }

    @Test
    fun theOldestReportsGoBeyondFive() {
        val names = listOf("1700000000005-1.json", "1700000000001-9.json", "1700000000003-2.json", "1700000000002-4.json", "1700000000006-1.json", "1700000000004-0.json", "1700000000000-3.json")
        assertEquals(listOf("1700000000000-3.json", "1700000000001-9.json"), CrashReports.overCap(names))
        assertEquals(emptyList<String>(), CrashReports.overCap(names.take(5)))
    }

    @Test
    fun sentOrRefusedIsDeletedAServerErrorIsKept() {
        assertTrue(CrashReports.done(204))
        assertTrue(CrashReports.done(400))
        assertTrue(CrashReports.done(429))
        assertFalse(CrashReports.done(503))
    }
}
