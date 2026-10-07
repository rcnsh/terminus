package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Test

class SignInCodeTest {
    /** Types [s] one character at a time, as a keyboard does, from [start]. */
    private fun type(s: String, start: String = "") = s.fold(start) { code, c -> codeEdit(code, code + c) }

    @Test fun typingFillsTheBoxesOneByOne() {
        assertEquals("7", codeEdit("", "7"))
        assertEquals("7K", codeEdit("7", "7k"))
        assertEquals("7KQ2XM", type("7kq2xm"))
    }

    @Test fun typingPastTheLastBoxDoesNothing() {
        assertEquals("7KQ2XM", type("A", "7KQ2XM"))
    }

    @Test fun deletingStepsBack() {
        assertEquals("7KQ2X", codeEdit("7KQ2XM", "7KQ2X"))
        assertEquals("", codeEdit("7", ""))
    }

    @Test fun spacesAndDashesTypedAreSkipped() {
        assertEquals("7KQ", codeEdit("7KQ", "7KQ "))
        assertEquals("7KQ2", type("-2", "7KQ"))
    }

    @Test fun aPastedCodeSpreadsOverTheBoxes() {
        assertEquals("7KQ2XM", codeEdit("", "7KQ2XM"))
        assertEquals("7KQ2XM", codeEdit("", "7kq2xm"))
        assertEquals("7KQ2XM", codeEdit("", " 7KQ2XM\n"))
    }

    @Test fun aPastedCodeKeepsOnlyTheCodeFromAroundIt() {
        assertEquals("7KQ2XM", codeEdit("", "Your terminus code: 7KQ2XM"))
        assertEquals("7KQ2XM", codeEdit("", "Your sign-in code is 7KQ2XM. It works for 15 minutes."))
        assertEquals("7KQ2XM", codeEdit("", "Your code is 7KQ2XM within 15 minutes"))
        assertEquals("7KQ2XM", codeEdit("", "你的登录验证码是 7KQ2XM。"))
    }

    @Test fun aCodePastedInPiecesOrSplitStillFits() {
        assertEquals("7KQ2XM", codeEdit("", "7KQ 2XM"))
        assertEquals("7KQ2XM", codeEdit("", "7KQ-2XM"))
        assertEquals("7KQ", codeEdit("", "7KQ"))
        assertEquals("7KQ2XM", codeEdit("7KQ", "7KQ2XM"))
    }

    @Test fun aPasteOverWhatWasTypedReplacesIt() {
        // Pasted after a few typed characters, or into full boxes: the pasted code wins.
        assertEquals("7KQ2XM", codeEdit("AB", "AB7KQ2XM"))
        assertEquals("7KQ2XM", codeEdit("ABCDEF", "ABCDEF7KQ2XM"))
    }
}
