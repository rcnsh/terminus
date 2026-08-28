# The Quick Settings tile

The tile is the primary client, not the web page. Swipe down from anywhere —
including the lock screen — and the label already reads `D2 · 4 min`. iOS has
no equivalent, which is the one place being on Android is an advantage.

Everything below assumes the Worker is deployed at `https://YOUR.workers.dev`.

## Test the idea in five minutes before writing an APK

Install **HTTP Request Shortcuts** (F-Droid or Play). Create a shortcut:

- Method `GET`, URL `https://YOUR.workers.dev/next`
- Under *Scripting → Run on success*: `showToast(getVariable("response").label)`
  (or just set the response handling to "Display in a toast")
- Long-press the app → add the shortcut to the home screen, or use its own QS tile

That gets you the whole loop working before you write a line of Kotlin. If it
turns out you never tap it, you have learned the useful thing cheaply.

Skip Assistant routines. That layer has been unreliable through the Gemini
transition and it is not worth debugging.

## The real tile

`app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />

<application ...>
  <service
      android:name=".BusTileService"
      android:label="Next bus"
      android:icon="@drawable/ic_bus"
      android:exported="true"
      android:permission="android.permission.BIND_QUICK_SETTINGS_TILE">
    <intent-filter>
      <action android:name="android.service.quicksettings.action.QS_TILE" />
    </intent-filter>
    <meta-data android:name="android.service.quicksettings.ACTIVE_TILE"
               android:value="false" />
  </service>
</application>
```

`BusTileService.kt`:

```kotlin
package com.example.nusbus

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private const val BASE = "https://YOUR.workers.dev"

class BusTileService : TileService() {

    private var scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var lastDetail: String = ""

    /**
     * Fires when the shade opens, so the label is correct before the thumb
     * arrives. This is the whole reason the tile beats an app icon.
     */
    override fun onStartListening() {
        super.onStartListening()
        if (!scope.isActive()) scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
        refresh()
    }

    override fun onStopListening() {
        scope.cancel()
        super.onStopListening()
    }

    /** Tapping re-fetches; long-press opens the page. */
    override fun onClick() {
        super.onClick()
        refresh()
    }

    private fun refresh() {
        qsTile?.apply {
            state = Tile.STATE_ACTIVE
            subtitle = lastDetail.take(30)
            updateTile()
        }
        scope.launch {
            val answer = withContext(Dispatchers.IO) { runCatching { fetchAnswer() }.getOrNull() }
            val tile = qsTile ?: return@launch
            if (answer == null) {
                tile.label = "bus: offline"
                tile.state = Tile.STATE_INACTIVE
            } else {
                // The server pre-rendered these. Do not reformat them here --
                // the moment the client formats, four interfaces drift apart.
                tile.label = answer.optString("label", "bus")
                lastDetail = answer.optString("detail", "")
                tile.subtitle = lastDetail.take(30)
                tile.state = when (answer.optString("quality")) {
                    "live", "scheduled" -> Tile.STATE_ACTIVE
                    // stale, unknown and ended all read as dimmed: the label
                    // says what happened, the state says do not trust it.
                    else -> Tile.STATE_INACTIVE
                }
            }
            tile.updateTile()
        }
    }

    private fun fetchAnswer(): JSONObject {
        val fix = lastKnownLocation()
        val url = buildString {
            append(BASE).append("/next?t=").append(System.currentTimeMillis())  // cache-buster
            if (fix != null) {
                append("&lat=").append(fix.latitude).append("&lon=").append(fix.longitude)
            }
        }
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 3000
            readTimeout = 4000
            setRequestProperty("Accept", "application/json")
        }
        return conn.inputStream.bufferedReader().use { JSONObject(it.readText()) }
    }

    /**
     * getLastKnownLocation, NOT requestLocationUpdates.
     *
     * A 30-second-old fix is fine — the stops are fixed and the resolver works
     * on route order, not on metres. Waiting for a fresh fix costs exactly the
     * seconds this project exists to save. And if there is no fix at all, the
     * server falls back to the configured trip origin and still answers.
     */
    private fun lastKnownLocation(): Location? {
        val granted = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        if (!granted) return null

        val lm = getSystemService(LocationManager::class.java) ?: return null
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
            .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }
            .maxByOrNull { it.time }
    }

    override fun onTileAdded() {
        super.onTileAdded()
        qsTile?.apply { label = "Next bus"; state = Tile.STATE_INACTIVE; updateTile() }
    }
}

private fun CoroutineScope.isActive() = coroutineContext[kotlinx.coroutines.Job]?.isActive == true
```

To open the page on long-press, add an activity and point the tile's
`android:name` metadata at it, or call
`startActivityAndCollapse(PendingIntent.getActivity(this, 0, Intent(Intent.ACTION_VIEW, Uri.parse(BASE)), PendingIntent.FLAG_IMMUTABLE))`
from `onClick`.

## Why this shape

**No `updatePeriodMillis`, no `WorkManager`, no cached value.** The tile
fetches on demand, in `onStartListening`. OEM battery managers — Samsung,
Xiaomi, OnePlus — kill background work regardless of what the docs promise, so
any design that depends on a background refresh having run is a design that
shows you a wrong number on the day it matters. A ~300 ms fetch when the shade
opens is both simpler and more correct.

**`ACTIVE_TILE` is false.** Active tiles only refresh when the app calls
`requestListeningState`, which needs a background trigger — the thing that gets
killed. The default (non-active) tile gets `onStartListening` on shade open,
which is exactly the event that matters.

**The three-second budget.** Shade open → `onStartListening` → last-known fix
(instant, no I/O) → one HTTPS GET to the nearest Cloudflare colo → label set.
Anything that blocks — a fresh GPS fix, a cold auth handshake, a poll loop
waking up — spends the budget the tile exists to protect.

**Grant location "while using the app".** Background location is not needed
and not requested: the tile only reads a fix while the shade is open, and with
no fix at all the server answers from the configured trip origin anyway.

## Sideload

```bash
./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk
```

No Play Store. Add the tile from the QS edit panel (pencil icon → drag "Next
bus" up).
