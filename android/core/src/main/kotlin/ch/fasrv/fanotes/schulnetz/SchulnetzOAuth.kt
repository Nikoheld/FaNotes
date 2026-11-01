package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.parseJson
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

data class PkceSession(
    val verifier: String,
    val challenge: String,
    val state: String,
    val nonce: String,
    val authorizeUrl: String,
    val baseUrl: String,
)

data class SchulnetzTokens(
    val accessToken: String,
    val refreshToken: String,
    val expiresInSeconds: Long?,
    val error: String?,
)

private val PKCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

fun pkceRandom(length: Int): String {
    val random = SecureRandom()
    return buildString(length) {
        repeat(length) { append(PKCE_ALPHABET[random.nextInt(PKCE_ALPHABET.length)]) }
    }
}

fun schulnetzDeviceId(bytes: ByteArray = randomDeviceBytes()): String {
    require(bytes.size == 12) { "A Schulnetz device id is 12 bytes." }
    return bytes.joinToString("") { "%02x".format(it) }
}

private fun randomDeviceBytes(): ByteArray = ByteArray(12).also { SecureRandom().nextBytes(it) }

fun createPkceSession(baseUrl: String, random: (Int) -> String = ::pkceRandom): PkceSession {
    val verifier = random(128)
    require(verifier.length in 43..128) { "PKCE verifier length" }
    val challenge = pkceChallenge(verifier)
    val state = random(32)
    val nonce = random(32)
    val root = baseUrl.trim().trimEnd('/')
    val query = listOf(
        "response_type" to "code",
        "client_id" to SCHULNETZ_CLIENT_ID,
        "state" to state,
        "redirect_uri" to "",
        "scope" to "openid ",
        "nonce" to nonce,
        "code_challenge" to challenge,
        "code_challenge_method" to "S256",
    ).joinToString("&") { (key, value) -> "$key=${oauthEncode(value)}" }
    return PkceSession(verifier, challenge, state, nonce, "$root/authorize.php?$query", root)
}

fun pkceChallenge(verifier: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8))
    return Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
}

/** Authorization code and state from a redirect URL, or null when this navigation is not the callback. */
fun authorizationCodeFromUrl(url: String): Pair<String, String?>? {
    if (!url.contains("code=")) return null
    val query = url.substringAfter('?', "").substringBefore('#')
    if (query.isEmpty()) return null
    val params = query.split('&').mapNotNull { part ->
        val cut = part.indexOf('=')
        if (cut <= 0) null else oauthDecode(part.substring(0, cut)) to oauthDecode(part.substring(cut + 1))
    }.toMap()
    val code = params["code"]?.takeIf { it.isNotBlank() } ?: return null
    return code to params["state"]
}

/**
 * Microsoft wraps the original query in `{32-hex}{base64}`. Direct equality still works
 * when Schulnetz returns the state unchanged.
 */
fun stateMatches(expected: String, received: String?): Boolean {
    if (received.isNullOrBlank() || expected.isBlank()) return false
    val value = oauthDecode(received)
    if (value == expected) return true
    val upper = minOf(64, value.length)
    for (split in 32 until upper) {
        val decoded = decodeStateBlob(value.substring(split)) ?: continue
        if (queryParam(decoded, "state") == expected) return true
    }
    return false
}

fun authorizationCodeForm(code: String, verifier: String, deviceId: String): String = form(
    "grant_type" to "authorization_code",
    "code" to code,
    "redirect_uri" to "",
    "code_verifier" to verifier,
    "client_id" to SCHULNETZ_CLIENT_ID,
    "device_id" to deviceId,
)

fun refreshTokenForm(refreshToken: String, deviceId: String): String = form(
    "grant_type" to "refresh_token",
    "refresh_token" to refreshToken,
    "client_id" to SCHULNETZ_CLIENT_ID,
    "device_id" to deviceId,
)

fun parseTokenJson(json: String): SchulnetzTokens {
    val obj = parseJson(json) as? JsonValue.Obj ?: return SchulnetzTokens("", "", null, "invalid")
    val error = obj.string("error")
    val access = obj.string("access_token").orEmpty()
    val refresh = obj.string("refresh_token").orEmpty()
    val expires = obj.double("expires_in")?.toLong()
    return SchulnetzTokens(access, refresh, expires, error)
}

private fun form(vararg pairs: Pair<String, String>): String =
    pairs.joinToString("&") { (key, value) -> "$key=${oauthEncode(value)}" }

private fun oauthEncode(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")

private fun oauthDecode(value: String): String =
    runCatching { URLDecoder.decode(value, Charsets.UTF_8) }.getOrDefault(value)

private fun queryParam(decoded: String, name: String): String? =
    decoded.split('&').firstNotNullOfOrNull { part ->
        val cut = part.indexOf('=')
        if (cut <= 0) null else {
            val key = oauthDecode(part.substring(0, cut))
            if (key == name) oauthDecode(part.substring(cut + 1)) else null
        }
    }

private fun decodeStateBlob(blob: String): String? {
    val pad = blob + "=".repeat((4 - blob.length % 4) % 4)
    val standard = runCatching { Base64.getDecoder().decode(pad).toString(Charsets.UTF_8) }.getOrNull()
    if (standard?.contains("state=") == true) return standard
    return runCatching { Base64.getUrlDecoder().decode(pad).toString(Charsets.UTF_8) }
        .getOrNull()
        ?.takeIf { it.contains("state=") }
}
