package ch.fasrv.fanotes

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import ch.fasrv.fanotes.sync.SyncHost
import ch.fasrv.fanotes.sync.SyncScanEntry
import ch.fasrv.fanotes.vault.VaultIo
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Sync host over either the app-private directory or a user-selected tree. */
class IoSyncHost(
    private val io: () -> VaultIo,
    private val currentVaultId: () -> String,
    private val stateFile: (String) -> File,
    private val secrets: VaultSecrets,
) : SyncHost {
    override suspend fun vaultId(): String = currentVaultId()

    override suspend fun scan(): List<SyncScanEntry> =
        io().walkFiles().map { SyncScanEntry(it.path, it.size, it.mtimeMs) }

    override suspend fun read(path: String): ByteArray = io().read(path) ?: throw NoSuchElementException(path)

    override suspend fun write(path: String, bytes: ByteArray, mtimeMs: Long): SyncScanEntry {
        io().write(path, bytes)
        return SyncScanEntry(path, bytes.size.toLong(), io().mtime(path).takeIf { it > 0 } ?: mtimeMs)
    }

    override suspend fun remove(path: String) {
        io().delete(path)
    }

    override suspend fun readState(vaultId: String): String? = stateFile(vaultId).takeIf { it.isFile }?.readText()

    override suspend fun writeState(vaultId: String, json: String?) {
        val file = stateFile(vaultId)
        if (json == null) file.delete() else {
            file.parentFile?.mkdirs()
            file.writeText(json)
        }
    }

    override suspend fun readSecrets(): String? = secrets.read()

    override suspend fun writeSecrets(json: String?) {
        secrets.write(json)
    }
}

/** Vault secret and session token, sealed with a key that stays in the Android keystore. */
class VaultSecrets(context: Context) {
    private val file = File(context.filesDir, "sync-secrets.bin")

    fun read(): String? {
        if (!file.isFile) return null
        return try {
            val bytes = file.readBytes()
            if (bytes.size < 13) return null
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.doFinal(bytes, 12, bytes.size - 12).decodeToString()
        } catch (_: Exception) {
            null
        }
    }

    fun write(json: String?) {
        if (json == null) {
            file.delete()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val body = cipher.doFinal(json.toByteArray())
        file.writeBytes(iv + body)
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
        const val ALIAS = "fanotes-sync"
    }
}
