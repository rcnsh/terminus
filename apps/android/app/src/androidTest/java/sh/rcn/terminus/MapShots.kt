package sh.rcn.terminus

import android.graphics.Bitmap
import android.util.Base64
import android.util.Log
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Rule
import org.junit.Test
import sh.rcn.terminus.ui.BrandDark
import sh.rcn.terminus.ui.BrandLight
import sh.rcn.terminus.ui.BusStatus
import sh.rcn.terminus.ui.MapActions
import sh.rcn.terminus.ui.MapLayout
import sh.rcn.terminus.ui.MapSheet
import sh.rcn.terminus.ui.MapUi
import sh.rcn.terminus.ui.PlacesForMap
import java.io.ByteArrayOutputStream

/**
 * ONE-OFF (Phase 3 of docs/map-plan.md; delete before the PR): the Map tab
 * drawn on an emulator with the real street map (Protomaps' public build),
 * screenshotted into logcat as small JPEGs for a look from outside.
 */
class MapShots {
    @get:Rule val rule = createComposeRule()

    private fun asset(name: String) = InstrumentationRegistry.getInstrumentation().context.assets.open(name).bufferedReader().use { it.readText() }

    private val noop = MapActions({}, {}, {}, {}, { _, _ -> }, PlacesForMap({ null }, { false }, { _, _ -> }))

    /** The map file into the app's files, as MapFiles keeps its download. */
    private fun tiles(): String {
        val file = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "map/campus.pmtiles")
        file.parentFile?.mkdirs()
        InstrumentationRegistry.getInstrumentation().context.assets.open("campus.pmtiles").use { input -> file.outputStream().use { input.copyTo(it) } }
        return file.absolutePath
    }

    private fun shot(name: String, dark: Boolean, ui: (CampusMap, Set<String>) -> MapUi) {
        val (campus, core) = CampusMap.parse(JSONObject(asset("campus.json")))
        val style = MapFiles.localTiles(asset(if (dark) "style-dark.json" else "style-light.json"), tiles())
        val state = ui(campus, core).copy(campus = campus, core = core, style = style)
        rule.setContent {
            MaterialTheme(colorScheme = if (dark) BrandDark else BrandLight) {
                Surface(color = MaterialTheme.colorScheme.background) { MapLayout(state, dark, noop) }
            }
        }
        // Tiles, fonts and the camera settle.
        Thread.sleep(15_000)
        rule.waitForIdle()
        val full = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        val small = Bitmap.createScaledBitmap(full, 360, full.height * 360 / full.width, true)
        val out = ByteArrayOutputStream()
        small.compress(Bitmap.CompressFormat.JPEG, 62, out)
        val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        b64.chunked(3000).forEachIndexed { i, part -> Log.i("MAPSHOT", "$name $i ${(b64.length + 2999) / 3000} $part") }
    }

    private val buses = listOf(
        LiveBus("a", 1.29720, 103.78095, 120.0, true, "low", "UHall"),
        LiveBus("b", 1.29945, 103.77230, 200.0, true, "high", "YIH"),
        LiveBus("c", 1.29380, 103.78450, null, false, "medium", "PGP"),
    )

    @Test fun light() = shot("light", false) { _, _ -> MapUi() }

    @Test fun lightD2() = shot("lightD2", false) { _, _ -> MapUi(selected = "D2", buses = buses, busStatus = BusStatus.Running(3)) }

    @Test fun darkStop() = shot("darkStop", true) { _, _ ->
        MapUi(selected = "D2", buses = buses, busStatus = BusStatus.Running(3), sheet = MapSheet.Stop("COM3"), board = StopBoard(true, listOf(BoardRow("D2", 180, "live"), BoardRow("D1", 420, "live"))))
    }
}
