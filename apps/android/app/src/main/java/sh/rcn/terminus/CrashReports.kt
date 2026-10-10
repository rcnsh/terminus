package sh.rcn.terminus

import android.content.Context
import android.os.Build
import androidx.core.content.edit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Crash reports, sent to our own server (POST /api/errors) with nothing
 * that says who or where: no token, no cookie, no device or install id. Only
 * what broke, the app's version and Android's.
 *
 * A crash is written to a file in the app's own storage ([DIR]) and sent the
 * next time the app starts, never from inside the crash: the process is
 * dying, and a request there could hang it. "Send crash reports" in Settings
 * (on unless turned off, kept on this phone) stops both the writing and the
 * sending.
 */
internal object CrashReports {
    const val DIR = "crash"
    const val KEEP = 5
    const val MAX_LINES = 40
    const val MAX_MESSAGE = 2_000
    /** One throwable's line in the stack (its class and message), cut so a long message isn't sent twice in full. */
    private const val MAX_HEADER = 300
    /** Causes followed at most: a chain longer than this is almost always a loop. */
    private const val MAX_CAUSES = 5
    private const val PATH = "/api/errors"
    const val KEY_ENABLED = "crash-reports"

    private val sending = AtomicBoolean(false)

    fun enabled(ctx: Context): Boolean = terminusPrefs(ctx).getBoolean(KEY_ENABLED, true)

    /** Turned off: anything written and not yet sent goes too. */
    fun setEnabled(ctx: Context, on: Boolean) {
        terminusPrefs(ctx).edit { putBoolean(KEY_ENABLED, on) }
        if (!on) runCatching { dir(ctx).listFiles()?.forEach { it.delete() } }
    }

    /**
     * At process start ([TerminusApp]): catch what nothing else does, write
     * it down, then let the phone's own handler crash the app as before.
     * Then send what earlier crashes left.
     */
    fun install(ctx: Context) {
        val app = ctx.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            // Nothing here may throw or wait on the network: the crash must still happen.
            runCatching { if (enabled(app)) save(app, e, fatal = true) }
            if (previous != null) previous.uncaughtException(thread, e) else throw e
        }
        sendPending(app)
    }

    /** An error the app caught but didn't expect: kept, and sent in the background. */
    fun report(ctx: Context, e: Throwable) {
        val app = ctx.applicationContext
        if (!enabled(app)) return
        runCatching { save(app, e, fatal = false) }
        sendPending(app)
    }

    /** What's waiting, oldest first, sent one by one in the background; each sent (or refused) is deleted. */
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
                    val status = try {
                        post(body)
                    } catch (_: IOException) {
                        // Offline, or no answer: kept for the next start.
                        break
                    }
                    if (done(status)) f.delete() else break
                }
            } finally {
                sending.set(false)
            }
        }
    }

    /** Sent, or refused for good (a bad body, too many reports): gone. A 5xx is kept for the next start. */
    fun done(status: Int): Boolean = status in 200..499

    private fun post(body: String): Int {
        val conn = URL(Servers.base + PATH).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 8_000
            conn.readTimeout = 10_000
            conn.useCaches = false
            conn.doOutput = true
            conn.setRequestProperty("content-type", "application/json")
            // No authorization header and no cookies: the report is anonymous.
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

    /** The files to drop so at most [keep] are left: the oldest (the names start with the time written). */
    fun overCap(names: List<String>, keep: Int = KEEP): List<String> {
        val sorted = names.sortedWith(compareBy({ it.substringBefore('-').toLongOrNull() ?: 0L }, { it }))
        return sorted.take((sorted.size - keep).coerceAtLeast(0))
    }

    /** The report as the server takes it. [release]: Android's version, e.g. "15" or "8.1.0"; only the major part is sent. */
    fun body(e: Throwable, version: String, release: String, fatal: Boolean): JSONObject =
        JSONObject()
            .put("platform", "android")
            .put("version", version)
            .put("os", "Android ${release.substringBefore('.')}")
            .put("type", e.javaClass.name)
            .put("message", (e.message ?: "").take(MAX_MESSAGE))
            .put("stack", stack(e))
            .put("fatal", fatal)

    /**
     * The stack, causes included, in at most [maxLines] lines. Each cause
     * gets its share of the lines, so the root cause (often the one that
     * says why) isn't cut off by a long first trace.
     */
    fun stack(e: Throwable, maxLines: Int = MAX_LINES): String {
        val chain = mutableListOf<Throwable>()
        var t: Throwable? = e
        while (t != null && chain.size < MAX_CAUSES && chain.none { it === t }) {
            chain += t
            t = t.cause
        }
        // Each throwable: its own line, its frames, and a line saying how many were left out.
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
