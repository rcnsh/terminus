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

/**
 * Which server the app talks to. Only ever one built into the app: the site's own addresses (the first is the default) and, in a debug
 * build, the local dev stub. The developer menu (Settings, About) picks one; nothing can add one, so the menu can't send a token anywhere
 * but our own servers.
 *
 * The default is the address people see (terminus.run), the one that goes with the project if someone else takes it over. The other,
 * terminus.rcn.sh, is the backup: a request that can't reach one at all goes to the other ([order]), so a network that refuses one of them
 * doesn't stop the app.
 */
internal object Servers {
    /** Plain HTTP to this phone or the emulator's host: the dev stub (scripts/dev-stub.mjs). */
    fun isLocal(base: String): Boolean {
        val host = base.substringAfter("://").substringBefore('/').substringBefore(':')
        return base.startsWith("http://") && (host == "localhost" || host == "10.0.2.2")
    }

    /**
     * The servers to choose from: [default] first, then [others] (the site's other addresses), then in a [debug] build the stub, through
     * `adb reverse` or from the emulator.
     */
    fun all(default: String, others: List<String>, debug: Boolean): List<String> =
        (listOf(default) + others + if (debug) listOf("http://localhost:8787", "http://10.0.2.2:8787") else emptyList()).distinct()

    /** The saved choice if it's still one of [all], else the default: a server dropped from the app is never used again. */
    fun pick(saved: String?, all: List<String>): String = saved?.takeIf { it in all } ?: all.first()

    /** The site's other address, for when [base] can't be reached. None for the stub. */
    fun backup(base: String, all: List<String>): String? = if (isLocal(base)) null else all.firstOrNull { it != base && !isLocal(it) }

    /**
     * Where a request goes, in turn: [base], then its [backup]. While a [detour] is on (the backup answered a moment ago when [base]
     * didn't), the backup first, so a refused address doesn't slow every request.
     */
    fun order(base: String, all: List<String>, detour: String?): List<String> {
        val other = backup(base, all) ?: return listOf(base)
        return if (detour == other) listOf(other, base) else listOf(base, other)
    }

    /**
     * Whether [e] means the server was never reached, so the request can go to the other address without arriving twice: no address for the
     * name, a connection refused, or a TLS handshake cut off (a firewall resetting it). Any other reset only for a GET, which is safe to
     * repeat; never a timeout or an answer from the server ([ApiError]).
     */
    fun unreached(e: Throwable, method: String): Boolean =
        e is UnknownHostException ||
            e is ConnectException ||
            e is NoRouteToHostException ||
            e is SSLHandshakeException ||
            (method == "GET" && (e is SocketException || e is SSLException) && e !is ApiError)

    /** How long requests go to the backup first, once it answered when the chosen address didn't. */
    const val DETOUR_MS = 10 * 60_000L

    /** The developer menu shows in debug and beta builds; in a stable release, once the version in About is tapped [UNLOCK_TAPS] times. */
    fun menuAlways(debug: Boolean, flavor: String): Boolean = debug || flavor == "beta"

    const val UNLOCK_TAPS = 7

    val choices: List<String> by lazy {
        all(BuildConfig.API_BASE, BuildConfig.SERVERS.split(' ').filter { it.isNotEmpty() }, BuildConfig.DEBUG)
    }

    /** The site's hosts, whose pairing links open the app (the stub's aren't). */
    val siteHosts: Set<String> by lazy {
        choices.filterNot(::isLocal).map { it.substringAfter("://").substringBefore('/') }.toSet()
    }

    @Volatile private var current: String? = null

    /** Where requests go now. Read before [init] (it never is: TerminusApp runs first), the default. */
    val base: String
        get() = current ?: choices.first()

    /** The backup and until when it goes first ([order]), after the chosen address couldn't be reached. */
    @Volatile private var detour: Pair<String, Long>? = null

    /** Where a request goes now, in turn ([order]). */
    fun tries(now: Long = System.currentTimeMillis()): List<String> = order(base, choices, detour?.takeIf { now < it.second }?.first)

    /**
     * [at] answered. The chosen address ends a detour; the backup starts one, which isn't stretched while it lasts, so the chosen address
     * is tried first again within [DETOUR_MS].
     */
    fun answered(at: String, now: Long = System.currentTimeMillis()) {
        val d = detour
        detour =
            when {
                at == base -> null
                d != null && d.first == at && now < d.second -> d
                else -> at to now + DETOUR_MS
            }
    }

    /**
     * [call] with each of [tries] in turn, the next only when one couldn't be reached ([unreached]); the one that answered goes to
     * [answered]. For what doesn't go through Api's request (crash reports, the map files), so it falls back to the backup the same way.
     */
    fun <T> through(tries: List<String>, method: String, answered: (String) -> Unit, call: (String) -> T): T {
        for ((i, base) in tries.withIndex()) {
            try {
                return call(base).also { answered(base) }
            } catch (e: IOException) {
                if (i == tries.lastIndex || !unreached(e, method)) throw e
            }
        }
        error("no server to try")
    }

    /** [through] the addresses requests go to now ([tries]). */
    fun <T> through(method: String, call: (String) -> T): T = through(tries(), method, { answered(it) }, call)

    fun init(ctx: Context) {
        current = pick(terminusPrefs(ctx).getString(KEY_SERVER, null), choices)
    }

    fun menuUnlocked(ctx: Context): Boolean =
        menuAlways(BuildConfig.DEBUG, BuildConfig.FLAVOR) || terminusPrefs(ctx).getBoolean(KEY_MENU, false)

    fun unlockMenu(ctx: Context) = terminusPrefs(ctx).edit { putBoolean(KEY_MENU, true) }

    /**
     * Switch to [to]. Between the site's addresses it's the same server and the same sign-in. To or from the stub, the sign-in is set aside
     * and the other side's put back ([Store.swapSession]): a real account's token never goes to the stub, which is plain HTTP. True when
     * the session changed, so the app has to start again.
     */
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

    /** Store's prefs file; a sign-out keeps both (Store.clear). */
    const val KEY_SERVER = "server"
    const val KEY_MENU = "developer-menu"
}
