package sh.rcn.terminus

import android.content.Context
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * What the Map tab keeps on the phone so the campus map works offline after
 * the first look: the stops and routes (`/campus`), the map's style in each
 * theme and language used, and the whole campus map file (about 3 MB).
 * MapLibre doesn't cache PMTiles it streams, so the file is downloaded once,
 * checked weekly for a newer one, and read from storage
 * (`pmtiles://file://…`); until then the map is plain. Fonts and icons go
 * through MapLibre's own cache.
 *
 * Each version of the map file has a name of its own: MapLibre keeps a
 * file's header and directories by its URL, so a newer one written over the
 * same path could be read with the old one's. Older versions go at the next
 * check, once no map shows them.
 */
object MapFiles {
    private const val TILES = "campus.pmtiles"
    /** What the kept map file is: its name, size, ETag and when it was last checked. */
    private const val META = "$TILES.json"
    private const val CHECK_MS = 7 * 24 * 3_600_000L
    /** `/campus` and the style say `max-age=3600`: a copy that young isn't asked about again. */
    private const val FRESH_MS = 3_600_000L
    /** The campus file is about 3 MB: anything under this is not the map. */
    internal const val MIN_TILES_BYTES = 64 * 1024L
    /** Room left over after the download, so the map doesn't fill the phone. */
    private const val SPARE_BYTES = 16 * 1024 * 1024L
    /** A temporary file this old is left over from a write that never finished. */
    private const val STALE_TEMP_MS = 10 * 60_000L

    /** One download at a time in this process: a second would write the same file. */
    private val tilesLock = Mutex()

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
                // The Map and Buses tabs can both be writing it: each write whole, or not at all.
                writeWhole(file, got.first.toString())
                if (got.second != null) writeWhole(tagFile, got.second!!) else tagFile.delete()
                got.first
            }
        } catch (e: CancellationException) {
            throw e
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
     * no connection and nothing kept (or nothing readable).
     */
    suspend fun style(ctx: Context, dark: Boolean, zh: Boolean): String? = withContext(Dispatchers.IO) {
        val theme = if (dark) "dark" else "light"
        val lang = if (zh) "zh" else "en"
        val dir = dir(ctx)
        val file = File(dir, "style-$theme-$lang.json")
        // A copy cut short (the app killed mid-write, before writes were whole) is no copy.
        val kept = runCatching { file.readText() }.getOrNull()?.takeIf(::isJson)
        val text = kept?.takeIf { fresh(file) }
            ?: fetchStyle("${BuildConfig.API_BASE}/map/style.json?theme=$theme&lang=$lang", file)
            ?: kept
            ?: return@withContext null
        val tiles = current(dir, readMeta(dir))
        try {
            if (tiles != null) localTiles(text, tiles.absolutePath) else withoutBaseMap(text)
        } catch (e: JSONException) {
            null
        }
    }

    private suspend fun fetchStyle(url: String, file: File): String? = try {
        get(url).takeIf(::isJson)?.also { writeWhole(file, it) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }

    /** Where the map file is on the phone, if a whole one is. */
    suspend fun tilesPath(ctx: Context): String? = withContext(Dispatchers.IO) {
        val dir = dir(ctx)
        current(dir, readMeta(dir))?.absolutePath
    }

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
     * (only when it changed: by its ETag). Quiet on failure: the map stays
     * plain, or on the file it had, and the next visit tries again. Returns
     * where the map file is now, if one is.
     */
    suspend fun keepTiles(ctx: Context): String? = withContext(Dispatchers.IO) {
        tilesLock.withLock {
            val dir = dir(ctx)
            val tiles = checked(dir)
            tidy(dir, tiles)
            val meta = readMeta(dir)
            val now = System.currentTimeMillis()
            val due = tiles == null || meta == null || now - meta.optLong("checked") !in 0 until CHECK_MS
            // A newer map (twice a year) can wait for Wi-Fi; the first one can't, or there's no map.
            if (due && !(tiles != null && metered(ctx))) {
                try {
                    download(ctx, dir, tiles, meta, now)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Quiet: tried again next time.
                }
            }
            current(dir, readMeta(dir))?.absolutePath
        }
    }

    private suspend fun download(ctx: Context, dir: File, tiles: File?, meta: JSONObject?, now: Long) {
        val conn = URL("${BuildConfig.API_BASE}/map/$TILES").openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 8_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("x-terminus-client", CLIENT)
            val keptTag = meta?.optString("etag")?.takeIf { it.isNotEmpty() }
            // Only with a whole file here: a 304 then means that file is current.
            if (tiles != null && keptTag != null) conn.setRequestProperty("if-none-match", keptTag)
            when (conn.responseCode) {
                304 -> {
                    if (tiles == null || meta == null) error("not modified, with nothing kept")
                    // A file kept before versions had names gets its name and size written down.
                    writeMeta(dir, meta.put("file", tiles.name).put("size", tiles.length()).put("checked", now))
                }
                200 -> {
                    val length = conn.getHeaderField("content-length")?.toLongOrNull()
                    if (room(ctx, dir) < (length ?: 0) + SPARE_BYTES) error("no room for the map file")
                    val etag = conn.getHeaderField("etag")
                    // A file of its own for each try: nothing else writes to it.
                    val part = File.createTempFile("campus", ".part", dir)
                    var kept = false
                    try {
                        conn.inputStream.use { input -> part.outputStream().use { copy(input, it) } }
                        // A cut-off download, or something that isn't the map, must not replace a good file.
                        if (length != null && part.length() != length) error("short download")
                        if (!isPmTiles(head(part), part.length())) error("not a map file")
                        val target = File(dir, tilesName(etag, now))
                        if (!part.renameTo(target)) error("couldn't keep the map file")
                        kept = true
                        writeMeta(dir, JSONObject().put("file", target.name).put("size", target.length()).put("etag", etag.orEmpty()).put("checked", now))
                    } finally {
                        if (!kept) part.delete()
                    }
                }
                else -> error("HTTP ${conn.responseCode}")
            }
        } finally {
            conn.disconnect()
        }
    }

    /** Copies in pieces, stopping when the caller is cancelled (the app closed) rather than at the end. */
    private suspend fun copy(input: InputStream, output: OutputStream) {
        val buf = ByteArray(64 * 1024)
        while (true) {
            currentCoroutineContext().ensureActive()
            val n = input.read(buf)
            if (n < 0) break
            output.write(buf, 0, n)
        }
    }

    /**
     * The kept map file, checked: a missing, cut-short or unreadable one is
     * deleted and its ETag dropped, so the next download asks for it whole
     * rather than being told it's unchanged. Only under [tilesLock].
     */
    private fun checked(dir: File): File? {
        val meta = readMeta(dir)
        current(dir, meta)?.let { return it }
        File(dir, meta?.optString("file")?.takeIf { it.isNotEmpty() } ?: TILES).delete()
        if (meta != null && meta.has("etag")) writeMeta(dir, JSONObject().put("checked", 0))
        return null
    }

    /** The kept map file, if it's whole: the size it was kept at, and a PMTiles header. */
    private fun current(dir: File, meta: JSONObject?): File? {
        // Before files had a version of their own, the one file was campus.pmtiles.
        val file = File(dir, meta?.optString("file")?.takeIf { it.isNotEmpty() } ?: TILES)
        if (!file.isFile) return null
        val size = meta?.optLong("size", -1) ?: -1
        if (size >= 0 && file.length() != size) return null
        return file.takeIf { isPmTiles(head(it), it.length()) }
    }

    /** Older map files and temporary files left behind, all but [keep]. Only under [tilesLock]. */
    private fun tidy(dir: File, keep: File?) {
        val now = System.currentTimeMillis()
        dir.listFiles()?.forEach { f ->
            val old = when {
                f.name.endsWith(".pmtiles") -> f != keep
                f.name.endsWith(".part") -> true
                // Another tab may be writing campus.json right now: only ones long left.
                f.name.endsWith(".tmp") -> now - f.lastModified() > STALE_TEMP_MS
                else -> false
            }
            if (old) f.delete()
        }
    }

    private fun readMeta(dir: File): JSONObject? = runCatching { JSONObject(File(dir, META).readText()) }.getOrNull()

    private fun writeMeta(dir: File, meta: JSONObject) = writeWhole(File(dir, META), meta.toString())

    private fun head(file: File): ByteArray = runCatching {
        file.inputStream().use { input ->
            val b = ByteArray(8)
            var n = 0
            while (n < b.size) {
                val r = input.read(b, n, b.size - n)
                if (r < 0) break
                n += r
            }
            b.copyOf(n)
        }
    }.getOrDefault(ByteArray(0))

    /** A PMTiles version 3 file: "PMTiles", then the version byte, and big enough to be a map. */
    internal fun isPmTiles(head: ByteArray, size: Long): Boolean =
        size >= MIN_TILES_BYTES && head.size >= 8 && String(head, 0, 7, Charsets.US_ASCII) == "PMTiles" && head[7].toInt() == 3

    /** The name for a map file: one per version (its ETag), and per download, so it never replaces one in use. */
    internal fun tilesName(etag: String?, now: Long): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("${etag.orEmpty()}|$now".toByteArray())
        return "campus-" + digest.take(6).joinToString("") { "%02x".format(it) } + ".pmtiles"
    }

    internal fun isJson(text: String): Boolean = try {
        JSONObject(text)
        true
    } catch (e: JSONException) {
        false
    }

    /** Written to a temporary file, then renamed over [file]: a reader sees the old text or the new, never half. */
    private fun writeWhole(file: File, text: String) {
        val tmp = File.createTempFile(file.name, ".tmp", file.parentFile)
        try {
            tmp.writeText(text)
            if (!tmp.renameTo(file)) error("couldn't keep ${file.name}")
        } finally {
            tmp.delete()
        }
    }

    /** Bytes the app can still write where [dir] is (cache the system may clear counted in); unknown: no limit. */
    private fun room(ctx: Context, dir: File): Long = try {
        val storage = ctx.getSystemService(android.os.storage.StorageManager::class.java)
        storage.getAllocatableBytes(storage.getUuidForPath(dir))
    } catch (e: Exception) {
        Long.MAX_VALUE
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
