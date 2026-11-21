package sh.rcn.terminus

import android.content.Context
import androidx.core.content.edit
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.UnknownHostException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException

internal object Servers {
    fun isLocal(base: String): Boolean {
        val host = base.substringAfter("://").substringBefore('/').substringBefore(':')
        return base.startsWith("http://") && (host == "localhost" || host == "10.0.2.2")
    }

    fun all(default: String, others: List<String>, debug: Boolean): List<String> =
        (listOf(default) + others + if (debug) listOf("http://localhost:8787", "http://10.0.2.2:8787") else emptyList()).distinct()

    fun pick(saved: String?, all: List<String>): String = saved?.takeIf { it in all } ?: all.first()

    fun backup(base: String, all: List<String>): String? = if (isLocal(base)) null else all.firstOrNull { it != base && !isLocal(it) }

    fun order(base: String, all: List<String>, detour: String?): List<String> {
        val other = backup(base, all) ?: return listOf(base)
        return if (detour == other) listOf(other, base) else listOf(base, other)
    }

    fun unreached(e: Throwable, method: String): Boolean =
        e is UnknownHostException ||
            e is ConnectException ||
            e is NoRouteToHostException ||
            e is SSLHandshakeException ||
            (method == "GET" && (e is SocketException || e is SSLException) && e !is ApiError)

    const val DETOUR_MS = 10 * 60_000L

    fun menuAlways(debug: Boolean, flavor: String): Boolean = debug || flavor == "beta"

    const val UNLOCK_TAPS = 7

    val choices: List<String> by lazy {
        all(BuildConfig.API_BASE, BuildConfig.SERVERS.split(' ').filter { it.isNotEmpty() }, BuildConfig.DEBUG)
    }

    val siteHosts: Set<String> by lazy {
        choices.filterNot(::isLocal).map { it.substringAfter("://").substringBefore('/') }.toSet()
    }

    @Volatile private var current: String? = null

    val base: String
        get() = current ?: choices.first()

    @Volatile private var detour: Pair<String, Long>? = null

    fun tries(now: Long = System.currentTimeMillis()): List<String> = order(base, choices, detour?.takeIf { now < it.second }?.first)

    fun answered(at: String, now: Long = System.currentTimeMillis()) {
        val d = detour
        detour =
            when {
                at == base -> null
                d != null && d.first == at && now < d.second -> d
                else -> at to now + DETOUR_MS
            }
    }

    fun <T> through(
        tries: List<String>,
        method: String,
        path: String,
        answered: (String) -> Unit,
        status: (T) -> Int?,
        call: (String) -> T,
    ): T {
        for ((i, base) in tries.withIndex()) {
            val started = System.nanoTime()
            var code: Int? = null
            var failure: Throwable? = null
            try {
                return call(base).also {
                    code = status(it)
                    answered(base)
                }
            } catch (e: Exception) {
                failure = e
                if (e !is IOException || i == tries.lastIndex || !unreached(e, method)) throw e
            } finally {
                RequestLog.record(method, path, base, code, (System.nanoTime() - started) / 1_000_000, failure)
            }
        }
        error("no server to try")
    }

    fun <T> through(method: String, path: String, status: (T) -> Int?, call: (String) -> T): T =
        through(tries(), method, path, { answered(it) }, status, call)

    fun init(ctx: Context) {
        current = pick(terminusPrefs(ctx).getString(KEY_SERVER, null), choices)
    }

    fun menuUnlocked(ctx: Context): Boolean =
        menuAlways(BuildConfig.DEBUG, BuildConfig.FLAVOR) || terminusPrefs(ctx).getBoolean(KEY_MENU, false)

    fun unlockMenu(ctx: Context) = terminusPrefs(ctx).edit { putBoolean(KEY_MENU, true) }

    fun choose(ctx: Context, to: String): Boolean {
        require(to in choices) { "not one of this app's servers" }
        val from = base
        if (to == from) return false
        val swap = isLocal(from) != isLocal(to)
        if (swap) Store(ctx).swapSession(toLocal = isLocal(to))
        terminusPrefs(ctx).edit(commit = true) { putString(KEY_SERVER, to) }
        current = to
        detour = null
        return swap
    }

    const val KEY_SERVER = "server"
    const val KEY_MENU = "developer-menu"
}
