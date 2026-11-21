package sh.rcn.terminus

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import androidx.annotation.StringRes
import androidx.core.content.edit
import java.util.Locale

object Lang {
    const val AUTO = "auto"
    const val EN = "en"
    const val ZH = "zh"
    val PREFS = listOf(AUTO, EN, ZH)

    private const val KEY = "lang"
    private const val KEY_APPLIED = "lang_applied"

    private fun prefs(ctx: Context) = terminusPrefs(ctx)

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

    fun set(ctx: Context, pref: String) {
        prefs(ctx).edit { putString(KEY, pref) }
        if (Build.VERSION.SDK_INT >= 33) {
            ctx.getSystemService(LocaleManager::class.java)?.applicationLocales =
                if (pref == AUTO) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag(pref))
        }
        L.reset(ctx)
    }

    fun followAccount(ctx: Context, accountLang: String?): Boolean {
        val lang = accountLang?.takeIf { it in PREFS } ?: return false
        val p = prefs(ctx)
        if (p.getString(KEY_APPLIED, null) == lang) return false
        p.edit { putString(KEY_APPLIED, lang) }
        if (pref(ctx) == lang) return false
        set(ctx, lang)
        return true
    }

    fun applied(ctx: Context): String? = prefs(ctx).getString(KEY_APPLIED, null)

    fun noteAccount(ctx: Context, lang: String) = prefs(ctx).edit { putString(KEY_APPLIED, lang) }

    private fun tag(pref: String) = if (pref == ZH) "zh-Hans" else "en"

    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        val pref = prefs(base).getString(KEY, AUTO) ?: AUTO
        if (pref == AUTO) return base
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList(Locale.forLanguageTag(tag(pref))))
        return base.createConfigurationContext(config)
    }

    fun current(ctx: Context): String = if (wrap(ctx).resources.configuration.locales[0].language == "zh") ZH else EN

    fun header(ctx: Context): String = if (current(ctx) == ZH) "zh-Hans" else "en"
}

@android.annotation.SuppressLint("StaticFieldLeak")
object L {
    @Volatile private var lookup: ((Int, Array<out Any>) -> String)? = null
    @Volatile private var app: Context? = null

    fun init(ctx: Context) {
        app = ctx.applicationContext
        reset(ctx)
    }

    fun reset(ctx: Context) {
        val base = app ?: ctx.applicationContext
        val res = Lang.wrap(base)
        lookup = { id, args -> res.getString(id, *args) }
    }

    fun use(f: (Int, Array<out Any>) -> String) {
        lookup = f
    }

    fun s(@StringRes id: Int, vararg args: Any): String = (lookup ?: error("L.init was not called")).invoke(id, args)

    fun header(): String = app?.let { Lang.header(it) } ?: "en"

    val zh: Boolean
        get() = app?.let { Lang.current(it) == Lang.ZH } ?: false
}
