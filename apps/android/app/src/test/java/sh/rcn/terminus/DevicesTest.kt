package sh.rcn.terminus

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.rcn.terminus.ui.deviceIcon

/** Settings › Devices names a watch from the server's `watch`, not its platform ("ios", as for an iPhone). */
class DevicesTest {
    private fun device(platform: String?, watch: Boolean = false) = Device("a", "Apple Watch", platform, 0, 0, false, watch)

    @Test
    fun aWatchIsNamedAWatch() {
        assertEquals("Apple Watch", device("ios", watch = true).platformName)
        assertEquals("an older server never says watch", "iPhone", device("ios").platformName)
        assertEquals("Android", device("android").platformName)
        assertEquals("Mac", device("mac").platformName)
        assertEquals(null, device(null).platformName)
    }

    @Test
    fun aWatchIsDrawnAsAWatch() {
        assertEquals(R.drawable.ic_device_watch, deviceIcon(device("ios", watch = true)))
        assertEquals(R.drawable.ic_device_phone, deviceIcon(device("ios")))
        assertEquals(R.drawable.ic_device_phone, deviceIcon(device("android")))
        assertEquals(R.drawable.ic_device_mac, deviceIcon(device("mac")))
        assertEquals(R.drawable.ic_device_phone, deviceIcon(device(null)))
    }
}
