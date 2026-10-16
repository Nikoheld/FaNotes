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

/** Local check before the desktop password form is sent. */
fun syncPasswordChangeError(next: String, repeat: String): String? {
    if (next != repeat) return "Die beiden neuen Passwörter stimmen nicht überein."
    return passwordProblems(next)
}

const val SYNC_ACCOUNT_MISMATCH = "Die beiden Passwörter stimmen nicht überein."
const val SYNC_ACCOUNT_REGISTERED = "Konto erstellt – dieses Gerät synchronisiert ab jetzt."
const val SYNC_ACCOUNT_SIGNED_IN = "Angemeldet – die Notizen des Kontos werden geholt."
const val SYNC_ACCOUNT_FAILED = "Das hat nicht geklappt."
const val SYNC_ACCOUNT_BUSY = "Schlüssel wird berechnet …"
const val SYNC_ACCOUNT_EMAIL = "E-Mail-Adresse"
const val SYNC_ACCOUNT_EMAIL_HINT = "du@example.com"
const val SYNC_ACCOUNT_PASSWORD = "Passwort"
const val SYNC_ACCOUNT_PASSWORD_HINT = "Mindestens 10 Zeichen"
const val SYNC_ACCOUNT_REPEAT = "Passwort wiederholen"
const val SYNC_ACCOUNT_DEVICE = "Name dieses Geräts"
const val SYNC_ACCOUNT_DEVICE_HINT = "z. B. Laptop"
const val SYNC_ACCOUNT_LOGIN = "Anmelden"
const val SYNC_ACCOUNT_REGISTER = "Konto erstellen"
const val SYNC_ACCOUNT_LOGIN_NOTE = "Bereits vorhandene Notizen bleiben erhalten. Gleichnamige Dateien mit anderem Inhalt werden als Konfliktkopie gesichert."
const val SYNC_ACCOUNT_REGISTER_NOTE = "Aus dem Passwort wird auf diesem Gerät ein Schlüssel abgeleitet (PBKDF2, 600 000 Runden); der Server sieht das Passwort nie."
const val SYNC_ACCOUNT_CALLOUT = "Deine Notizen auf allen Geräten – Ende-zu-Ende verschlüsselt"
const val SYNC_ACCOUNT_CALLOUT_BODY = "Sync verschlüsselt jede Datei auf diesem Gerät mit einem Schlüssel, den nur dein Passwort entsperrt. Der Server speichert ausschließlich Chiffrate und zufällige IDs – weder Inhalte noch Dateinamen sind dort lesbar. Deshalb kann ein vergessenes Passwort nicht zurückgesetzt werden."
const val SYNC_FORM_FIELD_DP = 31
const val SYNC_FORM_FIELD_RADIUS_DP = 7
const val SYNC_FORM_PAD_DP = 9
const val SYNC_MODE_DP = 24
const val SYNC_MODE_RADIUS_DP = 6
const val SYNC_MODE_TRACK_RADIUS_DP = 8
const val SYNC_CALLOUT_RADIUS_DP = 12
const val SYNC_CALLOUT_ICON_DP = 35

/** Register checks the repeat field before the key derivation starts. Login does not. */
fun syncAccountSubmitError(register: Boolean, password: String, repeat: String): String? {
    if (!register) return null
    if (password != repeat) return SYNC_ACCOUNT_MISMATCH
    return passwordProblems(password)
}

fun syncAccountCanSubmit(email: String, password: String, busy: Boolean): Boolean =
    !busy && email.trim().isNotEmpty() && password.isNotEmpty()

fun syncAccountButtonLabel(register: Boolean, busy: Boolean): String = when {
    busy -> SYNC_ACCOUNT_BUSY
    register -> SYNC_ACCOUNT_REGISTER
    else -> SYNC_ACCOUNT_LOGIN
}

fun passwordProblems(password: String): String? {
    if (password.length < 10) return "Das Passwort braucht mindestens 10 Zeichen."
    if (password.length > 256) return "Das Passwort ist zu lang."
    if (Regex("""^(.)\1+$""").matches(password) || Regex("""^(?:0123456789|1234567890|qwertzuiop|asdfghjkl)""", RegexOption.IGNORE_CASE).containsMatchIn(password)) {
        return "Dieses Passwort ist zu leicht zu erraten."
    }
    return null
}
