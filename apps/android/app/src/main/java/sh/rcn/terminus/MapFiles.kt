package sh.rcn.terminus

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * What the Map tab keeps on the phone so the campus map works offline after
 * the first look: the stops and routes (`/campus`), the map's style in each
 * theme and language used, and the whole campus map file (about 3 MB).
 * MapLibre doesn't cache PMTiles it streams, so the file is downloaded once,
 * checked weekly for a newer one, and read from storage
 * (`pmtiles://file://…`); until then the map is plain. Fonts and icons go
 * through MapLibre's own cache.
 */
object MapFiles {
    private const val TILES = "campus.pmtiles"
    private const val CHECK_MS = 7 * 24 * 3_600_000L
    /** `/campus` and the style say `max-age=3600`: a copy that young isn't asked about again. */
    private const val FRESH_MS = 3_600_000L

    private fun dir(ctx: Context) = File(ctx.filesDir, "map").apply { mkdirs() }

    private fun fresh(file: File) = file.exists() && System.currentTimeMillis() - file.lastModified() in 0 until FRESH_MS

    /**
     * `/campus`: the kept copy while it's fresh; then from the network, sent
     * with the kept copy's ETag so an unchanged one costs no download; the
     * kept copy without a connection. Opening the Map or Buses tab used to
     * fetch it whole every time.
     */
    suspend fun campus(ctx: Context, api: Api): JSONObject? = withContext(Dispatchers.IO) {
        val file = File(dir(ctx), "campus.json")
        val tagFile = File(dir(ctx), "campus.etag")
        val kept = runCatching { JSONObject(file.readText()) }.getOrNull()
        if (kept != null && fresh(file)) return@withContext kept
        try {
            val etag = if (kept != null) runCatching { tagFile.readText() }.getOrNull()?.takeIf { it.isNotEmpty() } else null
            val got = api.campusJson(etag)
            if (got == null) {
                file.setLastModified(System.currentTimeMillis())
                kept
            } else {
                file.writeText(got.first.toString())
                if (got.second != null) tagFile.writeText(got.second!!) else tagFile.delete()
                got.first
            }
        } catch (e: Exception) {
            // Signed out or refused: not something a kept copy should hide.
            if (e is ApiError && e.status == 401) throw e
            kept
        }
    }

    /**
     * The style for [dark] and [zh]: the street map from the downloaded file,
     * or, until it's downloaded, the routes and stops on a plain map. Never
     * streamed: MapLibre Native fails the whole style when one fetch of a
     * streamed map file fails, which would blank the routes too. Null with
     * no connection and nothing kept.
     */
    suspend fun style(ctx: Context, dark: Boolean, zh: Boolean): String? = withContext(Dispatchers.IO) {
        val theme = if (dark) "dark" else "light"
        val lang = if (zh) "zh" else "en"
        val file = File(dir(ctx), "style-$theme-$lang.json")
        val keptText = if (fresh(file)) runCatching { file.readText() }.getOrNull() else null
        val text = keptText
            ?: runCatching { get("${BuildConfig.API_BASE}/map/style.json?theme=$theme&lang=$lang").also { file.writeText(it) } }
                .getOrElse { runCatching { file.readText() }.getOrNull() }
            ?: return@withContext null
        val tiles = File(dir(ctx), TILES)
        if (tiles.exists()) localTiles(text, tiles.absolutePath) else withoutBaseMap(text)
    }

    /** Whether the map file is on the phone. */
    fun hasTiles(ctx: Context): Boolean = File(dir(ctx), TILES).exists()

    /** The style with only its background: no map file, no street layers. */
    fun withoutBaseMap(style: String): String {
        val json = JSONObject(style)
        json.put("sources", JSONObject())
        val layers = json.optJSONArray("layers") ?: return style
        json.put("layers", JSONArray((0 until layers.length()).map { layers.getJSONObject(it) }.filter { it.optString("type") == "background" }))
        return json.toString()
    }

    /** The style with its map file read from [path] instead of the network. */
    fun localTiles(style: String, path: String): String {
        val json = JSONObject(style)
        val sources = json.optJSONObject("sources") ?: return style
        for (key in sources.keys()) {
            val src = sources.getJSONObject(key)
            if (src.optString("url").startsWith("pmtiles://http")) src.put("url", "pmtiles://file://$path")
        }
        return json.toString()
    }

    /**
     * Downloads the map file if it isn't here or wasn't checked this week
     * (only when it changed: by its ETag). Quiet on failure; the map then
     * streams it, and the next visit tries again.
     */
    suspend fun keepTiles(ctx: Context) = withContext(Dispatchers.IO) {
        keepTiles(dir(ctx), System.currentTimeMillis(), { metered(ctx) }, ::fetchTiles)
    }

    /** What the map file's URL answered: its status, ETag and Content-Length. */
    data class Fetched(val code: Int, val etag: String?, val length: Long?)

    /**
     * [keepTiles] in [dir] at [now]. [fetch] asks for the map file (with the
     * kept ETag, if any) and, on a 200, writes the body to its second argument.
     */
    internal fun keepTiles(dir: File, now: Long, metered: () -> Boolean, fetch: (etag: String?, into: File) -> Fetched) {
        val tiles = File(dir, TILES)
        val meta = File(dir, "$TILES.json")
        val kept = runCatching { JSONObject(meta.readText()) }.getOrNull()
        if (tiles.exists() && kept != null && now - kept.optLong("checked") < CHECK_MS) return
        // A newer map (twice a year) can wait for Wi-Fi; the first one can't, or there's no map.
        if (tiles.exists() && metered()) return
        runCatching {
            val part = File(dir, "$TILES.part")
            val got = fetch(if (tiles.exists()) kept?.optString("etag")?.takeIf { it.isNotEmpty() } else null, part)
            when (got.code) {
                304 -> {}
                200 -> {
                    // A cut-off download must not replace a good file.
                    if (got.length != null && part.length() != got.length) error("short download")
                    if (!part.renameTo(tiles)) error("couldn't keep the map file")
                }
                else -> error("HTTP ${got.code}")
            }
            meta.writeText(JSONObject().put("etag", got.etag ?: kept?.optString("etag").orEmpty()).put("checked", now).toString())
        }
    }

    private fun fetchTiles(etag: String?, into: File): Fetched {
        val conn = URL("${BuildConfig.API_BASE}/map/$TILES").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("x-terminus-client", CLIENT)
            etag?.let { conn.setRequestProperty("if-none-match", it) }
            val code = conn.responseCode
            if (code == 200) conn.inputStream.use { input -> into.outputStream().use { input.copyTo(it) } }
            return Fetched(code, conn.getHeaderField("etag"), conn.getHeaderField("content-length")?.toLongOrNull())
        } finally {
            conn.disconnect()
        }
    }

    private fun metered(ctx: Context): Boolean =
        ctx.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true

    private fun get(url: String): String {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 6_000
            conn.readTimeout = 10_000
            conn.setRequestProperty("x-terminus-client", CLIENT)
            if (conn.responseCode != 200) error("HTTP ${conn.responseCode}")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }
}
