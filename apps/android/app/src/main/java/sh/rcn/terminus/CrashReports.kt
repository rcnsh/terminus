package sh.rcn.terminus

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

internal object CrashReports {
    const val DIR = "crash"
    const val KEEP = 5
    const val MAX_LINES = 40
    const val MAX_MESSAGE = 2_000
    private const val MAX_HEADER = 300
    private const val MAX_CAUSES = 5
    private const val PATH = "/api/errors"
    const val KEY_ENABLED = "crash-reports"

    private val sending = AtomicBoolean(false)

    fun enabled(ctx: Context): Boolean = terminusPrefs(ctx).getBoolean(KEY_ENABLED, true)

    fun setEnabled(ctx: Context, on: Boolean) {
        terminusPrefs(ctx).edit { putBoolean(KEY_ENABLED, on) }
        if (!on) runCatching { dir(ctx).listFiles()?.forEach { it.delete() } }
    }

    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            runCatching { if (enabled(app)) save(app, e, fatal = true) }
            if (previous != null) previous.uncaughtException(thread, e) else throw e
        }
        sendPending(app)
    }

    fun sendPending(ctx: Context) {
        val app = ctx.applicationContext
        if (!enabled(app)) {
            runCatching { dir(app).listFiles()?.forEach { it.delete() } }
            return
        }
        if (!sending.compareAndSet(false, true)) return
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val files = dir(app).listFiles()?.filter { it.name.endsWith(".json") }?.sortedBy { it.name }.orEmpty()
                for (f in files) {
                    val body = runCatching { f.readText() }.getOrNull()
                    if (body == null || body.isBlank()) {
                        f.delete()
                        continue
                    }
                    val status =
                        try {
                            post(body)
                        } catch (_: Exception) {
                            break
                        }
                    if (done(status)) f.delete() else break
                }
            } finally {
                sending.set(false)
            }
        }
    }

    fun done(status: Int): Boolean = status in 200..499

    private fun post(body: String): Int = Servers.through("POST", PATH, { it }) { post(it, body) }

    private fun post(base: String, body: String): Int {
        val conn = URL(base + PATH).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 8_000
            conn.readTimeout = 10_000
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray()) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    private fun dir(ctx: Context) = File(ctx.filesDir, DIR)

    private fun save(ctx: Context, e: Throwable, fatal: Boolean) {
        val dir = dir(ctx)
        dir.mkdirs()
        val name = "${System.currentTimeMillis()}-${System.nanoTime() and 0xffff}.json"
        File(dir, name).writeText(body(e, BuildConfig.VERSION_NAME, Build.VERSION.RELEASE, fatal).toString())
        val names = dir.listFiles()?.map { it.name }.orEmpty()
        for (old in overCap(names)) File(dir, old).delete()
    }

    fun overCap(names: List<String>, keep: Int = KEEP): List<String> {
        val sorted = names.sortedWith(compareBy({ it.substringBefore('-').toLongOrNull() ?: 0L }, { it }))
        return sorted.take((sorted.size - keep).coerceAtLeast(0))
    }

    fun body(e: Throwable, version: String, release: String, fatal: Boolean): JSONObject =
        JSONObject()
            .put("platform", "android")
            .put("version", version)
            .put("os", "Android ${release.substringBefore('.')}")
            .put("type", e.javaClass.name)
            .put("message", (e.message ?: "").take(MAX_MESSAGE))
            .put("stack", stack(e))
            .put("fatal", fatal)

    fun stack(e: Throwable, maxLines: Int = MAX_LINES): String {
        val chain = mutableListOf<Throwable>()
        var t: Throwable? = e
        while (t != null && chain.size < MAX_CAUSES && chain.none { it === t }) {
            chain += t
            t = t.cause
        }
        val frames = (maxLines / chain.size - 2).coerceAtLeast(2)
        val lines = mutableListOf<String>()
        chain.forEachIndexed { i, c ->
            val header = c.toString().take(MAX_HEADER).replace('\n', ' ')
            lines += if (i == 0) header else "Caused by: $header"
            val trace = c.stackTrace
            trace.take(frames).forEach { lines += "\tat $it" }
            if (trace.size > frames) lines += "\t... ${trace.size - frames} more"
        }
        return lines.take(maxLines).joinToString("\n")
    }
}
