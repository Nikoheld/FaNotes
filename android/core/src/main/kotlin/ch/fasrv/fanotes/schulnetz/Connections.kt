package ch.fasrv.fanotes.schulnetz

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.escapeJson
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.sync.sha256Hex
import java.net.URI

/*
 * Several school connections in one app (different schools, different accounts, different
 * platforms). Each connection has a storage slot. The first connection's slot is "", which keeps the
 * app's original preference keys, file names and vault paths: an install from before multi-connection
 * support becomes connection one without anything being moved or logged out. Every further
 * connection gets its own slot, and everything it stores is namespaced by that slot.
 */

/** The school platform a connection reads from. */
enum class SchoolProvider(val wire: String) {
    SCHULNETZ("schulnetz"),
    TAM("tam");

    companion object {
        fun of(raw: String?): SchoolProvider = entries.firstOrNull { it.wire == raw?.trim()?.lowercase() } ?: SCHULNETZ
    }
}

/** The original storage: preference keys, files and vault paths without any namespace. */
const val PRIMARY_SLOT = ""

/** At most this many connections; each one is a full read on every refresh. */
const val MAX_CONNECTIONS = 6

data class SchoolConnection(
    val id: String,
    val provider: SchoolProvider,
    val label: String,
    /** Schulnetz base (https://www.schulnetz-ag.ch/aksa) or TAM school root (https://intranet.tam.ch/bmz). */
    val baseUrl: String,
    val slot: String,
    val createdAt: String = "",
) {
    val primary: Boolean get() = slot == PRIMARY_SLOT
}

data class ConnectionRegistry(
    val connections: List<SchoolConnection> = emptyList(),
    val activeId: String = "",
) {
    /** The connection the app shows; the first one when the stored id is gone. */
    val active: SchoolConnection? get() = connections.firstOrNull { it.id == activeId } ?: connections.firstOrNull()

    fun byId(id: String): SchoolConnection? = connections.firstOrNull { it.id == id }

    fun bySlot(slot: String): SchoolConnection? = connections.firstOrNull { it.slot == slot }

    /**
     * Adds a connection and makes it active. It takes the original slot when that is free (first
     * connection, or after connection one was removed), otherwise a slot of its own.
     */
    fun add(provider: SchoolProvider, label: String, baseUrl: String, newId: String, now: String): Pair<ConnectionRegistry, SchoolConnection> {
        require(connections.size < MAX_CONNECTIONS) { "too many connections" }
        require(newId.matches(CONNECTION_ID) && byId(newId) == null) { "bad connection id" }
        val slot = if (bySlot(PRIMARY_SLOT) == null) PRIMARY_SLOT else "c$newId"
        val connection = SchoolConnection(newId, provider, cleanLabel(label).ifBlank { defaultConnectionLabel(provider, baseUrl) }, baseUrl, slot, now)
        return copy(connections = connections + connection, activeId = newId) to connection
    }

    fun rename(id: String, label: String): ConnectionRegistry {
        val clean = cleanLabel(label)
        if (clean.isBlank()) return this
        return copy(connections = connections.map { if (it.id == id) it.copy(label = clean) else it })
    }

    fun withBaseUrl(id: String, baseUrl: String): ConnectionRegistry =
        copy(connections = connections.map { if (it.id == id) it.copy(baseUrl = baseUrl) else it })

    /** Removes a connection; when it was active, the first remaining one becomes active. */
    fun remove(id: String): ConnectionRegistry {
        val rest = connections.filterNot { it.id == id }
        return ConnectionRegistry(rest, if (activeId == id || rest.none { it.id == activeId }) rest.firstOrNull()?.id.orEmpty() else activeId)
    }

    fun activate(id: String): ConnectionRegistry = if (byId(id) == null) this else copy(activeId = id)

    fun toJson(): String = buildString {
        append("{\"version\":1,\"active\":").append(escapeJson(activeId)).append(",\"connections\":[")
        connections.forEachIndexed { index, c ->
            if (index > 0) append(',')
            append("{\"id\":").append(escapeJson(c.id))
            append(",\"provider\":").append(escapeJson(c.provider.wire))
            append(",\"label\":").append(escapeJson(c.label))
            append(",\"baseUrl\":").append(escapeJson(c.baseUrl))
            append(",\"slot\":").append(escapeJson(c.slot))
            append(",\"createdAt\":").append(escapeJson(c.createdAt))
            append('}')
        }
        append("]}")
    }
}

private val CONNECTION_ID = Regex("^[a-z0-9]{6,24}$")
private val SLOT = Regex("^(|c[a-z0-9]{6,24})$")

private fun cleanLabel(raw: String): String = raw.replace(Regex("""[\u0000-\u001f]"""), " ").replace(Regex("""\s+"""), " ").trim().take(40)

/** A stored registry, or null when there is none or it cannot be read. Broken entries are dropped. */
fun parseConnectionRegistry(json: String?): ConnectionRegistry? {
    if (json.isNullOrBlank()) return null
    val obj = runCatching { parseJson(json) as? JsonValue.Obj }.getOrNull() ?: return null
    val seenIds = mutableSetOf<String>()
    val seenSlots = mutableSetOf<String>()
    val connections = obj.array("connections")?.items.orEmpty().mapNotNull { item ->
        val c = item as? JsonValue.Obj ?: return@mapNotNull null
        val id = c.string("id").orEmpty()
        val slot = c.string("slot").orEmpty()
        if (!id.matches(CONNECTION_ID) || !slot.matches(SLOT) || !seenIds.add(id) || !seenSlots.add(slot)) return@mapNotNull null
        val provider = SchoolProvider.of(c.string("provider"))
        val base = c.string("baseUrl").orEmpty()
        SchoolConnection(id, provider, cleanLabel(c.string("label").orEmpty()).ifBlank { defaultConnectionLabel(provider, base) }, base, slot, c.string("createdAt").orEmpty())
    }.take(MAX_CONNECTIONS)
    return ConnectionRegistry(connections, obj.string("active").orEmpty())
}

/**
 * The registry on the first start of a multi-connection version. An install that already had a
 * school connection gets it as connection one, in the original slot, with its school address;
 * nothing is moved and the session stays signed in. An install that never connected starts empty.
 */
fun migrateConnections(stored: String?, legacyBaseUrl: String?, legacyConnected: Boolean, newId: String, now: String): ConnectionRegistry {
    parseConnectionRegistry(stored)?.let { return it }
    if (!legacyConnected) return ConnectionRegistry()
    val base = legacyBaseUrl?.takeIf { it.isNotBlank() } ?: AKSA_SCHULNETZ_BASE
    return ConnectionRegistry().add(SchoolProvider.SCHULNETZ, "", base, newId, now).first
}

/** "Schulnetz AKSA", "TAM BMZ": the school part of the address, until the user renames it. */
fun defaultConnectionLabel(provider: SchoolProvider, baseUrl: String): String {
    val path = runCatching { URI(baseUrl).path }.getOrNull().orEmpty().trim('/').substringBefore('/')
    val school = path.uppercase().take(16)
    val platform = when (provider) {
        SchoolProvider.SCHULNETZ -> "Schulnetz"
        SchoolProvider.TAM -> "TAM"
    }
    return if (school.isBlank()) platform else "$platform $school"
}

/** Preference key of [key] in [slot]. */
fun slotKey(slot: String, key: String): String = if (slot == PRIMARY_SLOT) key else "$key@$slot"

/** File (relative to the app's files dir) of [name] in [slot]. */
fun slotFileName(slot: String, name: String): String = if (slot == PRIMARY_SLOT) name else "connections/$slot/$name"

/** Vault path of a `.fanotes/schulnetz/` file in [slot]. */
fun slotVaultPath(slot: String, path: String): String =
    if (slot == PRIMARY_SLOT || !path.startsWith(SCHOOL_VAULT_DIR)) path else "${SCHOOL_VAULT_DIR}connections/$slot/${path.removePrefix(SCHOOL_VAULT_DIR)}"

/** Notification identity: the same change in two connections must not replace or dedupe the other. */
fun slotChangeId(slot: String, changeId: String): String = if (slot == PRIMARY_SLOT) changeId else "$slot|$changeId"

/** The WebView profile of a slot. The first connection keeps the app's original cookie jar. */
fun slotWebProfile(slot: String): String? = if (slot == PRIMARY_SLOT) null else "kanti-$slot"

const val SCHOOL_VAULT_DIR = ".fanotes/schulnetz/"

/**
 * Which connection a push belongs to: the server sends this key (a hash of the connection's server
 * identity, so no account id travels through FCM). Same formula as fanotes-site `connectionRouteKey`.
 */
fun connectionRouteKey(accountId: String): String = sha256Hex("kanti-route:$accountId".encodeToByteArray()).take(16)
