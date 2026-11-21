package sh.rcn.terminus

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

internal fun terminusPrefs(ctx: Context): SharedPreferences = ctx.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

class Store(context: Context) {
    private val app = context.applicationContext
    private val prefs = terminusPrefs(context)

    var token: String?
        get() =
            synchronized(Store) {
                if (!loaded) {
                    cached =
                        prefs.getString(KEY_TOKEN, null)?.let { stored ->
                            try {
                                decrypt(stored)
                            } catch (e: Exception) {
                                if (!lost(e)) return@synchronized null
                                prefs.edit(commit = true) {
                                    remove(KEY_TOKEN)
                                    putString(KEY_SIGNED_OUT, SIGNED_OUT_KEY_LOST)
                                }
                                null
                            }
                        }
                    loaded = true
                }
                cached
            }
        set(value) =
            synchronized(Store) {
                prefs.edit(commit = true) {
                    if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, encrypt(value))
                    if (value != cached) remove(KEY_PUSH)
                }
                cached = value
                loaded = true
            }

    val paired: Boolean
        get() = token != null

    fun saveAnswer(json: JSONObject, fetchedAtMs: Long, sentWith: String, askedAtMs: Long = fetchedAtMs): NextAnswer? {
        val answer = NextAnswer.parse(json)
        synchronized(Store) {
            if (token != sentWith) return null
            val kept = prefs.getLong(KEY_ASKED, 0)
            if (askedAtMs < kept && kept <= System.currentTimeMillis())
                lastAnswer()?.let {
                    return it.first
                }
            prefs.edit {
                putString(KEY_ANSWER, json.toString())
                    .putLong(KEY_FETCHED, fetchedAtMs)
                    .putLong(KEY_ASKED, askedAtMs)
                    .putInt(KEY_REFRESH_FAILS, 0)
                    .remove(KEY_ERROR)
            }
            runCatching { Shortcuts.update(app, answer.places) }
        }
        return answer
    }

    fun saveDay(json: JSONObject, fetchedAtMs: Long, sentWith: String, lang: String): DayPlan? {
        val day = DayPlan.parse(json)
        synchronized(Store) {
            if (token != sentWith) return null
            prefs.edit { putString(KEY_DAY, json.toString()).putLong(KEY_DAY_AT, fetchedAtMs).putString(KEY_DAY_LANG, lang) }
        }
        return day
    }

    val dayFetchedAt: Long
        get() = prefs.getLong(KEY_DAY_AT, 0)

    val dayLang: String?
        get() = prefs.getString(KEY_DAY_LANG, null)

    fun lastDay(): Pair<DayPlan, Long>? {
        val raw = prefs.getString(KEY_DAY, null) ?: return null
        val day = runCatching { DayPlan.parse(JSONObject(raw)) }.getOrNull() ?: return null
        return day to prefs.getLong(KEY_DAY_AT, 0)
    }

    fun saveNearby(json: JSONObject, fetchedAtMs: Long, sentWith: String): List<NearbyStop>? {
        val stops = parseNearby(json)
        synchronized(Store) {
            if (token != sentWith) return null
            prefs.edit { putString(KEY_NEARBY, json.toString()).putLong(KEY_NEARBY_AT, fetchedAtMs).remove(KEY_NEARBY_ERROR) }
        }
        return stops
    }

    val nearbyJson: String?
        get() = prefs.getString(KEY_NEARBY, null)

    val nearbyFetchedAt: Long
        get() = prefs.getLong(KEY_NEARBY_AT, 0)

    var nearbyError: String?
        get() = prefs.getString(KEY_NEARBY_ERROR, null)
        set(value) = prefs.edit { putString(KEY_NEARBY_ERROR, value) }

    fun lastAnswer(): Pair<NextAnswer, Long>? {
        val raw = prefs.getString(KEY_ANSWER, null) ?: return null
        val answer = runCatching { NextAnswer.parse(JSONObject(raw)) }.getOrNull() ?: return null
        return answer to prefs.getLong(KEY_FETCHED, 0)
    }

    var lastError: String?
        get() = prefs.getString(KEY_ERROR, null)
        set(value) = prefs.edit { putString(KEY_ERROR, value) }

    var lastUpdateCheck: Long
        get() = prefs.getLong(KEY_UPDATE_CHECK, 0)
        set(value) = prefs.edit { putLong(KEY_UPDATE_CHECK, value) }

    var latestVersion: String?
        get() = prefs.getString(KEY_LATEST, null)
        set(value) = prefs.edit { putString(KEY_LATEST, value) }

    var leaveAlerts: Boolean
        get() = prefs.getBoolean(KEY_LEAVE_ALERTS, false)
        set(value) = prefs.edit { putBoolean(KEY_LEAVE_ALERTS, value) }

    var liveUpdates: Boolean
        get() = prefs.getBoolean(KEY_LIVE, false)
        set(value) = prefs.edit { putBoolean(KEY_LIVE, value) }

    var needsSetup: Boolean
        get() = prefs.getBoolean(KEY_NEEDS_SETUP, false)
        set(value) = prefs.edit { putBoolean(KEY_NEEDS_SETUP, value) }

    var setupUnknown: Boolean
        get() = prefs.getBoolean(KEY_SETUP_UNKNOWN, false)
        set(value) = prefs.edit { putBoolean(KEY_SETUP_UNKNOWN, value) }

    var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit { putString(KEY_EMAIL, value) }

    var anonymous: Boolean
        get() = if (prefs.contains(KEY_ANON)) prefs.getBoolean(KEY_ANON, false) else email == null
        set(value) = prefs.edit { putBoolean(KEY_ANON, value) }

    val signedOutReason: String?
        get() = prefs.getString(KEY_SIGNED_OUT, null)

    fun takeSignedOut(): String? =
        synchronized(Store) {
            token
            prefs.getString(KEY_SIGNED_OUT, null)?.also { prefs.edit { remove(KEY_SIGNED_OUT) } }
        }

    fun hasLeftovers(): Boolean =
        !paired &&
            !prefs.contains(KEY_TOKEN) &&
            listOf(KEY_ANSWER, KEY_DAY, KEY_NEARBY, KEY_EMAIL, KEY_ADDED, KEY_DEST_USE, KEY_PUSH, KEY_ANON).any(prefs::contains)

    fun forgetAnswers() =
        synchronized(Store) {
            prefs.edit(commit = true) { ANSWER_KEYS.forEach { remove(it) } }
            runCatching { Shortcuts.update(app, emptyList()) }
        }

    var leaveNotifiedFor: Long
        get() = prefs.getLong(KEY_LEAVE_NOTIFIED, 0)
        set(value) = prefs.edit { putLong(KEY_LEAVE_NOTIFIED, value) }

    var leaveAlertedMoment: String?
        get() = prefs.getString(KEY_ALERTED, null)
        set(value) = prefs.edit { putString(KEY_ALERTED, value) }

    var pushToken: String?
        get() = prefs.getString(KEY_PUSH, null)
        set(value) = prefs.edit { putString(KEY_PUSH, value) }

    var pushFor: String?
        get() = prefs.getString(KEY_PUSH_FOR, null)
        set(value) = prefs.edit { putString(KEY_PUSH_FOR, value) }

    var pushSentAt: Long
        get() = prefs.getLong(KEY_PUSH_AT, 0)
        set(value) = prefs.edit { putLong(KEY_PUSH_AT, value) }

    var pushHeardAt: Long
        get() = prefs.getLong(KEY_PUSH_HEARD, 0)
        set(value) = prefs.edit { putLong(KEY_PUSH_HEARD, value) }

    var refreshAlarmAt: Long
        get() = prefs.getLong(KEY_REFRESH_ALARM, 0)
        set(value) = prefs.edit { putLong(KEY_REFRESH_ALARM, value) }

    var refreshFailures: Int
        get() = prefs.getInt(KEY_REFRESH_FAILS, 0)
        set(value) = prefs.edit { putInt(KEY_REFRESH_FAILS, value) }

    fun destinationUses(): Map<String, Destinations.Use> = Destinations.parse(prefs.getString(KEY_DEST_USE, null))

    var addedPlaces: List<Destinations.Dest>
        get() = Destinations.parseAdded(prefs.getString(KEY_ADDED, null))
        set(value) = prefs.edit { putString(KEY_ADDED, Destinations.serialiseAdded(value)) }

    fun noteDestination(dest: Destinations.Dest, now: Long = System.currentTimeMillis()) =
        synchronized(Store) {
            prefs.edit { putString(KEY_DEST_USE, Destinations.serialise(Destinations.note(destinationUses(), dest, now))) }
        }

    val intentKey: String
        get() =
            synchronized(Store) {
                prefs.getString(KEY_INTENT, null)
                    ?: java.util.UUID.randomUUID().toString().also { prefs.edit(commit = true) { putString(KEY_INTENT, it) } }
            }

    fun signOutIf(rejected: String): Boolean =
        synchronized(Store) {
            if (token != rejected) return@synchronized false
            val why = if (anonymous) SIGNED_OUT_UNUSED else SIGNED_OUT_REMOVED
            clear()
            prefs.edit(commit = true) { putString(KEY_SIGNED_OUT, why) }
            true
        }

    fun clear() =
        synchronized(Store) {
            val keep =
                listOf(
                        KEY_LANG,
                        KEY_THEME,
                        CardStyle.KEY,
                        NewToNus.KEY,
                        KEY_INTENT,
                        Servers.KEY_SERVER,
                        KEY_TOKEN_SITE,
                        KEY_TOKEN_LOCAL,
                    )
                    .associateWith {
                        prefs.getString(it, null)
                    }
            val menu = prefs.getBoolean(Servers.KEY_MENU, false)
            val crashReports = prefs.getBoolean(CrashReports.KEY_ENABLED, true)
            prefs.edit(commit = true) {
                clear()
                for ((k, v) in keep) if (v != null) putString(k, v)
                if (menu) putBoolean(Servers.KEY_MENU, true)
                if (!crashReports) putBoolean(CrashReports.KEY_ENABLED, false)
            }
            cached = null
            loaded = true
            runCatching { Shortcuts.update(app, emptyList()) }
        }

    fun swapSession(toLocal: Boolean) =
        synchronized(Store) {
            val (away, back) = if (toLocal) KEY_TOKEN_SITE to KEY_TOKEN_LOCAL else KEY_TOKEN_LOCAL to KEY_TOKEN_SITE
            val mine = prefs.getString(KEY_TOKEN, null)
            val theirs = prefs.getString(back, null)
            clear()
            prefs.edit(commit = true) {
                if (mine != null) putString(away, mine) else remove(away)
                remove(back)
                if (theirs != null) putString(KEY_TOKEN, theirs)
            }
            cached = null
            loaded = false
        }

    private fun key(): SecretKey =
        synchronized(Store) {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
                return@synchronized it.secretKey
            }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build()
            )
            gen.generateKey()
        }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    private fun lost(e: Exception) =
        e is javax.crypto.BadPaddingException ||
            e is android.security.keystore.KeyPermanentlyInvalidatedException ||
            e is java.security.UnrecoverableKeyException ||
            e is IllegalArgumentException

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        return String(c.doFinal(bytes, 12, bytes.size - 12))
    }

    companion object {
        const val SIGNED_OUT_REMOVED = "removed"
        const val SIGNED_OUT_UNUSED = "unused"
        const val SIGNED_OUT_KEY_LOST = "key-lost"
        @Volatile private var cached: String? = null
        @Volatile private var loaded = false
        private const val KEY_UPDATE_CHECK = "update-check"
        private const val KEY_LATEST = "latest-version"
        private const val ALIAS = "terminus-token"
        private const val KEY_TOKEN = "token"
        private const val KEY_TOKEN_SITE = "token-site"
        private const val KEY_TOKEN_LOCAL = "token-local"
        private const val KEY_INTENT = "intent-key"
        private const val KEY_DAY = "day"
        private const val KEY_DAY_AT = "day-fetched"
        private const val KEY_DAY_LANG = "day-lang"
        private const val KEY_NEARBY = "nearby"
        private const val KEY_NEARBY_AT = "nearby-fetched"
        private const val KEY_NEARBY_ERROR = "nearby-error"
        private const val KEY_LANG = "lang"
        private const val KEY_THEME = "theme"
        private const val KEY_ANSWER = "answer"
        private const val KEY_FETCHED = "fetched"
        private const val KEY_ERROR = "error"
        private const val KEY_LEAVE_ALERTS = "leave-alerts"
        private const val KEY_LIVE = "live-updates"
        private const val KEY_DEST_USE = "destination-uses"
        private const val KEY_ADDED = "added-places"
        private const val KEY_LEAVE_NOTIFIED = "leave-notified"
        private const val KEY_NEEDS_SETUP = "needs-setup"
        private const val KEY_SETUP_UNKNOWN = "setup-unknown"
        private const val KEY_EMAIL = "email"
        private const val KEY_PUSH = "push-token"
        private const val KEY_PUSH_AT = "push-sent-at"
        private const val KEY_PUSH_FOR = "push-for"
        private const val KEY_PUSH_HEARD = "push-heard-at"
        private const val KEY_REFRESH_FAILS = "refresh-failures"
        private const val KEY_REFRESH_ALARM = "refresh-alarm-at"
        private const val KEY_ASKED = "answer-asked"
        private const val KEY_ALERTED = "leave-alerted"
        private const val KEY_ANON = "anonymous"
        private const val KEY_SIGNED_OUT = "signed-out"

        private val ANSWER_KEYS =
            listOf(
                KEY_ANSWER,
                KEY_FETCHED,
                KEY_ASKED,
                KEY_ERROR,
                KEY_DAY,
                KEY_DAY_AT,
                KEY_DAY_LANG,
                KEY_NEARBY,
                KEY_NEARBY_AT,
                KEY_NEARBY_ERROR,
            )
    }
}
