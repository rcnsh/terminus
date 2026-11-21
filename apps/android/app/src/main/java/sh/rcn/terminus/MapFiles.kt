package sh.rcn.terminus

import android.content.Context
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

class CampusChange(val lang: String, val json: JSONObject)

object MapFiles {
    private const val TILES = "campus.pmtiles"
    private const val META = "$TILES.json"
    private const val CHECK_MS = 7 * 24 * 3_600_000L
    private const val FRESH_MS = 3_600_000L
    internal const val MIN_TILES_BYTES = 64 * 1024L
    private const val SPARE_BYTES = 16 * 1024 * 1024L
    private const val STALE_TEMP_MS = 10 * 60_000L

    private val tilesLock = Mutex()

    private fun dir(ctx: Context) = File(ctx.filesDir, "map").apply { mkdirs() }

    private fun fresh(file: File) = file.exists() && System.currentTimeMillis() - file.lastModified() in 0 until FRESH_MS

    internal enum class CampusStep {
        KEPT,
        KEPT_THEN_CHECK,
        FETCH,
    }

    internal fun campusStep(kept: Boolean, ageMs: Long): CampusStep =
        when {
            !kept -> CampusStep.FETCH
            ageMs in 0 until FRESH_MS -> CampusStep.KEPT
            else -> CampusStep.KEPT_THEN_CHECK
        }

    private val checking = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    private val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val changed = MutableSharedFlow<CampusChange>(extraBufferCapacity = 4)

    val campusChanged: SharedFlow<CampusChange> = changed

    suspend fun <T> onCampusChange(shown: () -> Boolean, read: (JSONObject) -> T, use: (T) -> Unit) {
        campusChanged.collect { change ->
            if (!shown() || change.lang != campusLang()) return@collect
            val got =
                try {
                    withContext(Dispatchers.Default) { read(change.json) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    return@collect
                }
            use(got)
        }
    }

    fun campusLang(): String = if (L.zh) "zh" else "en"

    suspend fun campus(ctx: Context, api: Api): JSONObject? =
        withContext(Dispatchers.IO) {
            val lang = campusLang()
            val file = File(dir(ctx), "campus-$lang.json")
            val kept = runCatching { JSONObject(file.readText()) }.getOrNull()
            when (campusStep(kept != null, System.currentTimeMillis() - file.lastModified())) {
                CampusStep.KEPT -> kept
                CampusStep.KEPT_THEN_CHECK -> {
                    if (checking.add(lang))
                        background.launch {
                            try {
                                fetchCampus(ctx, api, lang, withTag = true)?.let { changed.tryEmit(CampusChange(lang, it)) }
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                if (e is ApiError && e.status == 401) Session.rejected(ctx, api.token)
                            } finally {
                                checking.remove(lang)
                            }
                        }
                    kept
                }
                CampusStep.FETCH -> fetchCampus(ctx, api, lang, withTag = false)
            }
        }

    private suspend fun fetchCampus(ctx: Context, api: Api, lang: String, withTag: Boolean): JSONObject? {
        val file = File(dir(ctx), "campus-$lang.json")
        val tagFile = File(dir(ctx), "campus-$lang.etag")
        val etag = if (withTag) runCatching { tagFile.readText() }.getOrNull()?.takeIf { it.isNotEmpty() } else null
        val got = api.campusJson(etag)
        if (got == null) {
            file.setLastModified(System.currentTimeMillis())
            return null
        }
        writeWhole(file, got.first.toString())
        if (got.second != null) writeWhole(tagFile, got.second!!) else tagFile.delete()
        return got.first
    }

    suspend fun style(ctx: Context, dark: Boolean, zh: Boolean): String? =
        withContext(Dispatchers.IO) {
            val theme = if (dark) "dark" else "light"
            val lang = if (zh) "zh" else "en"
            val dir = dir(ctx)
            val file = File(dir, "style-$theme-$lang.json")
            val kept = runCatching { file.readText() }.getOrNull()?.takeIf(::isJson)
            val text =
                kept?.takeIf { fresh(file) }
                    ?: fetchStyle("/map/style.json?theme=$theme&lang=$lang", file)
                    ?: kept
                    ?: return@withContext null
            val tiles = current(dir, readMeta(dir))
            try {
                if (tiles != null) localTiles(text, tiles.absolutePath) else withoutBaseMap(text)
            } catch (e: JSONException) {
                null
            }
        }

    private suspend fun fetchStyle(path: String, file: File): String? =
        try {
            get(path).takeIf(::isJson)?.also { writeWhole(file, it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }

    suspend fun tilesPath(ctx: Context): String? =
        withContext(Dispatchers.IO) {
            val dir = dir(ctx)
            current(dir, readMeta(dir))?.absolutePath
        }

    fun withoutBaseMap(style: String): String {
        val json = JSONObject(style)
        json.put("sources", JSONObject())
        val layers = json.optJSONArray("layers") ?: return style
        json.put(
            "layers",
            JSONArray((0 until layers.length()).map { layers.getJSONObject(it) }.filter { it.optString("type") == "background" }),
        )
        return json.toString()
    }

    fun localTiles(style: String, path: String): String {
        val json = JSONObject(style)
        val sources = json.optJSONObject("sources") ?: return style
        for (key in sources.keys()) {
            val src = sources.getJSONObject(key)
            if (src.optString("url").startsWith("pmtiles://http")) src.put("url", "pmtiles://file://$path")
        }
        return json.toString()
    }

    suspend fun keepTiles(ctx: Context): String? =
        withContext(Dispatchers.IO) {
            val job = currentCoroutineContext()[Job]
            tilesLock.withLock {
                val dir = dir(ctx)
                keepTiles(dir, System.currentTimeMillis(), { metered(ctx) }) { etag, into -> fetchTiles(ctx, dir, job, etag, into) }
            }
        }

    data class Fetched(val code: Int, val etag: String?, val length: Long?)

    internal fun keepTiles(dir: File, now: Long, metered: () -> Boolean, fetch: (etag: String?, into: File) -> Fetched): String? {
        val tiles = checked(dir)
        tidy(dir, tiles)
        val meta = readMeta(dir)
        val due = tiles == null || meta == null || now - meta.optLong("checked") !in 0 until CHECK_MS
        if (due && !(tiles != null && metered())) {
            try {
                download(dir, tiles, meta, now, fetch)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {}
        }
        return current(dir, readMeta(dir))?.absolutePath
    }

    private fun download(dir: File, tiles: File?, meta: JSONObject?, now: Long, fetch: (String?, File) -> Fetched) {
        val keptTag = meta?.optString("etag")?.takeIf { it.isNotEmpty() }
        val part = File.createTempFile("campus", ".part", dir)
        var kept = false
        try {
            val got = fetch(if (tiles != null) keptTag else null, part)
            when (got.code) {
                304 -> {
                    if (tiles == null || meta == null) error("not modified, with nothing kept")
                    writeMeta(dir, meta.put("file", tiles.name).put("size", tiles.length()).put("checked", now))
                }
                200 -> {
                    if (got.length != null && part.length() != got.length) error("short download")
                    if (!isPmTiles(head(part), part.length())) error("not a map file")
                    val target = File(dir, tilesName(got.etag, now))
                    if (!part.renameTo(target)) error("couldn't keep the map file")
                    kept = true
                    writeMeta(
                        dir,
                        JSONObject()
                            .put("file", target.name)
                            .put("size", target.length())
                            .put("etag", got.etag.orEmpty())
                            .put("checked", now),
                    )
                }
                else -> error("HTTP ${got.code}")
            }
        } finally {
            if (!kept) part.delete()
        }
    }

    private fun fetchTiles(ctx: Context, dir: File, job: Job?, etag: String?, into: File): Fetched {
        val conn =
            connect("/map/$TILES") { c ->
                c.connectTimeout = 8_000
                c.readTimeout = 30_000
                c.setRequestProperty("x-terminus-client", CLIENT)
                etag?.let { c.setRequestProperty("if-none-match", it) }
            }
        try {
            val code = conn.responseCode
            val length = conn.getHeaderField("content-length")?.toLongOrNull()
            if (code == 200) {
                if (room(ctx, dir) < (length ?: 0) + SPARE_BYTES) error("no room for the map file")
                conn.inputStream.use { input -> into.outputStream().use { copy(input, it, job) } }
            }
            return Fetched(code, conn.getHeaderField("etag"), length)
        } finally {
            conn.disconnect()
        }
    }

    private fun copy(input: InputStream, output: OutputStream, job: Job?) {
        val buf = ByteArray(64 * 1024)
        while (true) {
            if (job?.isActive == false) throw CancellationException("map download cancelled")
            val n = input.read(buf)
            if (n < 0) break
            output.write(buf, 0, n)
        }
    }

    private fun checked(dir: File): File? {
        val meta = readMeta(dir)
        current(dir, meta)?.let {
            return it
        }
        File(dir, meta?.optString("file")?.takeIf { it.isNotEmpty() } ?: TILES).delete()
        if (meta != null && meta.has("etag")) writeMeta(dir, JSONObject().put("checked", 0))
        return null
    }

    private fun current(dir: File, meta: JSONObject?): File? {
        val file = File(dir, meta?.optString("file")?.takeIf { it.isNotEmpty() } ?: TILES)
        if (!file.isFile) return null
        val size = meta?.optLong("size", -1) ?: -1
        if (size >= 0 && file.length() != size) return null
        return file.takeIf { isPmTiles(head(it), it.length()) }
    }

    private fun tidy(dir: File, keep: File?) {
        val now = System.currentTimeMillis()
        dir.listFiles()?.forEach { f ->
            val old =
                when {
                    f.name.endsWith(".pmtiles") -> f != keep
                    f.name.endsWith(".part") -> true
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
    }
        .getOrDefault(ByteArray(0))

    internal fun isPmTiles(head: ByteArray, size: Long): Boolean =
        size >= MIN_TILES_BYTES && head.size >= 8 && String(head, 0, 7, Charsets.US_ASCII) == "PMTiles" && head[7].toInt() == 3

    internal fun tilesName(etag: String?, now: Long): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("${etag.orEmpty()}|$now".toByteArray())
        return "campus-" + digest.take(6).joinToString("") { "%02x".format(it) } + ".pmtiles"
    }

    internal fun isJson(text: String): Boolean =
        try {
            JSONObject(text)
            true
        } catch (e: JSONException) {
            false
        }

    private fun writeWhole(file: File, text: String) {
        val tmp = File.createTempFile(file.name, ".tmp", file.parentFile)
        try {
            tmp.writeText(text)
            if (!tmp.renameTo(file)) error("couldn't keep ${file.name}")
        } finally {
            tmp.delete()
        }
    }

    private fun room(ctx: Context, dir: File): Long =
        try {
            val storage = ctx.getSystemService(android.os.storage.StorageManager::class.java)
            storage.getAllocatableBytes(storage.getUuidForPath(dir))
        } catch (e: Exception) {
            Long.MAX_VALUE
        }

    private fun metered(ctx: Context): Boolean =
        ctx.getSystemService(android.net.ConnectivityManager::class.java)?.isActiveNetworkMetered ?: true

    private fun get(path: String): String {
        val conn =
            connect(path) { c ->
                c.connectTimeout = 6_000
                c.readTimeout = 10_000
                c.setRequestProperty("x-terminus-client", CLIENT)
            }
        try {
            val code = conn.responseCode
            if (code != 200) error("HTTP $code")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun connect(path: String, setup: (HttpURLConnection) -> Unit): HttpURLConnection =
        Servers.through("GET", path, { it.responseCode }) { base ->
            val conn = URL(base + path).openConnection() as HttpURLConnection
            try {
                setup(conn)
                conn.responseCode
                conn
            } catch (e: Exception) {
                conn.disconnect()
                throw e
            }
        }
}
