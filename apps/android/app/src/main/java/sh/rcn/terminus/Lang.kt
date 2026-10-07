package sh.rcn.terminus

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.annotation.StringRes
import androidx.core.content.edit
import java.util.Locale

/**
 * Which language terminus speaks (phase 10): English or Simplified Chinese.
 *
 * "auto" follows the phone. A choice made in Settings (or on the first setup
 * screen) is the app's own language: on Android 13+ the system's per-app
 * language, so the system's Settings → Apps → Language shows it too; on 12,
 * where there's no per-app language, a context wrapped by [wrap] at every
 * entry point (the activity, the widgets, the notifications). It's also the
 * account's `lang`, so the Mac and the web follow it, and the server writes
 * its answers in it; [header] tells the server on every request.
 */
object Lang {
    const val AUTO = "auto"
    const val EN = "en"
    const val ZH = "zh"
    val PREFS = listOf(AUTO, EN, ZH)

    private const val KEY = "lang"
    /** The account's lang last applied here, so a choice made on another device is applied once, not over this phone's. */
    private const val KEY_APPLIED = "lang_applied"

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

    /** What this phone was set to: auto, en or zh. */
    fun pref(ctx: Context): String {
        if (Build.VERSION.SDK_INT >= 33) {
            val tags = ctx.getSystemService(LocaleManager::class.java)?.applicationLocales?.toLanguageTags().orEmpty()
            return when {
                tags.isEmpty() -> AUTO
                tags.startsWith("zh") -> ZH
                else -> EN
            }
        }
        return prefs(ctx).getString(KEY, AUTO) ?: AUTO
    }

    /** Sets this phone's language. On 13+ the app redraws in it in place (MainActivity); on 12 the caller recreates the activity. */
    fun set(ctx: Context, pref: String) {
        prefs(ctx).edit { putString(KEY, pref) }
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (pref == AUTO) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag(pref))
        }
        L.reset(ctx)
    }

    /**
     * The account's language, from its profile: applied when it changed since
     * last time (someone chose it on another device), so it never overrides a
     * choice made on this phone after it.
     */
    fun followAccount(ctx: Context, accountLang: String?): Boolean {
        val lang = accountLang?.takeIf { it in PREFS } ?: return false
        val p = prefs(ctx)
        if (p.getString(KEY_APPLIED, null) == lang) return false
        p.edit { putString(KEY_APPLIED, lang) }
        if (pref(ctx) == lang) return false
        set(ctx, lang)
        return true
    }

    /** The account's language as last applied here; null before the first. */
    fun applied(ctx: Context): String? = prefs(ctx).getString(KEY_APPLIED, null)

    /** Remembers a choice made here as the account's, so it isn't applied back. */
    fun noteAccount(ctx: Context, lang: String) = prefs(ctx).edit { putString(KEY_APPLIED, lang) }

    private fun tag(pref: String) = if (pref == ZH) "zh-Hans" else "en"

    /** On Android 12, a context in the chosen language; on 13+ the system does this already. */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        val pref = prefs(base).getString(KEY, AUTO) ?: AUTO
        if (pref == AUTO) return base
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList(Locale.forLanguageTag(tag(pref))))
        return base.createConfigurationContext(config)
    }

    /** The language the app is showing: zh or en. */
    fun current(ctx: Context): String =
        if (wrap(ctx).resources.configuration.locales[0].language == "zh") ZH else EN

    /** Accept-Language for the API: it writes answers, cards and errors in it. */
    fun header(ctx: Context): String = if (current(ctx) == ZH) "zh-Hans" else "en"
}

/**
 * Strings for code that has no Context to hand (the answer's helpers, the
 * ride's "Next: ..."). The app's context in its language; unit tests read
 * strings.xml instead (see StringsTest).
 */
// The application context only, which lives as long as the process: no leak.
@android.annotation.SuppressLint("StaticFieldLeak")
object L {
    @Volatile private var lookup: ((Int, Array<out Any>) -> String)? = null
    @Volatile private var app: Context? = null

    fun init(ctx: Context) {
        app = ctx.applicationContext
        reset(ctx)
    }

    /** After a language change: Android 12's wrapped context is made again. */
    fun reset(ctx: Context) {
        val base = app ?: ctx.applicationContext
        val res = Lang.wrap(base)
        lookup = { id, args -> res.getString(id, *args) }
    }

    /** For unit tests. */
    fun use(f: (Int, Array<out Any>) -> String) {
        lookup = f
    }

    fun s(@StringRes id: Int, vararg args: Any): String =
        (lookup ?: error("L.init was not called")).invoke(id, args)

    /** Accept-Language for every API request. */
    fun header(): String = app?.let { Lang.header(it) } ?: "en"

    /** The language the app is showing. */
    val zh: Boolean get() = app?.let { Lang.current(it) == Lang.ZH } ?: false
}
