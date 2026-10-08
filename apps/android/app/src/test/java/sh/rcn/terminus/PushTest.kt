package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The new semester's reminder, and when push is trusted. */
class PushTest {
    @Test fun noTitleInTheAppsLanguageIsNoNotification() {
        assertNull(TermReminder.words(mapOf("title" to "T"), zh = true))
        assertNull(TermReminder.words(mapOf("title" to "T", "body" to "B", "zhTitle" to "", "zhBody" to ""), zh = true))
        assertNull(TermReminder.words(mapOf("zhTitle" to "标题"), zh = false))
    }

    @Test fun anOlderServersWordsAreUsedAsTheyAre() {
        // Sent in the push itself, before 2.5.0.
        val push = mapOf("kind" to "term", "title" to "Sem 1 starts Mon 10 Aug", "body" to "Import your new timetable.", "zhTitle" to "第 1 学期 8月10日开始", "zhBody" to "导入新课表。")
        assertEquals("Sem 1 starts Mon 10 Aug" to "Import your new timetable.", TermReminder.words(push, zh = false))
        assertEquals("第 1 学期 8月10日开始" to "导入新课表。", TermReminder.words(push, zh = true))
        // A title alone has an empty body.
        assertEquals("T" to "", TermReminder.words(mapOf("title" to "T"), zh = false))
    }
}
