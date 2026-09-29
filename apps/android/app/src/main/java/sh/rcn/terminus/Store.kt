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
            }
            cached = value
            loaded = true
        }

    val paired: Boolean get() = token != null

    /** The widget's last answer, as the raw JSON plus when it was fetched. */
    fun saveAnswer(json: JSONObject, fetchedAtMs: Long) {
        prefs.edit { putString(KEY_ANSWER, json.toString()).putLong(KEY_FETCHED, fetchedAtMs) }
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

    /** The class (its start, epoch ms) the last heads-up was for: one per class. */
    var leaveNotifiedFor: Long
        get() = prefs.getLong(KEY_LEAVE_NOTIFIED, 0)
        set(value) = prefs.edit { putLong(KEY_LEAVE_NOTIFIED, value) }

    fun clear() = synchronized(Store) {
        prefs.edit(commit = true) { clear() }
        cached = null
        loaded = true
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
        const val KEY_ANSWER = "answer"
        const val KEY_FETCHED = "fetched"
        const val KEY_ERROR = "error"
        const val KEY_LEAVE_ALERTS = "leave-alerts"
        const val KEY_LIVE = "live-updates"
        const val KEY_LEAVE_NOTIFIED = "leave-notified"
    }
}
