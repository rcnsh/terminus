package sh.rcn.terminus

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The app's own settings and state on this phone: Store's, and Lang's,
 * Theme's and CardStyle's keys beside them, which a sign-out keeps
 * ([Store.clear]).
 */
internal fun terminusPrefs(ctx: Context): SharedPreferences = ctx.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

/**
 * The device token, encrypted with a key that never leaves the Android
 * Keystore, plus the last answer the widget shows.
 */
class Store(context: Context) {
    private val app = context.applicationContext
    private val prefs = terminusPrefs(context)

    /**
     * Decrypted once per process: the widget reads `paired` on every draw, and
     * a Keystore round trip each time is slow. Written with commit(), so a
     * process killed right after pairing cannot lose the token the server
     * already issued.
     */
    var token: String?
        get() = synchronized(Store) {
            if (!loaded) {
                cached = prefs.getString(KEY_TOKEN, null)?.let { stored ->
                    try {
                        decrypt(stored)
                    } catch (e: Exception) {
                        // Anything else (the Keystore busy) may pass: not
                        // loaded, so the next read tries again.
                        if (!lost(e)) return@synchronized null
                        // The Keystore key is gone or changed (a restore, a
                        // reset of the phone's secure storage): the token can
                        // never be read again. Signed out, then, and said once
                        // (Session), rather than trying it on every draw.
                        prefs.edit(commit = true) { remove(KEY_TOKEN); putString(KEY_SIGNED_OUT, SIGNED_OUT_KEY_LOST) }
                        null
                    }
                }
                loaded = true
            }
            cached
        }
        set(value) = synchronized(Store) {
            // commit, not apply: a process killed right after pairing must not lose it.
            prefs.edit(commit = true) {
                if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, encrypt(value))
                // A new session has no push address on the server yet.
                if (value != cached) remove(KEY_PUSH)
            }
            cached = value
            loaded = true
        }

    val paired: Boolean get() = token != null

    /**
     * The widget's last answer, as the raw JSON plus when it was fetched, and
     * the answer read from it. Read first: an answer this version can't read
     * throws [ParseError] and leaves the good one kept before it, and the
     * back-off, as they were.
     *
     * [askedAtMs]: when its request went out. One asked for before the
     * answer already kept (a slow widget refresh overtaken by the app's)
     * isn't kept, and the newer one is returned in its place.
     *
     * [sentWith]: the token the request went with. Null, and nothing kept,
     * when it's no longer this phone's (signed out, or into another account,
     * while the request was out): a sign-out clears [KEY_ASKED] too, so
     * only this keeps the old account's answer and places off the phone.
     */
    fun saveAnswer(json: JSONObject, fetchedAtMs: Long, sentWith: String, askedAtMs: Long = fetchedAtMs): NextAnswer? {
        val answer = NextAnswer.parse(json)
        synchronized(Store) {
            if (token != sentWith) return null
            // One "asked" later than now is from before the phone's clock went back: not newer.
            val kept = prefs.getLong(KEY_ASKED, 0)
            if (askedAtMs < kept && kept <= System.currentTimeMillis()) lastAnswer()?.let { return it.first }
            // A fresh answer from anywhere (the app, the live notification, a
            // skip) ends a run of failed refreshes, so the back-off starts over,
            // and the widget no longer says Offline over it.
            prefs.edit { putString(KEY_ANSWER, json.toString()).putLong(KEY_FETCHED, fetchedAtMs).putLong(KEY_ASKED, askedAtMs).putInt(KEY_REFRESH_FAILS, 0).remove(KEY_ERROR) }
            // The app shortcuts follow the saved places (a no-op when they
            // haven't changed). Inside the lock: a sign-out's [clear] empties
            // them, and must not be undone by an answer kept just before it.
            runCatching { Shortcuts.update(app, answer.places) }
        }
        return answer
    }

    /**
     * Today's plan (/me/day) as last fetched, for when the phone is offline
     * (OfflineDay), and the plan read from it; one this version can't read
     * throws [ParseError] and isn't kept. Null, and nothing kept, when
     * [sentWith] is no longer this phone's token, as for [saveAnswer].
     */
    fun saveDay(json: JSONObject, fetchedAtMs: Long, sentWith: String): DayPlan? {
        val day = DayPlan.parse(json)
        synchronized(Store) {
            if (token != sentWith) return null
            prefs.edit { putString(KEY_DAY, json.toString()).putLong(KEY_DAY_AT, fetchedAtMs) }
        }
        return day
    }

    /** When the kept day plan was fetched, epoch ms (0: none), without reading it. */
    val dayFetchedAt: Long get() = prefs.getLong(KEY_DAY_AT, 0)

    fun lastDay(): Pair<DayPlan, Long>? {
        val raw = prefs.getString(KEY_DAY, null) ?: return null
        val day = runCatching { DayPlan.parse(JSONObject(raw)) }.getOrNull() ?: return null
        return day to prefs.getLong(KEY_DAY_AT, 0)
    }

    fun lastAnswer(): Pair<NextAnswer, Long>? {
        val raw = prefs.getString(KEY_ANSWER, null) ?: return null
        val answer = runCatching { NextAnswer.parse(JSONObject(raw)) }.getOrNull() ?: return null
        return answer to prefs.getLong(KEY_FETCHED, 0)
    }

    var lastError: String?
        get() = prefs.getString(KEY_ERROR, null)
        set(value) = prefs.edit { putString(KEY_ERROR, value) }

    /** Last time the app asked for the released version, epoch ms. */
    var lastUpdateCheck: Long
        get() = prefs.getLong(KEY_UPDATE_CHECK, 0)
        set(value) = prefs.edit { putLong(KEY_UPDATE_CHECK, value) }

    var latestVersion: String?
        get() = prefs.getString(KEY_LATEST, null)
        set(value) = prefs.edit { putString(KEY_LATEST, value) }

    /** "Notify me when to leave for class". Off until the user turns it on. */
    var leaveAlerts: Boolean
        get() = prefs.getBoolean(KEY_LEAVE_ALERTS, false)
        set(value) = prefs.edit { putBoolean(KEY_LEAVE_ALERTS, value) }

    /** The live notification during your day (LiveService). */
    var liveUpdates: Boolean
        get() = prefs.getBoolean(KEY_LIVE, false)
        set(value) = prefs.edit { putBoolean(KEY_LIVE, value) }

    /** The in-app setup is still to do (a new account); cleared when it's finished or skipped. */
    var needsSetup: Boolean
        get() = prefs.getBoolean(KEY_NEEDS_SETUP, false)
        set(value) = prefs.edit { putBoolean(KEY_NEEDS_SETUP, value) }

    /** A row has been swiped off Today: the app stops pointing out that rows can be. */
    var swipedToday: Boolean
        get() = prefs.getBoolean(KEY_SWIPED_TODAY, false)
        set(value) = prefs.edit { putBoolean(KEY_SWIPED_TODAY, value) }

    /** How many times a Today row has nudged aside to show it can be swiped. */
    var swipePeeks: Int
        get() = prefs.getInt(KEY_SWIPE_PEEKS, 0)
        set(value) = prefs.edit { putInt(KEY_SWIPE_PEEKS, value) }

    /** The account's email as last seen, or null for an account without one. */
    var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit { putString(KEY_EMAIL, value) }

    /**
     * An account with no email, made on this phone ("Get started"). Before
     * this was kept, an account without an email seen here.
     */
    var anonymous: Boolean
        get() = if (prefs.contains(KEY_ANON)) prefs.getBoolean(KEY_ANON, false) else email == null
        set(value) = prefs.edit { putBoolean(KEY_ANON, value) }

    /**
     * Why this phone was last signed out without being asked to ([SIGNED_OUT_REMOVED],
     * [SIGNED_OUT_UNUSED], [SIGNED_OUT_KEY_LOST]), for the welcome screen to
     * say once; read with [takeSignedOut].
     */
    val signedOutReason: String? get() = prefs.getString(KEY_SIGNED_OUT, null)

    fun takeSignedOut(): String? = synchronized(Store) {
        // Reading the token first: a lost key is found out there.
        token
        prefs.getString(KEY_SIGNED_OUT, null)?.also { prefs.edit { remove(KEY_SIGNED_OUT) } }
    }

    /**
     * Anything of an account kept with no token to go with it: a sign-out
     * that stopped halfway, or a token whose key was lost.
     */
    fun hasLeftovers(): Boolean = !paired && !prefs.contains(KEY_TOKEN) && listOf(KEY_ANSWER, KEY_DAY, KEY_EMAIL, KEY_ADDED, KEY_DEST_USE, KEY_PUSH, KEY_ANON).any(prefs::contains)

    /** The class (its start, epoch ms) the last heads-up was for: one per class. */
    var leaveNotifiedFor: Long
        get() = prefs.getLong(KEY_LEAVE_NOTIFIED, 0)
        set(value) = prefs.edit { putLong(KEY_LEAVE_NOTIFIED, value) }

    /** The last moment the trip notification made a sound for ("leave:<class>"). */
    var leaveAlertedMoment: String?
        get() = prefs.getString(KEY_ALERTED, null)
        set(value) = prefs.edit { putString(KEY_ALERTED, value) }

    /** The Firebase token last sent to /me/push, so it's only sent when it changes (or now and then, Push). */
    var pushToken: String?
        get() = prefs.getString(KEY_PUSH, null)
        set(value) = prefs.edit { putString(KEY_PUSH, value) }

    /**
     * Which session [pushToken] was sent with ([Push.tag] of the token): a
     * new session (signed in, paired, signed in again) has none on the
     * server yet, whatever this phone sent before.
     */
    var pushFor: String?
        get() = prefs.getString(KEY_PUSH_FOR, null)
        set(value) = prefs.edit { putString(KEY_PUSH_FOR, value) }

    /** When the server last took [pushToken], epoch ms. */
    var pushSentAt: Long
        get() = prefs.getLong(KEY_PUSH_AT, 0)
        set(value) = prefs.edit { putLong(KEY_PUSH_AT, value) }

    /** When a push last reached this phone, epoch ms. */
    var pushHeardAt: Long
        get() = prefs.getLong(KEY_PUSH_HEARD, 0)
        set(value) = prefs.edit { putLong(KEY_PUSH_HEARD, value) }

    /** When the refresh alarm is next due, epoch ms on the phone's clock (0: none armed). */
    var refreshAlarmAt: Long
        get() = prefs.getLong(KEY_REFRESH_ALARM, 0)
        set(value) = prefs.edit { putLong(KEY_REFRESH_ALARM, value) }

    /** Background refreshes that failed in a row, for the back-off (Refresher). */
    var refreshFailures: Int
        get() = prefs.getInt(KEY_REFRESH_FAILS, 0)
        set(value) = prefs.edit { putInt(KEY_REFRESH_FAILS, value) }

    /** Where you usually go, counted on this phone for the widget's buttons (Destinations). */
    fun destinationUses(): Map<String, Destinations.Use> = Destinations.parse(prefs.getString(KEY_DEST_USE, null))

    /** Places added from "Go somewhere else" (a tab each, and widget buttons), newest first. */
    var addedPlaces: List<Destinations.Dest>
        get() = Destinations.parseAdded(prefs.getString(KEY_ADDED, null))
        set(value) = prefs.edit { putString(KEY_ADDED, Destinations.serialiseAdded(value)) }

    fun noteDestination(dest: Destinations.Dest, now: Long = System.currentTimeMillis()) = synchronized(Store) {
        prefs.edit { putString(KEY_DEST_USE, Destinations.serialise(Destinations.note(destinationUses(), dest, now))) }
    }

    /**
     * A random value only this install knows, put on the app's own intents
     * (widgets, shortcuts) so MainActivity can tell them from another app's:
     * it's exported, so any app can start it.
     */
    val intentKey: String
        get() = synchronized(Store) {
            prefs.getString(KEY_INTENT, null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit(commit = true) { putString(KEY_INTENT, it) } }
        }

    /**
     * The server refused [rejected] (401): the account's things go, as on
     * signing out, but only while it is still this phone's token: one stored
     * since (signed in again meanwhile) stays. Why is kept for the welcome
     * screen ([takeSignedOut]): an account with no email the server deleted
     * after it went unused, or this phone removed from an account. True
     * when it signed out.
     */
    fun signOutIf(rejected: String): Boolean = synchronized(Store) {
        if (token != rejected) return@synchronized false
        val why = if (anonymous) SIGNED_OUT_UNUSED else SIGNED_OUT_REMOVED
        clear()
        prefs.edit(commit = true) { putString(KEY_SIGNED_OUT, why) }
        true
    }

    /**
     * Signing out: the account's things go; the phone's language, theme, the
     * intent key, the server chosen (Servers) and a sign-in set aside for
     * the other side of the dev stub stay.
     */
    fun clear() = synchronized(Store) {
        val keep = listOf(KEY_LANG, KEY_THEME, KEY_INTENT, Servers.KEY_SERVER, KEY_TOKEN_SITE, KEY_TOKEN_LOCAL).associateWith { prefs.getString(it, null) }
        val menu = prefs.getBoolean(Servers.KEY_MENU, false)
        prefs.edit(commit = true) {
            clear()
            for ((k, v) in keep) if (v != null) putString(k, v)
            if (menu) putBoolean(Servers.KEY_MENU, true)
        }
        cached = null
        loaded = true
        // The shortcuts named the old account's places.
        runCatching { Shortcuts.update(app, emptyList()) }
    }

    /**
     * Crossing between the site and the dev stub (Servers.choose): this
     * side's token is set aside, still encrypted, the account's things go as
     * on signing out, and the other side's token, if one was set aside,
     * comes back. So the stub never gets the real account's token.
     */
    fun swapSession(toLocal: Boolean) = synchronized(Store) {
        val (away, back) = if (toLocal) KEY_TOKEN_SITE to KEY_TOKEN_LOCAL else KEY_TOKEN_LOCAL to KEY_TOKEN_SITE
        val mine = prefs.getString(KEY_TOKEN, null)
        val theirs = prefs.getString(back, null)
        clear()
        prefs.edit(commit = true) {
            if (mine != null) putString(away, mine) else remove(away)
            remove(back)
            if (theirs != null) putString(KEY_TOKEN, theirs)
        }
        // Read again, through the Keystore, on next use.
        cached = null
        loaded = false
    }

    private fun key(): SecretKey = synchronized(Store) {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return@synchronized it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        gen.generateKey()
    }

    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val out = c.iv + c.doFinal(plain.toByteArray())
        return Base64.encodeToString(out, Base64.NO_WRAP)
    }

    /** A token that can never be decrypted: the key replaced or invalidated, or the stored value damaged. */
    private fun lost(e: Exception) = e is javax.crypto.BadPaddingException || e is android.security.keystore.KeyPermanentlyInvalidatedException ||
        e is java.security.UnrecoverableKeyException || e is IllegalArgumentException

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
        /** A token set aside while the app talks to the other side of the dev stub (swapSession). */
        private const val KEY_TOKEN_SITE = "token-site"
        private const val KEY_TOKEN_LOCAL = "token-local"
        private const val KEY_INTENT = "intent-key"
        private const val KEY_DAY = "day"
        private const val KEY_DAY_AT = "day-fetched"
        /** Lang.kt's key, in the same file. */
        private const val KEY_LANG = "lang"
        /** Theme.kt's key: Android keeps the night mode itself, so this must outlive a sign-out too. */
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
        private const val KEY_EMAIL = "email"
        private const val KEY_PUSH = "push-token"
        private const val KEY_PUSH_AT = "push-sent-at"
        private const val KEY_PUSH_FOR = "push-for"
        private const val KEY_PUSH_HEARD = "push-heard-at"
        private const val KEY_REFRESH_FAILS = "refresh-failures"
        private const val KEY_REFRESH_ALARM = "refresh-alarm-at"
        private const val KEY_ASKED = "answer-asked"
        private const val KEY_ALERTED = "leave-alerted"
        private const val KEY_SWIPED_TODAY = "swiped-today"
        private const val KEY_SWIPE_PEEKS = "swipe-peeks"
        private const val KEY_ANON = "anonymous"
        private const val KEY_SIGNED_OUT = "signed-out"
    }
}
