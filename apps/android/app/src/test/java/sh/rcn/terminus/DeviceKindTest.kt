package sh.rcn.terminus

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceKindTest {
    @Test
    fun aTabletIsWideAtItsNarrowestAndHasNoHinge() {
        assertTrue("a Pixel Tablet, 800 dp at its narrowest", DeviceKind.isTablet(hinge = false, smallestWidthDp = 800))
        assertFalse(
            "a Pixel Fold open, 701 dp at its narrowest, is still a phone",
            DeviceKind.isTablet(hinge = true, smallestWidthDp = 701),
        )
        assertFalse("a phone", DeviceKind.isTablet(hinge = false, smallestWidthDp = 411))
    }
}
