package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Chinese (phase 10): every string has a translation, with the same blanks to fill, and none is left in the code. */
class StringsTest {
    private val en = TestStrings.read("values")
    private val zh = TestStrings.read("values-zh")

    @Test fun everyStringIsTranslated() {
        assertEquals(en.keys.sorted(), zh.keys.sorted())
    }

    @Test fun translationsHaveTheSameBlanks() {
        val blank = Regex("""%\d\$[sd]""")
        for ((k, v) in en) {
            assertEquals(k, blank.findAll(v).map { it.value }.toSet(), blank.findAll(zh.getValue(k)).map { it.value }.toSet())
        }
    }

    @Test fun theChineseIsChinese() {
        // Chinese characters, or at least Chinese punctuation ("%1$s：%2$s").
        for ((k, v) in zh) assertTrue("$k: $v", v.any { it in '\u4e00'..'\u9fff' || it in '\u3000'..'\u303f' || it in '\uff00'..'\uffef' })
    }

    /** A Text("Some words") in the code would be English in Chinese too. */
    @Test fun noTextIsWrittenInTheCode() {
        val allowed = setOf("terminus", "English", "中文")
        val text = Regex("""\bText\("([^"$]*[A-Za-z][^"]*)"""")
        val found = File("src/main/java").walk().filter { it.extension == "kt" }.flatMap { f ->
            text.findAll(f.readText()).map { it.groupValues[1] }.filter { it !in allowed && !it.startsWith("http") }.map { "${f.name}: $it" }
        }.toList()
        assertEquals(emptyList<String>(), found)
    }

    @Test fun theRideSaysWhereYouAreInChinese() {
        TestStrings.install("values-zh")
        try {
            val ride = Ride("D2", listOf("PGP", "KR MRT", "LT27", "UTown"), 0, 9 * 60_000)
            assertEquals("下一站：KR MRT · 还有 3 站", ride.nextText(0))
            assertEquals("上午 9:05", hhmm12(545))
            assertEquals("周一", dayShort(1))
        } finally {
            TestStrings.install()
        }
    }
}
