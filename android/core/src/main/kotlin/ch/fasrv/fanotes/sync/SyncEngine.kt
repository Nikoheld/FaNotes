package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

const val AUTO_INTERVAL_MS = 60_000L
const val LOCAL_DEBOUNCE_MS = 2_500L
const val OFFLINE_RETRY_MS = 30_000L
const val MAX_FILE_BYTES = 100L * 1024L * 1024L
private const val MAX_LOG = 120

enum class SyncStatus { UNAVAILABLE, SIGNED_OUT, IDLE, SYNCING, OFFLINE, ERROR, PAUSED }

data class SyncProgress(val phase: String, val done: Int, val total: Int)
data class SyncConflict(val path: String, val copyPath: String, val at: String)
data class SyncLogEntry(val at: String, val level: String, val text: String)

/** The protocol card shows the newest 40 lines, newest first. */
const val SYNC_LOG_VISIBLE = 40
const val SYNC_LOG_MAX_DP = 240
const val SYNC_LOG_TIME_DP = 110

fun visibleSyncLog(log: List<SyncLogEntry>): List<SyncLogEntry> = log.asReversed().take(SYNC_LOG_VISIBLE)

fun syncLogToggleLabel(count: Int, open: Boolean) = if (open) "Einklappen" else "$count Einträge"

fun syncLogTone(level: String) = when (level) {
    "error" -> "danger"
    "warn", "warning" -> "warning"
    else -> "soft"
}
data class SyncAccount(val email: String, val accountId: String, val deviceId: String)
data class SyncScanEntry(val path: String, val size: Long, val mtimeMs: Long)

data class SyncPublicState(
    val status: SyncStatus = SyncStatus.UNAVAILABLE,
    val account: SyncAccount? = null,
    val vaultId: String? = null,
    val lastSyncAt: String? = null,
    val error: String? = null,
    val progress: SyncProgress? = null,
    val pendingLocal: Int = 0,
    val trackedFiles: Int = 0,
    val conflicts: List<SyncConflict> = emptyList(),
    val log: List<SyncLogEntry> = emptyList(),
    val info: SyncAccountInfo? = null,
)

/** Desktop `syncStatusLabel` for the account card and the status line. */
fun syncStatusLabel(state: SyncPublicState): String = when (state.status) {
    SyncStatus.SYNCING -> state.progress?.let { progress ->
        if (progress.total > 0) {
            val verb = when (progress.phase) {
                "pull" -> "Holt"
                "push" -> "Lädt hoch"
                else -> "Prüft"
            }
            "$verb ${progress.done}/${progress.total}"
        } else {
            "Synchronisiert …"
        }
    } ?: "Synchronisiert …"
    SyncStatus.IDLE -> "Synchron"
    SyncStatus.OFFLINE -> "Offline – wartet auf Verbindung"
    SyncStatus.ERROR -> "Sync-Fehler"
    SyncStatus.PAUSED -> "Sync pausiert"
    SyncStatus.SIGNED_OUT -> "Nicht angemeldet"
    SyncStatus.UNAVAILABLE -> "Sync nicht verfügbar"
}

/** Desktop `formatBytes`: two decimals for GB, one for MB, rounded KB. */
fun syncByteLabel(bytes: Long): String = when {
    bytes >= 1024L * 1024L * 1024L -> String.format(Locale.US, "%.2f GB", bytes / (1024.0 * 1024.0 * 1024.0))
    bytes >= 1024L * 1024L -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    bytes >= 1024L -> "${(bytes.toDouble() / 1024.0).roundToInt()} KB"
    else -> "$bytes B"
}

fun syncUsagePercent(bytes: Long, quotaBytes: Long): Int =
    if (quotaBytes <= 0L) 0 else minOf(100, (bytes.toDouble() / quotaBytes * 100.0).roundToInt())

fun syncUsageLabel(files: Int, bytes: Long, quotaBytes: Long): String =
    "$files Dateien · ${syncByteLabel(bytes)} von ${syncByteLabel(quotaBytes)}"

interface SyncHost {
    suspend fun vaultId(): String
    suspend fun scan(): List<SyncScanEntry>
    suspend fun read(path: String): ByteArray
    suspend fun write(path: String, bytes: ByteArray, mtimeMs: Long): SyncScanEntry
    suspend fun remove(path: String)
    suspend fun readState(vaultId: String): String?
    suspend fun writeState(vaultId: String, json: String?)
    suspend fun readSecrets(): String?
    suspend fun writeSecrets(json: String?)
}

class SyncEngineOptions(
    val platform: String = "android",
    val deviceName: () -> String = { "Android tablet" },
    val automatic: () -> Boolean = { true },
    /** True while the note is dirty, so a remote change waits for the next cycle. */
    val isPathBusy: (String) -> Boolean = { false },
    val excludedPrefixes: () -> List<String> = { emptyList() },
    val includeRecognitionModel: () -> Boolean = { false },
    val includeHistory: () -> Boolean = { false },
    val onApplied: (written: List<String>, removed: List<String>) -> Unit = { _, _ -> },
    val onConflict: (SyncConflict) -> Unit = {},
    val onSignedOut: (String) -> Unit = {},
    val now: () -> Long = { System.currentTimeMillis() },
)

private data class LocalBase(val id: String, val revision: Long, val sha256: String, val size: Long, val mtimeMs: Long)

private data class EngineState(
    val accountId: String,
    var cursor: Long,
    var lastSyncAt: String?,
    val files: LinkedHashMap<String, LocalBase>,
    var conflicts: MutableList<SyncConflict>,
)

private data class Secrets(
    val accountId: String,
    val deviceId: String,
    val token: String,
    val expiresAt: String,
    val email: String,
    val vaultSecret: String,
)

/**
 * Pull, then scan, then push. A 409 keeps the server copy on the original path
 * and writes the local bytes beside it as a conflict copy, which the next push
 * uploads so every device ends up with both. See `fanotes/src/lib/sync/engine.ts`.
 *
 * File-table updates run on one engine thread. Downloads and uploads inside a
 * cycle are sequential so a revision cursor cannot move past a deferred note.
 */
class SyncEngine(
    private val api: SyncApi,
    private val options: SyncEngineOptions = SyncEngineOptions(),
) : AutoCloseable {
    private val dispatcher: ExecutorCoroutineDispatcher = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "fanotes-sync").apply { isDaemon = true }
    }.asCoroutineDispatcher()
    private val scope = CoroutineScope(dispatcher + SupervisorJob())
    private val cycleLock = Mutex()
    private val _state = kotlinx.coroutines.flow.MutableStateFlow(SyncPublicState())
    val state: kotlinx.coroutines.flow.StateFlow<SyncPublicState> = _state

    private var host: SyncHost? = null
    private var session: SyncSession? = null
    private var keys: SyncKeys? = null
    private var vaultSecretBase64: String? = null
    private var vaultId: String? = null
    private var engineState: EngineState? = null
    private var disposed = false
    private var queued = false
    private var timer: Job? = null
    private var debounce: Job? = null

    fun attach(host: SyncHost) {
        this.host = host
    }

    suspend fun start() = onEngine {
        val current = host ?: return@onEngine
        disposed = false
        vaultId = current.vaultId()
        val secrets = parseSecrets(current.readSecrets())
        if (secrets == null) {
            publish(state.value.copy(status = SyncStatus.SIGNED_OUT, vaultId = vaultId))
            return@onEngine
        }
        adoptSecrets(secrets)
        log("info", "Signed in as ${secrets.email}.")
        schedule(0)
    }

    suspend fun switchVault() = onEngine {
        val current = host ?: return@onEngine
        vaultId = current.vaultId()
        val active = session
        if (active != null) {
            engineState = parseState(current.readState(vaultId!!), active.accountId)
            publish(state.value.copy(vaultId = vaultId, lastSyncAt = engineState?.lastSyncAt, trackedFiles = engineState?.files?.size ?: 0, conflicts = engineState?.conflicts?.toList() ?: emptyList()))
            schedule(0)
        } else {
            publish(state.value.copy(vaultId = vaultId))
        }
    }

    fun notifyLocalChange() {
        if (session == null || !options.automatic()) return
        debounce?.cancel()
        debounce = scope.launch {
            delay(LOCAL_DEBOUNCE_MS)
            syncNowOnEngine("local-change")
        }
    }

    /** Runs one cycle. Overlapping calls collapse into a single follow-up cycle. */
    suspend fun syncNow(reason: String = "manual") = onEngine { syncNowOnEngine(reason) }

    suspend fun login(email: String, password: String) = onEngine {
        requireHost()
        val normalized = email.trim().lowercase()
        val kdf = api.prelogin(normalized)
        if (!isValidKdf(kdf)) throw IllegalArgumentException("The server sent unsupported key parameters.")
        val derived = deriveFromPassword(password, kdf)
        val result = api.login(normalized, derived.authKey, deviceInfo().first, deviceInfo().second)
        val secret = unwrapVaultSecret(result.vaultKeyWrap, derived.wrappingKey)
        try {
            signInWith(Secrets(result.accountId, result.deviceId, result.token, result.expiresAt, normalized, toBase64(secret)))
        } finally {
            secret.fill(0)
        }
        log("info", "Signed in as $normalized.")
    }

    suspend fun register(email: String, password: String) = onEngine {
        requireHost()
        passwordProblems(password)?.let { throw IllegalArgumentException(it) }
        val normalized = email.trim().lowercase()
        val kdf = newKdf()
        val derived = deriveFromPassword(password, kdf)
        val secret = newVaultSecret()
        try {
            val wrap = wrapVaultSecret(secret, derived.wrappingKey)
            val result = api.register(normalized, derived.authKey, kdf, wrap, deviceInfo().first, deviceInfo().second)
            signInWith(Secrets(result.accountId, result.deviceId, result.token, result.expiresAt, normalized, toBase64(secret)))
        } finally {
            secret.fill(0)
        }
        log("info", "Account created. The vault key was generated on this device.")
    }

    suspend fun changePassword(currentPassword: String, nextPassword: String) = onEngine {
        val active = session ?: throw IllegalStateException("Nicht angemeldet.")
        val secretText = vaultSecretBase64 ?: throw IllegalStateException("Nicht angemeldet.")
        passwordProblems(nextPassword)?.let { throw IllegalArgumentException(it) }
        val currentKdf = api.prelogin(active.email)
        val current = deriveFromPassword(currentPassword, currentKdf)
        val kdf = newKdf()
        val next = deriveFromPassword(nextPassword, kdf)
        val secret = fromBase64(secretText)
        try {
            val wrap = wrapVaultSecret(secret, next.wrappingKey)
            api.changePassword(active, current.authKey, next.authKey, kdf, wrap)
        } finally {
            secret.fill(0)
        }
        log("info", "Passwort geändert; alle anderen Geräte müssen sich neu anmelden.")
    }

    suspend fun deleteAccount(password: String) = onEngine {
        val active = session ?: throw IllegalStateException("Nicht angemeldet.")
        val kdf = api.prelogin(active.email)
        val authKey = deriveFromPassword(password, kdf).authKey
        api.deleteAccount(active, authKey)
        forgetSession()
        log("info", "Konto und alle Daten auf dem Server gelöscht.")
    }

    suspend fun logout() = onEngine {
        requireHost()
        val active = session
        if (active != null) try {
            api.logout(active)
        } catch (_: Exception) {
            // A failed logout still signs out locally. Notes stay on the device.
        }
        forgetSession()
        log("info", "Signed out. Notes stay on this device.")
    }

    suspend fun refreshAccount() = onEngine {
        val active = session ?: return@onEngine null
        try {
            val info = api.account(active)
            publish(state.value.copy(info = info))
            info
        } catch (error: SyncApiError) {
            if (error.unauthorized) handleUnauthorized()
            throw error
        }
    }

    suspend fun removeDevice(deviceId: String) = onEngine {
        val active = session ?: throw IllegalStateException("Not signed in.")
        api.removeDevice(active, deviceId)
        refreshAccountOnEngine()
    }

    fun clearConflicts() {
        scope.launch {
            engineState?.conflicts?.clear()
            persistState()
            publish(state.value.copy(conflicts = emptyList()))
        }
    }

    fun dismissConflict(copyPath: String) {
        scope.launch {
            val current = engineState ?: return@launch
            current.conflicts.removeAll { it.copyPath == copyPath }
            persistState()
            publish(state.value.copy(conflicts = current.conflicts.toList()))
        }
    }

    override fun close() {
        disposed = true
        timer?.cancel()
        debounce?.cancel()
        scope.coroutineContext[Job]?.cancel()
        dispatcher.close()
    }

    private suspend fun refreshAccountOnEngine() {
        val active = session ?: return
        val info = api.account(active)
        publish(state.value.copy(info = info))
    }

    private suspend fun syncNowOnEngine(reason: String) {
        if (session == null || host == null) {
            publish(state.value.copy(status = SyncStatus.SIGNED_OUT, error = "Nicht angemeldet."))
            return
        }
        // Mark the request before waiting. A cycle that is already running
        // sees [queued] and continues; a request that arrives as the lock is
        // released still runs, instead of being acknowledged and dropped.
        queued = true
        publish(state.value.copy(status = SyncStatus.SYNCING, error = null))
        cycleLock.withLock {
            var why = reason
            while (queued && !disposed) {
                queued = false
                runCycle(why)
                why = "queued"
            }
        }
    }

    private suspend fun runCycle(reason: String) {
        if (session == null || host == null || engineState == null || keys == null) return
        publish(state.value.copy(status = SyncStatus.SYNCING, error = null, progress = null))
        try {
            var conflicts = pull()
            val pushed = push()
            if (pushed.conflicts > 0) conflicts += pull()
            engineState?.lastSyncAt = isoNow(options.now())
            persistState()
            publish(state.value.copy(status = SyncStatus.IDLE, progress = null, pendingLocal = 0, lastSyncAt = engineState?.lastSyncAt))
            if (reason != "timer" || pushed.uploads > 0 || pushed.deletes > 0 || conflicts > 0) {
                log("info", "Sync finished (${pushed.uploads} uploaded, ${pushed.deletes} deleted${if (conflicts > 0) ", $conflicts conflict(s)" else ""}).")
            }
            schedule(AUTO_INTERVAL_MS)
        } catch (error: Exception) {
            try {
                persistState()
            } catch (_: Exception) {
                // Keep the status that explains the original failure.
            }
            if (error is SyncApiError && error.unauthorized) {
                handleUnauthorized()
                return
            }
            val offline = error is SyncApiError && error.offline
            val message = error.message ?: "Sync failed."
            publish(state.value.copy(status = if (offline) SyncStatus.OFFLINE else SyncStatus.ERROR, error = message, progress = null))
            log(if (offline) "warn" else "error", message)
            schedule(if (offline) OFFLINE_RETRY_MS else AUTO_INTERVAL_MS)
        }
    }

    private suspend fun pull(): Int {
        val active = session ?: return 0
        val currentHost = host ?: return 0
        val table = engineState ?: return 0
        val syncKeys = keys ?: return 0
        val pending = mutableListOf<SyncRemoteEntry>()
        var since = table.cursor
        var pages = 0
        while (pages < 200) {
            val page = api.changes(active, since)
            pending += page.entries
            since = page.nextSince
            pages += 1
            if (!page.more) break
        }
        if (pending.isEmpty()) return 0
        publish(state.value.copy(progress = SyncProgress("pull", 0, pending.size)))
        val idIndex = table.files.map { (path, base) -> base.id to path }.toMap(linkedMapOf())
        var conflicts = 0
        val written = mutableListOf<String>()
        val removed = mutableListOf<String>()
        var holdCursor = Long.MAX_VALUE
        pending.forEachIndexed { index, entry ->
            val result = applyRemote(entry, idIndex, syncKeys, currentHost, active, table)
            if (result.result == "conflict") conflicts += 1
            if ((result.result == "written" || result.result == "conflict") && result.path != null) written += result.path
            if (result.result == "removed" && result.path != null) removed += result.path
            if (result.result == "deferred") holdCursor = minOf(holdCursor, entry.revision - 1)
            publish(state.value.copy(progress = SyncProgress("pull", index + 1, pending.size)))
        }
        table.cursor = maxOf(table.cursor, minOf(since, holdCursor))
        persistState()
        if (written.isNotEmpty() || removed.isNotEmpty()) options.onApplied(written, removed)
        return conflicts
    }

    private data class ApplyResult(val result: String, val path: String?)

    private suspend fun applyRemote(
        entry: SyncRemoteEntry,
        idIndex: MutableMap<String, String>,
        syncKeys: SyncKeys,
        currentHost: SyncHost,
        active: SyncSession,
        table: EngineState,
    ): ApplyResult {
        val knownPath = idIndex[entry.id]
        if (entry.deleted) {
            if (knownPath == null) return ApplyResult("noop", null)
            val base = table.files[knownPath] ?: return ApplyResult("noop", knownPath)
            if (entry.revision <= base.revision) return ApplyResult("noop", knownPath)
            if (options.isPathBusy(knownPath)) return ApplyResult("deferred", knownPath)
            val local = localSnapshot(knownPath, currentHost)
            if (local == null) {
                table.files.remove(knownPath)
                idIndex.remove(entry.id)
                return ApplyResult("noop", knownPath)
            }
            if (local.sha256 == base.sha256) {
                currentHost.remove(knownPath)
                table.files.remove(knownPath)
                idIndex.remove(entry.id)
                return ApplyResult("removed", knownPath)
            }
            // Edited here after another device deleted it: keep ours and re-upload over the tombstone.
            table.files[knownPath] = base.copy(revision = entry.revision, sha256 = "")
            log("info", "“$knownPath” was deleted elsewhere but changed here. The local copy stays.")
            return ApplyResult("noop", knownPath)
        }
        if (entry.meta.isNullOrEmpty() || entry.sha256.isNullOrEmpty()) return ApplyResult("skipped", null)
        val meta = try {
            decryptMeta(syncKeys, entry.id, entry.meta)
        } catch (error: Exception) {
            log("warn", "Could not decrypt an entry's metadata (${error.message ?: "unknown"}).")
            return ApplyResult("skipped", null)
        }
        val path = meta.path
        if (!acceptsPath(path)) return ApplyResult("skipped", null)
        val base = table.files[path]
        if (base != null && base.id == entry.id && entry.revision <= base.revision) return ApplyResult("noop", path)
        if (options.isPathBusy(path)) return ApplyResult("deferred", path)
        val local = localSnapshot(path, currentHost)
        if (local != null && local.sha256 == meta.sha256) {
            val stat = currentHost.scan().firstOrNull { it.path == path }
            table.files[path] = LocalBase(entry.id, entry.revision, meta.sha256, local.bytes.size.toLong(), stat?.mtimeMs ?: 0L)
            idIndex[entry.id] = path
            return ApplyResult("noop", path)
        }
        val changedLocal = local?.takeIf { base == null || it.sha256 != base.sha256 }
        var result = "written"
        if (changedLocal != null) {
            val at = java.time.Instant.ofEpochMilli(options.now())
            val copyPath = conflictCopyPath(path, deviceInfo().first, at)
            currentHost.write(copyPath, changedLocal.bytes, at.toEpochMilli())
            val conflict = SyncConflict(path, copyPath, isoNow(at.toEpochMilli()))
            table.conflicts.add(conflict)
            if (table.conflicts.size > 50) table.conflicts.removeAt(0)
            log("warn", "Conflict in “$path”. The local copy is now “$copyPath”.")
            options.onConflict(conflict)
            publish(state.value.copy(conflicts = table.conflicts.toList()))
            result = "conflict"
        }
        when (val download = api.download(active, entry.id)) {
            is DownloadResult.Deleted -> return ApplyResult("noop", path)
            is DownloadResult.Blob -> {
                if (sha256Hex(download.bytes) != download.sha256) throw IllegalStateException("“$path” arrived damaged.")
                val plain = decryptBytes(syncKeys, entry.id, download.bytes)
                if (sha256Hex(plain) != meta.sha256) throw IllegalStateException("The checksum of “$path” does not match.")
                val stat = currentHost.write(path, plain, meta.mtimeMs.takeIf { it > 0 } ?: options.now())
                table.files[path] = LocalBase(entry.id, download.revision, meta.sha256, stat.size, stat.mtimeMs)
                idIndex[entry.id] = path
                return ApplyResult(result, path)
            }
        }
    }

    private suspend fun push(): PushResult {
        val currentHost = host ?: return PushResult(0, 0, 0)
        val table = engineState ?: return PushResult(0, 0, 0)
        val syncKeys = keys ?: return PushResult(0, 0, 0)
        val active = session ?: return PushResult(0, 0, 0)
        publish(state.value.copy(progress = SyncProgress("scan", 0, 0)))
        val entries = currentHost.scan().filter { acceptsPath(it.path) }
        val present = entries.map { it.path }.toSet()
        val changed = entries.filter { entry ->
            if (entry.size > MAX_FILE_BYTES) return@filter false
            val base = table.files[entry.path]
            base == null || base.size != entry.size || base.mtimeMs != entry.mtimeMs || entry.mtimeMs == 0L || base.sha256.isEmpty()
        }
        val deleted = table.files.keys.filter { acceptsPath(it) && it !in present }
        publish(state.value.copy(pendingLocal = changed.size + deleted.size, progress = SyncProgress("push", 0, changed.size + deleted.size)))
        var uploads = 0
        var deletes = 0
        var conflicts = 0
        var done = 0
        val total = changed.size + deleted.size
        for (entry in changed) {
            try {
                when (uploadPath(entry, table, syncKeys, active, currentHost)) {
                    "uploaded" -> uploads += 1
                    "conflict" -> conflicts += 1
                }
            } finally {
                done += 1
                publish(state.value.copy(progress = SyncProgress("push", done, total)))
            }
        }
        for (path in deleted) {
            try {
                when (deletePath(path, table, active)) {
                    "deleted" -> deletes += 1
                    "conflict" -> conflicts += 1
                }
            } finally {
                done += 1
                publish(state.value.copy(progress = SyncProgress("push", done, total)))
            }
        }
        persistState()
        return PushResult(uploads, deletes, conflicts)
    }

    private data class PushResult(val uploads: Int, val deletes: Int, val conflicts: Int)

    private suspend fun uploadPath(entry: SyncScanEntry, table: EngineState, syncKeys: SyncKeys, active: SyncSession, currentHost: SyncHost): String {
        val bytes = try {
            currentHost.read(entry.path)
        } catch (_: Exception) {
            return "skipped"
        }
        val hash = sha256Hex(bytes)
        val base = table.files[entry.path]
        if (base != null && base.sha256 == hash) {
            table.files[entry.path] = base.copy(size = entry.size, mtimeMs = entry.mtimeMs)
            return "unchanged"
        }
        val id = base?.id ?: fileIdFor(syncKeys, entry.path)
        val meta = encryptMeta(syncKeys, id, SyncFileMeta(entry.path, entry.mtimeMs, bytes.size.toLong(), hash))
        val blob = encryptBytes(syncKeys, id, bytes)
        return try {
            val revision = api.upload(active, id, base?.revision ?: 0L, meta, sha256Hex(blob), blob)
            table.files[entry.path] = LocalBase(id, revision, hash, entry.size, entry.mtimeMs)
            "uploaded"
        } catch (error: SyncApiError) {
            when {
                error.conflict -> "conflict"
                error.status == 507 -> {
                    log("error", "“${entry.path}” does not fit in the account: ${error.message}")
                    "skipped"
                }
                else -> throw error
            }
        }
    }

    private suspend fun deletePath(path: String, table: EngineState, active: SyncSession): String {
        val base = table.files[path] ?: return "skipped"
        return try {
            api.remove(active, base.id, base.revision)
            table.files.remove(path)
            "deleted"
        } catch (error: SyncApiError) {
            if (error.conflict) {
                table.files.remove(path)
                "conflict"
            } else {
                throw error
            }
        }
    }

    private suspend fun localSnapshot(path: String, currentHost: SyncHost): Snapshot? = try {
        val bytes = currentHost.read(path)
        Snapshot(bytes, sha256Hex(bytes))
    } catch (_: Exception) {
        null
    }

    private data class Snapshot(val bytes: ByteArray, val sha256: String)

    private fun acceptsPath(path: String) = isSyncablePath(
        path,
        SyncPathOptions(options.excludedPrefixes(), options.includeRecognitionModel(), options.includeHistory()),
    )

    private suspend fun signInWith(secrets: Secrets) {
        val current = host
        val id = vaultId ?: current?.vaultId()
        if (current != null && id != null) current.writeState(id, null)
        persistSecrets(secrets)
        adoptSecrets(secrets)
        schedule(0)
    }

    private suspend fun adoptSecrets(secrets: Secrets) {
        val current = host ?: throw IllegalStateException("Sync is not attached.")
        val secret = fromBase64(secrets.vaultSecret)
        keys = deriveSyncKeys(secret)
        secret.fill(0)
        vaultSecretBase64 = secrets.vaultSecret
        session = SyncSession(secrets.accountId, secrets.deviceId, secrets.token, secrets.expiresAt, secrets.email)
        vaultId = vaultId ?: current.vaultId()
        engineState = parseState(current.readState(vaultId!!), secrets.accountId)
        publish(
            state.value.copy(
                status = SyncStatus.IDLE,
                account = SyncAccount(secrets.email, secrets.accountId, secrets.deviceId),
                vaultId = vaultId,
                lastSyncAt = engineState?.lastSyncAt,
                conflicts = engineState?.conflicts?.toList() ?: emptyList(),
                error = null,
                trackedFiles = engineState?.files?.size ?: 0,
            ),
        )
    }

    private suspend fun forgetSession() {
        session = null
        keys = null
        vaultSecretBase64 = null
        engineState = null
        val runningTimer = timer
        timer = null
        if (runningTimer != null && runningTimer != kotlin.coroutines.coroutineContext[Job]) runningTimer.cancel()
        persistSecrets(null)
        val current = host
        val id = vaultId
        if (current != null && id != null) current.writeState(id, null)
        publish(SyncPublicState(status = SyncStatus.SIGNED_OUT, vaultId = id, log = state.value.log))
    }

    private suspend fun handleUnauthorized() {
        val reason = "This sign-in expired or was ended from another device."
        forgetSession()
        publish(state.value.copy(error = reason))
        log("warn", reason)
        options.onSignedOut(reason)
    }

    private fun schedule(delay: Long) {
        if (disposed || session == null) return
        timer?.cancel()
        timer = scope.launch {
            if (delay > 0) delay(delay)
            if (!disposed && (options.automatic() || delay == 0L)) syncNowOnEngine("timer")
            else if (!disposed) schedule(AUTO_INTERVAL_MS)
        }
    }

    private suspend fun persistSecrets(secrets: Secrets?) {
        host?.writeSecrets(secrets?.let { encodeSecrets(it) })
    }

    private suspend fun persistState() {
        val current = host ?: return
        val table = engineState ?: return
        val id = vaultId ?: return
        current.writeState(id, encodeState(table))
        publish(state.value.copy(trackedFiles = table.files.size, conflicts = table.conflicts.toList(), lastSyncAt = table.lastSyncAt))
    }

    private fun deviceInfo(): Pair<String, String> {
        val name = options.deviceName().trim().ifBlank { "Android tablet" }.take(80)
        val platform = options.platform.lowercase().replace(Regex("[^a-z0-9-]"), "").take(24).ifBlank { "android" }
        return name to platform
    }

    private fun requireHost() {
        if (host == null) throw IllegalStateException("Sync is not available in this environment.")
    }

    private fun log(level: String, text: String) {
        val entry = SyncLogEntry(isoNow(options.now()), level, text)
        publish(state.value.copy(log = (state.value.log + entry).takeLast(MAX_LOG)))
    }

    private fun publish(next: SyncPublicState) {
        _state.value = next
    }

    private suspend fun <T> onEngine(block: suspend () -> T): T {
        val done = CompletableDeferred<T>()
        scope.launch {
            try {
                done.complete(block())
            } catch (error: Throwable) {
                done.completeExceptionally(error)
            }
        }
        return done.await()
    }
}

private fun encodeSecrets(secrets: Secrets): String = jsonObject(
    "v" to jsonNumber(1.0),
    "accountId" to jsonString(secrets.accountId),
    "deviceId" to jsonString(secrets.deviceId),
    "token" to jsonString(secrets.token),
    "expiresAt" to jsonString(secrets.expiresAt),
    "email" to jsonString(secrets.email),
    "vaultSecret" to jsonString(secrets.vaultSecret),
).stringify()

private fun parseSecrets(raw: String?): Secrets? {
    if (raw.isNullOrBlank()) return null
    return try {
        val parsed = parseJson(raw) as? JsonValue.Obj ?: return null
        if (parsed.double("v")?.toInt() != 1) return null
        Secrets(
            parsed.string("accountId") ?: return null,
            parsed.string("deviceId") ?: return null,
            parsed.string("token") ?: return null,
            parsed.string("expiresAt") ?: "",
            parsed.string("email") ?: return null,
            parsed.string("vaultSecret") ?: return null,
        )
    } catch (_: Exception) {
        null
    }
}

private fun encodeState(state: EngineState): String {
    val files = JsonValue.Obj()
    for ((path, base) in state.files) {
        files.put(
            path,
            jsonObject(
                "id" to jsonString(base.id),
                "revision" to jsonNumber(base.revision.toDouble()),
                "sha256" to jsonString(base.sha256),
                "size" to jsonNumber(base.size.toDouble()),
                "mtimeMs" to jsonNumber(base.mtimeMs.toDouble()),
            ),
        )
    }
    val conflicts = JsonValue.Arr()
    for (conflict in state.conflicts) {
        conflicts.items += jsonObject(
            "path" to jsonString(conflict.path),
            "copyPath" to jsonString(conflict.copyPath),
            "at" to jsonString(conflict.at),
        )
    }
    return jsonObject(
        "version" to jsonNumber(1.0),
        "accountId" to jsonString(state.accountId),
        "cursor" to jsonNumber(state.cursor.toDouble()),
        "lastSyncAt" to (state.lastSyncAt?.let { jsonString(it) } ?: ch.fasrv.fanotes.json.jsonNull()),
        "files" to files,
        "conflicts" to conflicts,
    ).stringify()
}

private fun parseState(raw: String?, accountId: String): EngineState {
    if (raw.isNullOrBlank()) return EngineState(accountId, 0, null, linkedMapOf(), mutableListOf())
    return try {
        val parsed = parseJson(raw) as? JsonValue.Obj ?: return EngineState(accountId, 0, null, linkedMapOf(), mutableListOf())
        if (parsed.double("version")?.toInt() != 1 || parsed.string("accountId") != accountId) {
            return EngineState(accountId, 0, null, linkedMapOf(), mutableListOf())
        }
        val files = linkedMapOf<String, LocalBase>()
        val fileObj = parsed.obj("files")
        if (fileObj != null) {
            for ((path, value) in fileObj.fields) {
                val base = value as? JsonValue.Obj ?: continue
                if (!isSyncablePath(path)) continue
                val id = base.string("id") ?: continue
                val hash = base.string("sha256") ?: continue
                files[path] = LocalBase(id, base.double("revision")?.toLong() ?: 0L, hash, base.double("size")?.toLong() ?: 0L, base.double("mtimeMs")?.toLong() ?: 0L)
            }
        }
        val conflicts = parsed.array("conflicts")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val path = obj.string("path") ?: return@mapNotNull null
            val copy = obj.string("copyPath") ?: return@mapNotNull null
            SyncConflict(path, copy, obj.string("at") ?: "")
        }.takeLast(50).toMutableList()
        EngineState(
            accountId,
            parsed.double("cursor")?.toLong()?.coerceAtLeast(0) ?: 0L,
            parsed.string("lastSyncAt"),
            files,
            conflicts,
        )
    } catch (_: Exception) {
        EngineState(accountId, 0, null, linkedMapOf(), mutableListOf())
    }
}

private fun jsonObject(vararg pairs: Pair<String, JsonValue>) = JsonValue.Obj().also { obj ->
    for ((key, value) in pairs) obj.fields[key] = value
}
