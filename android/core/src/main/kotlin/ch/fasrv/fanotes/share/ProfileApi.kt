package ch.fasrv.fanotes.share

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import java.security.SecureRandom
import java.time.Instant
import java.time.ZoneId

/*
 * Public username and activity overview, matching `fanotes/src/lib/sync/profile.ts` and the server
 * `fanotes-site/profile-api.mjs`. The record holds a name, the claim time and the numbers the owner published.
 * Note text, titles and paths never leave the device.
 */

const val PROFILE_API_PATH = "/api/v1/profile"
const val PROFILE_VIEW_PATH = "/user/"
const val PROFILE_MAX_DAYS = 1500

private val USERNAME_PATTERN = Regex("^[a-z0-9](?:[a-z0-9]|[-_](?![_-])){1,22}[a-z0-9]$")
private val OWNER_PATTERN = Regex("^[a-f0-9]{32}$")
private val DAY_PATTERN = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val HEX_COLOR = Regex("^#[0-9a-fA-F]{6}$")
private val RESERVED = setOf(
    "about", "admin", "api", "assets", "css", "download", "fanotes", "favicon",
    "help", "index", "js", "login", "me", "notes", "null", "profile", "public",
    "robots", "root", "settings", "share", "static", "support", "undefined",
    "user", "users", "viewer", "www",
)

/** Themes the server stores. `snow` and `system` are resolved or dropped before the request. */
val PROFILE_SERVER_THEMES = setOf("dark", "light", "midnight", "forest", "aurora", "sepia")

fun normalizeUsername(raw: String?): String? {
    val name = raw?.trim()?.lowercase() ?: return null
    if (!USERNAME_PATTERN.matches(name) || name in RESERVED) return null
    return name
}

fun profileViewUrl(username: String, origin: String = SHARE_ORIGIN) = "${origin.trimEnd('/')}$PROFILE_VIEW_PATH$username"

fun createProfileOwnerId(random: java.util.Random = SecureRandom()): String {
    val bytes = ByteArray(16)
    random.nextBytes(bytes)
    return bytes.joinToString("") { "%02x".format(it) }
}

fun isProfileOwnerId(value: String) = OWNER_PATTERN.matches(value)

/** Why a name was refused, in the wording the desktop uses; null when it is fine. */
fun usernameProblem(raw: String): String? = when {
    raw.isBlank() -> "Zuerst einen Benutzernamen festlegen."
    normalizeUsername(raw) == null -> "Erlaubt sind 3 bis 24 Zeichen: Kleinbuchstaben, Ziffern, - und _."
    else -> null
}

/** What a note contributes to the overview. Only dates and time counters. */
data class ProfileNoteSource(
    val createdAt: String? = null,
    val modifiedAt: String? = null,
    val firstOpenedAt: String? = null,
    val lastOpenedAt: String? = null,
    val lastSavedAt: String? = null,
    val dwellMs: Long = 0,
    val activeDays: List<String> = emptyList(),
    val historyAt: List<String> = emptyList(),
)

data class ProfileActivity(
    val joinedAt: String,
    val noteCount: Int,
    val dwellMs: Long,
    val activeDays: List<String>,
    val dayCounts: Map<String, Int>,
)

/** A stored instant, or null when it is empty or out of the 2000-2100 range. */
fun profileStamp(value: String?): String? {
    if (value.isNullOrEmpty() || value.length > 40) return null
    val instant = runCatching { Instant.parse(value) }.getOrNull() ?: return null
    val year = instant.atZone(ZoneId.of("UTC")).year
    return if (year in 2000..2100) instant.toString() else null
}

/** Calendar day on this device. A stored `YYYY-MM-DD` is kept as written. */
fun profileLocalDay(value: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
    if (value.isNullOrEmpty() || value.length > 40) return null
    if (DAY_PATTERN.matches(value)) return value.takeIf { it.substring(0, 4).toInt() in 2000..2100 }
    val stamp = profileStamp(value) ?: return null
    return Instant.parse(stamp).atZone(zone).toLocalDate().toString()
}

/** Keep the first day, the last day and the shape when there are more days than a request may carry. */
fun capProfileDays(days: Collection<String>, max: Int = PROFILE_MAX_DAYS): List<String> {
    val unique = days.filter { DAY_PATTERN.matches(it) }.toSortedSet().toList()
    if (unique.size <= max) return unique
    val stride = (unique.size - 1).toDouble() / (max - 1)
    return (0 until max).map { unique[Math.round(it * stride).toInt()] }.toSortedSet().toList()
}

fun earlierProfileStamp(left: String?, right: String?): String? {
    val first = profileStamp(left)
    val second = profileStamp(right)
    if (first != null && second != null) return if (first < second) first else second
    return first ?: second
}

/** The earliest real note date. A missing stamp is skipped, so it cannot become "today". */
fun earliestProfileJoinedAt(notes: List<ProfileNoteSource>): String? {
    var best: String? = null
    fun consider(value: String?) {
        val stamp = profileStamp(value) ?: return
        if (best == null || stamp < best!!) best = stamp
    }
    for (note in notes) {
        consider(note.createdAt)
        consider(note.firstOpenedAt)
        for (day in note.activeDays) if (DAY_PATTERN.matches(day)) consider("${day}T00:00:00.000Z")
    }
    return best
}

fun summarizeProfileActivity(notes: List<ProfileNoteSource>, joinedAt: String, zone: ZoneId = ZoneId.systemDefault()): ProfileActivity {
    val days = sortedSetOf<String>()
    val counts = HashMap<String, Int>()
    var dwell = 0L
    for (note in notes) {
        dwell += note.dwellMs.coerceAtLeast(0)
        val seen = note.activeDays.filter { DAY_PATTERN.matches(it) }.toMutableSet()
        for (stamp in listOf(note.createdAt, note.firstOpenedAt, note.lastOpenedAt, note.modifiedAt, note.lastSavedAt) + note.historyAt) {
            profileLocalDay(stamp, zone)?.let { seen += it }
        }
        for (day in seen) {
            days += day
            counts[day] = (counts[day] ?: 0) + 1
        }
    }
    val capped = capProfileDays(days)
    return ProfileActivity(joinedAt, notes.size, dwell, capped, capped.associateWith { counts[it] ?: 1 })
}

data class ProfileClaim(val username: String, val path: String, val link: String, val joinedAt: String, val public: Boolean)

data class PublicProfile(
    val username: String,
    val link: String,
    val joinedAt: String,
    val noteCount: Int,
    val dwellMs: Long,
    val durationLabel: String,
    val activeDays: List<String>,
)

class ProfileException(message: String, val status: Int = 0, val taken: Boolean = false) : Exception(message)

private val JSON_HEADERS = mapOf("Accept" to "application/json", "Content-Type" to "application/json")

private fun profileRequest(origin: String, body: JsonValue.Obj) =
    ShareHttpRequest("PUT", "${origin.trimEnd('/')}$PROFILE_API_PATH", JSON_HEADERS, body.stringify())

private fun obj(body: String): JsonValue.Obj? = runCatching { parseJson(body) as? JsonValue.Obj }.getOrNull()

private fun refuse(response: ShareHttpResponse): Nothing {
    val taken = obj(response.body)?.bool("taken") == true
    throw ProfileException(
        if (taken) "Dieser Benutzername ist schon vergeben." else "Die Übersicht konnte nicht gespeichert werden.",
        response.status,
        taken,
    )
}

private fun owner(username: String, ownerId: String): Pair<String, String> {
    val name = normalizeUsername(username) ?: throw ProfileException("Zuerst einen Benutzernamen festlegen.", 400)
    if (!isProfileOwnerId(ownerId)) throw ProfileException("Die Übersicht konnte nicht gespeichert werden.", 400)
    return name to ownerId
}

fun claimUsername(
    transport: ShareTransport,
    username: String,
    ownerId: String,
    joinedAt: String,
    origin: String = SHARE_ORIGIN,
): ProfileClaim {
    val (name, id) = owner(username, ownerId)
    val body = jsonObject(
        "schemaVersion" to jsonNumber(1.0),
        "action" to jsonString("claim"),
        "username" to jsonString(name),
        "ownerId" to jsonString(id),
        "joinedAt" to jsonString(joinedAt),
    )
    val response = transport.exchange(profileRequest(origin, body))
    if (response.status !in 200..299) refuse(response)
    val parsed = obj(response.body)
    val path = parsed?.string("path").orEmpty()
    if (parsed == null || parsed.string("username") != name || path != "$PROFILE_VIEW_PATH$name" || parsed.string("joinedAt") == null) {
        throw ProfileException("Die Übersicht konnte nicht gespeichert werden.", 502)
    }
    return ProfileClaim(name, path, "${origin.trimEnd('/')}$path", parsed.string("joinedAt")!!, parsed.bool("public") == true)
}

fun publishProfile(
    transport: ShareTransport,
    username: String,
    ownerId: String,
    notes: List<ProfileNoteSource>,
    joinedAt: String? = null,
    theme: String? = null,
    accent: String? = null,
    accentSecondary: String? = null,
    origin: String = SHARE_ORIGIN,
    zone: ZoneId = ZoneId.systemDefault(),
): PublicProfile {
    val (name, id) = owner(username, ownerId)
    val joined = earlierProfileStamp(joinedAt, earliestProfileJoinedAt(notes))
    val activity = summarizeProfileActivity(notes, joined ?: joinedAt.orEmpty(), zone)
    val body = jsonObject(
        "schemaVersion" to jsonNumber(1.0),
        "action" to jsonString("publish"),
        "username" to jsonString(name),
        "ownerId" to jsonString(id),
        "noteCount" to jsonNumber(activity.noteCount.toDouble()),
        "dwellMs" to jsonNumber(activity.dwellMs.toDouble()),
        "activeDays" to JsonValue.Arr(activity.activeDays.map { jsonString(it) as JsonValue }.toMutableList()),
        "dayCounts" to jsonObject(*activity.dayCounts.entries.sortedBy { it.key }.map { it.key to jsonNumber(it.value.toDouble()) as JsonValue? }.toTypedArray()),
    )
    if (joined != null) body.put("joinedAt", jsonString(joined))
    theme?.takeIf { it in PROFILE_SERVER_THEMES }?.let { body.put("theme", jsonString(it)) }
    accent?.takeIf { HEX_COLOR.matches(it) }?.let { body.put("accent", jsonString(it.lowercase())) }
    accentSecondary?.takeIf { HEX_COLOR.matches(it) }?.let { body.put("accentSecondary", jsonString(it.lowercase())) }
    val response = transport.exchange(profileRequest(origin, body))
    if (response.status !in 200..299) refuse(response)
    return parsePublicProfile(response.body, name) ?: throw ProfileException("Die Übersicht konnte nicht gespeichert werden.", 502)
}

fun unpublishProfile(transport: ShareTransport, username: String, ownerId: String, origin: String = SHARE_ORIGIN) {
    val (name, id) = owner(username, ownerId)
    val body = jsonObject(
        "schemaVersion" to jsonNumber(1.0),
        "action" to jsonString("unpublish"),
        "username" to jsonString(name),
        "ownerId" to jsonString(id),
    )
    val response = transport.exchange(profileRequest(origin, body))
    if (response.status !in 200..299) refuse(response)
}

/** `GET /api/v1/profile/<name>`: the public overview, or null when the page is not public. */
fun fetchPublicProfile(transport: ShareTransport, username: String, origin: String = SHARE_ORIGIN): PublicProfile? {
    val name = normalizeUsername(username) ?: return null
    val response = transport.exchange(
        ShareHttpRequest("GET", "${origin.trimEnd('/')}$PROFILE_API_PATH/$name", mapOf("Accept" to "application/json"), ""),
    )
    if (response.status == 404) return null
    if (response.status !in 200..299) throw ProfileException("Die Übersicht konnte nicht geladen werden.", response.status)
    return parsePublicProfile(response.body, name)
}

fun parsePublicProfile(body: String, expectedName: String): PublicProfile? {
    val parsed = obj(body) ?: return null
    if (parsed.bool("public") != true || parsed.string("username") != expectedName) return null
    return PublicProfile(
        username = expectedName,
        link = parsed.string("link").orEmpty(),
        joinedAt = parsed.string("joinedAt").orEmpty(),
        noteCount = parsed.double("noteCount")?.toInt() ?: 0,
        dwellMs = parsed.double("dwellMs")?.toLong() ?: 0,
        durationLabel = parsed.string("durationLabel").orEmpty(),
        activeDays = parsed.array("activeDays")?.items.orEmpty().mapNotNull { (it as? JsonValue.Str)?.value },
    )
}
