package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import java.time.Instant

/*
 * Kanti+ im Browser (schulnetz.fasrv.ch). The browser cannot sign in to a school itself, so it
 * borrows connections the app already has: the browser shows a pairing code, the user enters it
 * here and picks the connections to share. Each shared connection adds itself to the pairing with
 * its own server identity. See fanotes-site/kanti-web/README.md for the server side.
 */

/** Where the web app lives; shown in the settings section. */
const val WEB_APP_HOST = "schulnetz.fasrv.ch"

/** Crockford base32 without I, L, O and U. The browser's code uses only these. */
const val WEB_PAIR_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const val WEB_PAIR_LENGTH = 8

/**
 * The 8 code characters, or null when [raw] is not a code. Case, spaces and dashes do not matter;
 * O reads as 0 and I or L as 1, the way people copy a code.
 */
fun normalizePairCode(raw: String?): String? {
    val cleaned = raw.orEmpty().uppercase()
        .filterNot { it == ' ' || it == '-' || it == ' ' || it == '\t' }
        .map { when (it) { 'O' -> '0'; 'I', 'L' -> '1'; else -> it } }
        .joinToString("")
    if (cleaned.length != WEB_PAIR_LENGTH || cleaned.any { it !in WEB_PAIR_ALPHABET }) return null
    return cleaned
}

/** XXXX-XXXX, the way the browser shows it and the server takes it. */
fun displayPairCode(code: String): String =
    if (code.length == WEB_PAIR_LENGTH) "${code.substring(0, 4)}-${code.substring(4)}" else code

/** What the server says about a pairing the user is about to approve. */
data class WebPairInfo(val browser: String, val expiresAt: String, val added: Int)

fun parseWebPairInfo(json: String): WebPairInfo? {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    return WebPairInfo(
        browser = obj.string("browser").orEmpty().take(120),
        expiresAt = obj.string("expiresAt").orEmpty(),
        added = obj.double("added")?.toInt() ?: 0,
    )
}

/** Body of POST /web-pair for one connection. [finish] is true on the last connection only. */
fun webPairBody(code: String, connectionId: String, label: String, provider: SchoolProvider, finish: Boolean, unrevealed: Collection<String>): String = buildString {
    append("{\"code\":").append(escapeJson(displayPairCode(code)))
    append(",\"connectionId\":").append(escapeJson(connectionId))
    append(",\"label\":").append(escapeJson(label.take(40)))
    append(",\"provider\":").append(escapeJson(provider.wire))
    append(",\"finish\":").append(finish)
    append(",\"unrevealed\":[")
    append(unrevealed.filter { it.isNotBlank() }.distinct().sorted().take(MAX_LEDGER_IDS).joinToString(",") { escapeJson(it) })
    append("]}")
}

/** Body of PUT /link for a connection read on the device (TAM): no school secret, never polled. */
fun deviceLinkBody(baseUrl: String, deviceId: String, displayName: String): String = buildString {
    append("{\"mode\":\"device\",\"provider\":\"tam\"")
    append(",\"baseUrl\":").append(escapeJson(baseUrl))
    append(",\"deviceId\":").append(escapeJson(deviceId))
    append(",\"displayName\":").append(escapeJson(displayName.take(80)))
    append('}')
}

/** One browser that can read a connection. */
data class WebBrowserSession(val id: String, val browser: String, val createdAt: String, val lastSeenAt: String)

fun parseWebSessions(json: String): List<WebBrowserSession> {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return emptyList()
    return obj.array("sessions")?.items.orEmpty().mapNotNull { item ->
        val row = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = row.string("id").orEmpty()
        if (!id.matches(Regex("^[A-Za-z0-9_-]{6,64}$"))) return@mapNotNull null
        WebBrowserSession(id, row.string("browser").orEmpty().take(120), row.string("createdAt").orEmpty(), row.string("lastSeenAt").orEmpty())
    }
}

/** Why a pairing step failed, from the server's status code (0 = no answer). */
enum class WebPairFailure { UNKNOWN_CODE, ALREADY_FINISHED, TOO_MANY_TRIES, TOO_MANY_CONNECTIONS, OFFLINE, OTHER }

fun webPairFailure(status: Int): WebPairFailure = when (status) {
    404, 410 -> WebPairFailure.UNKNOWN_CODE
    409 -> WebPairFailure.ALREADY_FINISHED
    429 -> WebPairFailure.TOO_MANY_TRIES
    400, 413 -> WebPairFailure.TOO_MANY_CONNECTIONS
    0 -> WebPairFailure.OFFLINE
    else -> WebPairFailure.OTHER
}

/*
 * Alert settings are shared with the browser through the server. The app stays the source of a
 * change it made itself until the server confirmed it; a newer server stamp means someone changed
 * the settings in the browser, and the app takes them over.
 */
enum class SettingsSync { NONE, PUSH, ADOPT }

/**
 * [dirty]: the app changed its settings and the server has not confirmed them yet.
 * [localStamp]: the server's settingsUpdatedAt the app's settings last matched.
 * [serverStamp]: the server's settingsUpdatedAt now (blank on a server without the field).
 */
fun settingsSyncAction(dirty: Boolean, localStamp: String, serverStamp: String): SettingsSync {
    if (dirty) return SettingsSync.PUSH
    val server = parseStamp(serverStamp) ?: return SettingsSync.NONE
    val local = parseStamp(localStamp) ?: return SettingsSync.ADOPT
    return if (server.isAfter(local)) SettingsSync.ADOPT else SettingsSync.NONE
}

private fun parseStamp(raw: String): Instant? = raw.trim().takeIf { it.isNotEmpty() }?.let { runCatching { Instant.parse(it) }.getOrNull() }

/** The server's hidden-grade ledger for one connection. */
data class RevealLedger(val hidden: Set<String> = emptySet(), val revealed: Set<String> = emptySet())

const val MAX_LEDGER_IDS = 2000

fun parseRevealLedger(json: String): RevealLedger? {
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    fun ids(name: String): Set<String> = obj.array(name)?.items.orEmpty()
        .mapNotNull { (it as? JsonValue.Str)?.value?.takeIf { id -> id.isNotBlank() && id.length <= 200 } }
        .take(MAX_LEDGER_IDS).toSet()
    return RevealLedger(ids("hidden"), ids("revealed"))
}

fun revealsBody(hidden: Collection<String>, revealed: Collection<String>): String {
    fun list(ids: Collection<String>) = ids.filter { it.isNotBlank() }.distinct().sorted().take(MAX_LEDGER_IDS).joinToString(",") { escapeJson(it) }
    return "{\"hidden\":[${list(hidden)}],\"revealed\":[${list(revealed)}]}"
}

/**
 * The merge after a read. [local]: ids the app hides. [pendingRevealed]: ids revealed on this phone
 * that the server has not confirmed yet (they stay revealed). [known]: grade ids this phone held
 * before the read; only used on the [firstSync]. The result is what the app hides now and what it
 * still has to tell the server.
 */
data class RevealMerge(val local: Set<String>, val pushHidden: Set<String>, val pushRevealed: Set<String>) {
    val needsPush: Boolean get() = pushHidden.isNotEmpty() || pushRevealed.isNotEmpty()
}

fun mergeReveals(
    local: Set<String>,
    pendingRevealed: Set<String>,
    server: RevealLedger,
    firstSync: Boolean = false,
    known: Set<String> = emptySet(),
): RevealMerge {
    // The first sync after an update: a grade this phone already had and does not hide was revealed
    // here (or arrived while hiding was off). It stays shown, and the server learns that.
    val shownHere = if (firstSync) (server.hidden - local).intersect(known) else emptySet()
    val revealed = server.revealed + pendingRevealed + shownHere
    val next = (local + (server.hidden - pendingRevealed - shownHere)) - revealed
    return RevealMerge(
        local = next,
        pushHidden = next - server.hidden,
        pushRevealed = (pendingRevealed + shownHere) - server.revealed,
    )
}
