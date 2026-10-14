package ch.fasrv.fanotes.sync

import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end sync crypto. This is the JVM form of `fanotes/src/lib/sync/crypto.ts`.
 *
 *   password + salt ──PBKDF2-SHA256 (600 000)──▶ 64 bytes
 *     first 32: wrapping key (AES-256-GCM, never sent)
 *     last 32:  auth key (base64, the only secret the server sees)
 *   vault secret (32 random bytes) wrapped with the wrapping key
 *   vault secret ──HKDF-SHA256──▶ data key (AES-256-GCM) and id key (HMAC-SHA256)
 *
 * File blobs are `12-byte IV ‖ AES-GCM(plaintext)` with the file id as additional data.
 */
const val KDF_ITERATIONS = 600_000
const val KDF_ALGORITHM = "pbkdf2-sha256"
private val HKDF_SALT = "fanotes-sync-v1".toByteArray(StandardCharsets.UTF_8)
private const val GCM_IV_BYTES = 12
private const val GCM_TAG_BITS = 128

data class SyncKdf(val algorithm: String, val iterations: Int, val salt: String)
data class SyncKeyWrap(val iv: String, val data: String)
data class SyncKeys(val data: SecretKeySpec, val id: SecretKeySpec)

private val random = SecureRandom()

fun randomBytes(length: Int): ByteArray {
    val bytes = ByteArray(length)
    random.nextBytes(bytes)
    return bytes
}

fun toBase64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

fun fromBase64(text: String): ByteArray = Base64.getDecoder().decode(text)

fun toHex(bytes: ByteArray): String = buildString(bytes.size * 2) {
    for (byte in bytes) append("%02x".format(byte.toInt() and 0xff))
}

fun sha256Hex(bytes: ByteArray): String = toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

fun newKdf(): SyncKdf = SyncKdf(KDF_ALGORITHM, KDF_ITERATIONS, toBase64(randomBytes(16)))

fun isValidKdf(kdf: SyncKdf): Boolean =
    kdf.algorithm == KDF_ALGORITHM && kdf.iterations in 100_000..5_000_000 && kdf.salt.length >= 20

data class DerivedPassword(val wrappingKey: SecretKeySpec, val authKey: String)

fun deriveFromPassword(password: String, kdf: SyncKdf): DerivedPassword {
    if (!isValidKdf(kdf)) throw IllegalArgumentException("This account's key derivation is not supported.")
    val spec = PBEKeySpec(
        Normalizer.normalize(password, Normalizer.Form.NFKC).toCharArray(),
        fromBase64(kdf.salt),
        kdf.iterations,
        512,
    )
    val bits = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
    spec.clearPassword()
    try {
        val wrapping = SecretKeySpec(bits.copyOfRange(0, 32), "AES")
        val auth = toBase64(bits.copyOfRange(32, 64))
        return DerivedPassword(wrapping, auth)
    } finally {
        bits.fill(0)
    }
}

fun newVaultSecret(): ByteArray = randomBytes(32)

fun wrapVaultSecret(secret: ByteArray, wrappingKey: SecretKeySpec, iv: ByteArray = randomBytes(GCM_IV_BYTES)): SyncKeyWrap {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, iv))
    return SyncKeyWrap(toBase64(iv), toBase64(cipher.doFinal(secret)))
}

fun unwrapVaultSecret(wrap: SyncKeyWrap, wrappingKey: SecretKeySpec): ByteArray {
    try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey, GCMParameterSpec(GCM_TAG_BITS, fromBase64(wrap.iv)))
        return cipher.doFinal(fromBase64(wrap.data))
    } catch (error: Exception) {
        throw IllegalArgumentException("The vault key could not be decrypted with this password.", error)
    }
}

/** HKDF-SHA256 as used by WebCrypto: salt `fanotes-sync-v1`, info `data` or `id`. */
fun hkdfSha256(ikm: ByteArray, info: ByteArray, length: Int = 32, salt: ByteArray = HKDF_SALT): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = mac.doFinal(ikm)
    val okm = ByteArray(length)
    var previous = ByteArray(0)
    var offset = 0
    var counter = 1
    while (offset < length) {
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        mac.update(previous)
        mac.update(info)
        mac.update(counter.toByte())
        previous = mac.doFinal()
        val copy = minOf(previous.size, length - offset)
        previous.copyInto(okm, offset, 0, copy)
        offset += copy
        counter += 1
    }
    prk.fill(0)
    return okm
}

fun deriveSyncKeys(vaultSecret: ByteArray): SyncKeys {
    val data = hkdfSha256(vaultSecret, "data".toByteArray(StandardCharsets.UTF_8))
    val id = hkdfSha256(vaultSecret, "id".toByteArray(StandardCharsets.UTF_8))
    return SyncKeys(SecretKeySpec(data, "AES"), SecretKeySpec(id, "HmacSHA256"))
}

fun fileIdFor(keys: SyncKeys, path: String): String {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(keys.id)
    val normalized = Normalizer.normalize(path, Normalizer.Form.NFC).toByteArray(StandardCharsets.UTF_8)
    return toHex(mac.doFinal(normalized))
}

fun encryptBytes(keys: SyncKeys, fileId: String, plain: ByteArray, iv: ByteArray = randomBytes(GCM_IV_BYTES)): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, keys.data, GCMParameterSpec(GCM_TAG_BITS, iv))
    cipher.updateAAD(fileId.toByteArray(StandardCharsets.UTF_8))
    val encrypted = cipher.doFinal(plain)
    return iv + encrypted
}

fun decryptBytes(keys: SyncKeys, fileId: String, blob: ByteArray): ByteArray {
    if (blob.size < GCM_IV_BYTES + 16) throw IllegalArgumentException("The encrypted content is damaged.")
    try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keys.data, GCMParameterSpec(GCM_TAG_BITS, blob.copyOfRange(0, GCM_IV_BYTES)))
        cipher.updateAAD(fileId.toByteArray(StandardCharsets.UTF_8))
        return cipher.doFinal(blob, GCM_IV_BYTES, blob.size - GCM_IV_BYTES)
    } catch (error: Exception) {
        throw IllegalArgumentException("The content could not be decrypted.", error)
    }
}

data class SyncFileMeta(val path: String, val mtimeMs: Long, val size: Long, val sha256: String)

fun encryptMeta(keys: SyncKeys, fileId: String, meta: SyncFileMeta): String {
    val json = buildString {
        append("{\"path\":")
        append(ch.fasrv.fanotes.json.escapeJson(meta.path))
        append(",\"mtimeMs\":")
        append(meta.mtimeMs)
        append(",\"size\":")
        append(meta.size)
        append(",\"sha256\":")
        append(ch.fasrv.fanotes.json.escapeJson(meta.sha256))
        append('}')
    }
    return toBase64(encryptBytes(keys, fileId, json.toByteArray(StandardCharsets.UTF_8)))
}

fun decryptMeta(keys: SyncKeys, fileId: String, encoded: String): SyncFileMeta {
    val parsed = ch.fasrv.fanotes.json.parseJson(
        decryptBytes(keys, fileId, fromBase64(encoded)).toString(StandardCharsets.UTF_8),
    ) as? ch.fasrv.fanotes.json.JsonValue.Obj ?: throw IllegalArgumentException("File metadata is incomplete.")
    val path = parsed.string("path") ?: throw IllegalArgumentException("File metadata is incomplete.")
    val hash = parsed.string("sha256") ?: throw IllegalArgumentException("File metadata is incomplete.")
    return SyncFileMeta(path, parsed.double("mtimeMs")?.toLong() ?: 0L, parsed.double("size")?.toLong() ?: 0L, hash)
}

fun passwordProblems(password: String): String? {
    if (password.length < 10) return "Das Passwort braucht mindestens 10 Zeichen."
    if (password.length > 256) return "Das Passwort ist zu lang."
    if (Regex("""^(.)\1+$""").matches(password) || Regex("""^(?:0123456789|1234567890|qwertzuiop|asdfghjkl)""", RegexOption.IGNORE_CASE).containsMatchIn(password)) {
        return "Dieses Passwort ist zu leicht zu erraten."
    }
    return null
}
