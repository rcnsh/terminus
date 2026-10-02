package sh.rcn.terminus

import android.content.Context
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
 * The device token, encrypted with a key that never leaves the Android
 * Keystore, plus the last answer the widget shows.
 */
class Store(context: Context) {
    private val app = context.applicationContext
    private val prefs = context.applicationContext.getSharedPreferences("terminus", Context.MODE_PRIVATE)

    /**
     * Decrypted once per process: the widget reads `paired` on every draw, and
     * a Keystore round trip each time is slow. Written with commit(), so a
     * process killed right after pairing cannot lose the token the server
     * already issued.
     */
    var token: String?
        get() = synchronized(Store) {
            if (!loaded) {
                cached = prefs.getString(KEY_TOKEN, null)?.let { runCatching { decrypt(it) }.getOrNull() }
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

    /** The widget's last answer, as the raw JSON plus when it was fetched. */
    fun saveAnswer(json: JSONObject, fetchedAtMs: Long) {
        prefs.edit { putString(KEY_ANSWER, json.toString()).putLong(KEY_FETCHED, fetchedAtMs) }
        // The app shortcuts follow the saved places (a no-op when they haven't changed).
        runCatching { Shortcuts.update(app, NextAnswer.parse(json).places) }
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

    /** "Notice when I board" (phase 8.1): during a trip the live notification sends the location. Off until turned on. */
    var detectTrips: Boolean
        get() = prefs.getBoolean(KEY_DETECT, false)
        set(value) = prefs.edit { putBoolean(KEY_DETECT, value) }

    /** The in-app setup is still to do (a new account); cleared when it's finished or skipped. */
    var needsSetup: Boolean
        get() = prefs.getBoolean(KEY_NEEDS_SETUP, false)
        set(value) = prefs.edit { putBoolean(KEY_NEEDS_SETUP, value) }

    /** The account's email as last seen, or null for an account without one. */
    var email: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(value) = prefs.edit { putString(KEY_EMAIL, value) }

    /** The class (its start, epoch ms) the last heads-up was for: one per class. */
    var leaveNotifiedFor: Long
        get() = prefs.getLong(KEY_LEAVE_NOTIFIED, 0)
        set(value) = prefs.edit { putLong(KEY_LEAVE_NOTIFIED, value) }

    /** The last moment the trip notification made a sound for ("leave:<class>", "ask:<trip>"). */
    var leaveAlertedMoment: String?
        get() = prefs.getString(KEY_ALERTED, null)
        set(value) = prefs.edit { putString(KEY_ALERTED, value) }

    /** The Firebase token last sent to /me/push, so it's only sent when it changes. */
    var pushToken: String?
        get() = prefs.getString(KEY_PUSH, null)
        set(value) = prefs.edit { putString(KEY_PUSH, value) }

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

    /** Signing out: the account's things go; the phone's language and the intent key stay. */
    fun clear() = synchronized(Store) {
        val keep = listOf(KEY_LANG, KEY_INTENT).associateWith { prefs.getString(it, null) }
        prefs.edit(commit = true) {
            clear()
            for ((k, v) in keep) if (v != null) putString(k, v)
        }
        cached = null
        loaded = true
        // The shortcuts named the old account's places.
        runCatching { Shortcuts.update(app, emptyList()) }
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

    private fun decrypt(stored: String): String {
        val bytes = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 0, 12))
        return String(c.doFinal(bytes, 12, bytes.size - 12))
    }

    private companion object {
        @Volatile var cached: String? = null
        @Volatile var loaded = false
        const val KEY_UPDATE_CHECK = "update-check"
        const val KEY_LATEST = "latest-version"
        const val ALIAS = "terminus-token"
        const val KEY_TOKEN = "token"
        const val KEY_INTENT = "intent-key"
        /** Lang.kt's key, in the same file. */
        const val KEY_LANG = "lang"
        const val KEY_ANSWER = "answer"
        const val KEY_FETCHED = "fetched"
        const val KEY_ERROR = "error"
        const val KEY_LEAVE_ALERTS = "leave-alerts"
        const val KEY_LIVE = "live-updates"
        const val KEY_DETECT = "detect-trips"
        const val KEY_DEST_USE = "destination-uses"
        const val KEY_ADDED = "added-places"
        const val KEY_LEAVE_NOTIFIED = "leave-notified"
        const val KEY_NEEDS_SETUP = "needs-setup"
        const val KEY_EMAIL = "email"
        const val KEY_PUSH = "push-token"
        const val KEY_ALERTED = "leave-alerted"
    }
}
