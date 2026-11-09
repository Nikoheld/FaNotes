package ch.fasrv.fanotes.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * One connection's credentials (server identity token, school page session, TAM calendar link),
 * sealed with a key that stays in the Android keystore. Each connection has its own file in its
 * slot, so removing a connection removes exactly its secrets.
 */
class ConnectionSecrets(private val context: Context, private val slot: String) {
    private val file get() = slotFile(context, slot, "connection-secrets.bin")

    @Synchronized
    fun get(name: String): String? = readAll()[name]

    /** False when the keystore refused; callers then keep their previous storage. */
    @Synchronized
    fun put(name: String, value: String?): Boolean {
        val all = readAll().toMutableMap()
        if (value == null) all.remove(name) else all[name] = value
        return writeAll(all)
    }

    @Synchronized
    fun clear() { file.delete() }

    private fun readAll(): Map<String, String> {
        val target = file
        if (!target.isFile) return emptyMap()
        return try {
            val bytes = target.readBytes()
            if (bytes.size < 13) return emptyMap()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            val obj = parseJson(cipher.doFinal(bytes, 12, bytes.size - 12).decodeToString()) as? JsonValue.Obj ?: return emptyMap()
            obj.fields.mapNotNull { (key, value) -> (value as? JsonValue.Str)?.value?.let { key to it } }.toMap()
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun writeAll(values: Map<String, String>): Boolean = try {
        val target = file
        if (values.isEmpty()) {
            target.delete()
        } else {
            val json = values.entries.joinToString(",", "{", "}") { (key, value) -> "${escapeJson(key)}:${escapeJson(value)}" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, key())
            val sealed = cipher.iv + cipher.doFinal(json.toByteArray())
            val temporary = java.io.File(target.parentFile, "${target.name}.tmp")
            temporary.writeBytes(sealed)
            if (!temporary.renameTo(target)) { target.writeBytes(sealed); temporary.delete() }
        }
        true
    } catch (_: Exception) {
        false
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ALIAS = "kanti-connection-secrets"
    }
}
