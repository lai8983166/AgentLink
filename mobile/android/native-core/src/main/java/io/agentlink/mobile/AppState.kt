package io.agentlink.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Connection(val url: String, val token: String, val id: String)

/** 配对凭据由 Android Keystore 加密；禁止系统备份，安装包中不包含个人凭据。 */
class AppState(context: Context) {
    val prefs = context.getSharedPreferences("agentlink", Context.MODE_PRIVATE)
    var enabled: Boolean
        get() = prefs.getBoolean("enabled", false)
        set(value) { check(prefs.edit().putBoolean("enabled", value).commit()) }
    fun deviceId(): String {
        prefs.getString("deviceId", null)?.let { return it }
        return UUID.randomUUID().toString().also { check(prefs.edit().putString("deviceId", it).commit()) }
    }
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("agentlink-pairing", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("agentlink-pairing", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun save(connection: Connection) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val json = JSONObject().put("url", connection.url).put("token", connection.token).put("id", connection.id)
        val bytes = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("credentials", Base64.encodeToString(cipher.iv + bytes, Base64.NO_WRAP)).commit())
    }
    fun connection(): Connection? {
        val encoded = prefs.getString("credentials", null) ?: return null
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        val json = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        return Connection(json.getString("url"), json.getString("token"), json.getString("id"))
    }
    fun message(value: String) { prefs.edit().putString("state", value).apply() }
    fun clear() { check(prefs.edit().remove("credentials").putBoolean("enabled", false).commit()) }
    fun seen(id: String): Boolean = (prefs.getString("seen", "") ?: "").split(',').contains(id)
    fun delivered(id: String) {
        val ids = (prefs.getString("seen", "") ?: "").split(',').filter { it.isNotBlank() && it != id }.takeLast(199) + id
        check(prefs.edit().putString("seen", ids.joinToString(",")).putLong("lastDeliveredAt", System.currentTimeMillis()).commit())
    }
}
