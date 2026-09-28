package sh.rcn.nusbus

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
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
    private val prefs = context.applicationContext.getSharedPreferences("nusbus", Context.MODE_PRIVATE)

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)?.let { runCatching { decrypt(it) }.getOrNull() }
        set(value) {
            prefs.edit().apply {
                if (value == null) remove(KEY_TOKEN) else putString(KEY_TOKEN, encrypt(value))
            }.apply()
        }

    val paired: Boolean get() = token != null

    /** The widget's last answer, as the raw JSON plus when it was fetched. */
    fun saveAnswer(json: JSONObject, fetchedAtMs: Long) {
        prefs.edit().putString(KEY_ANSWER, json.toString()).putLong(KEY_FETCHED, fetchedAtMs).apply()
    }

    fun lastAnswer(): Pair<NextAnswer, Long>? {
        val raw = prefs.getString(KEY_ANSWER, null) ?: return null
        val answer = runCatching { NextAnswer.parse(JSONObject(raw)) }.getOrNull() ?: return null
        return answer to prefs.getLong(KEY_FETCHED, 0)
    }

    var lastError: String?
        get() = prefs.getString(KEY_ERROR, null)
        set(value) = prefs.edit().putString(KEY_ERROR, value).apply()

    fun clear() = prefs.edit().clear().apply()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return gen.generateKey()
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
        const val ALIAS = "nusbus-token"
        const val KEY_TOKEN = "token"
        const val KEY_ANSWER = "answer"
        const val KEY_FETCHED = "fetched"
        const val KEY_ERROR = "error"
    }
}
