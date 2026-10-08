package sh.rcn.terminus

import android.content.Context
import androidx.core.content.edit

/**
 * Which server the app talks to. Only ever one built into the app: the
 * site's own addresses (the first is the default) and, in a debug build, the
 * local dev stub. The developer menu (Settings, About) picks one; nothing
 * can add one, so the menu can't send a token anywhere but our own servers.
 *
 * The default is terminus.rcn.sh, not the address people see
 * (terminus.run): it's the one kept for good, so an app that's never
 * updated keeps working whichever address the site moves to.
 */
internal object Servers {
    /** Plain HTTP to this phone or the emulator's host: the dev stub (scripts/dev-stub.mjs). */
    fun isLocal(base: String): Boolean {
        val host = base.substringAfter("://").substringBefore('/').substringBefore(':')
        return base.startsWith("http://") && (host == "localhost" || host == "10.0.2.2")
    }

    /**
     * The servers to choose from: [default] first, then [others] (the
     * site's other addresses), then in a [debug] build the stub, through
     * `adb reverse` or from the emulator.
     */
    fun all(default: String, others: List<String>, debug: Boolean): List<String> =
        (listOf(default) + others + if (debug) listOf("http://localhost:8787", "http://10.0.2.2:8787") else emptyList()).distinct()

    /** The saved choice if it's still one of [all], else the default: a server dropped from the app is never used again. */
    fun pick(saved: String?, all: List<String>): String = saved?.takeIf { it in all } ?: all.first()

    /**
     * The developer menu shows in debug and beta builds; in a stable
     * release, once the version in About is tapped [UNLOCK_TAPS] times.
     */
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
    val base: String get() = current ?: choices.first()

    fun init(ctx: Context) {
        current = pick(terminusPrefs(ctx).getString(KEY_SERVER, null), choices)
    }

    fun menuUnlocked(ctx: Context): Boolean =
        menuAlways(BuildConfig.DEBUG, BuildConfig.FLAVOR) || terminusPrefs(ctx).getBoolean(KEY_MENU, false)

    fun unlockMenu(ctx: Context) = terminusPrefs(ctx).edit { putBoolean(KEY_MENU, true) }

    /**
     * Switch to [to]. Between the site's addresses it's the same server and
     * the same sign-in. To or from the stub, the sign-in is set aside and
     * the other side's put back ([Store.swapSession]): a real account's
     * token never goes to the stub, which is plain HTTP. True when the
     * session changed, so the app has to start again.
     */
    fun choose(ctx: Context, to: String): Boolean {
        require(to in choices) { "not one of this app's servers" }
        val from = base
        if (to == from) return false
        val swap = isLocal(from) != isLocal(to)
        if (swap) Store(ctx).swapSession(toLocal = isLocal(to))
        terminusPrefs(ctx).edit(commit = true) { putString(KEY_SERVER, to) }
        current = to
        return swap
    }

    /** Store's prefs file; a sign-out keeps both (Store.clear). */
    const val KEY_SERVER = "server"
    const val KEY_MENU = "developer-menu"
}
