package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.desk.HOMEWORK_NOTE_PATH
import ch.fasrv.fanotes.desk.mergeHomeworkMarkdownBytes
import ch.fasrv.fanotes.famd.NoteSyncKind
import ch.fasrv.fanotes.famd.SyncDocumentLimitException
import ch.fasrv.fanotes.famd.requireSyncDocumentBudget
import ch.fasrv.fanotes.json.JsonLimitException
import ch.fasrv.fanotes.famd.canonicalSyncBytes
import ch.fasrv.fanotes.famd.identitySyncBytes
import ch.fasrv.fanotes.famd.isoNow
import ch.fasrv.fanotes.famd.isFamdSyncPath
import ch.fasrv.fanotes.famd.noteSyncKind
import ch.fasrv.fanotes.famd.withLocalPageStats
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
    /** Fixed numeric/enum diagnostics only: never paths, metadata, or document contents. */
    val onDiagnostic: (String) -> Unit = {},
    val now: () -> Long = { System.currentTimeMillis() },
)

private data class LocalBase(
    val id: String,
    val revision: Long,
    val sha256: String,
    val size: Long,
    val mtimeMs: Long,
    val contentSha256: String = "",
    val blank: Boolean = false,
)

private data class EngineState(
    val accountId: String,
    var cursor: Long,
    var lastSyncAt: String?,
    val files: LinkedHashMap<String, LocalBase>,
    var conflicts: MutableList<SyncConflict>,
    val pendingDeletes: MutableList<String> = mutableListOf(),
    val skipped: MutableList<SyncRemoteEntry> = mutableListOf(),
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
 * A 409 is resolved in the same cycle from the entry the server sends with it,
 * never by waiting for the pull: the cursor can already be past that entry. A
 * refused (guard) body is never sent again, a tombstone is recreated once, and a
 * newer live entry is applied like a pulled change.
 *
 * File-table updates run on one engine thread. Downloads and uploads inside a
 * cycle are sequential so a revision cursor cannot move past a deferred note.
 */
class SyncEngine(
    private val api: SyncApi,
    private val options: SyncEngineOptions = SyncEngineOptions(),
) : AutoCloseable {
    @Volatile private var memoryPaused = false
    @Volatile private var memoryCooling = false
    private var memoryStrikes = 0
    private var emergencyReserve: ByteArray? = ByteArray(256 * 1024)
    private val memoryBudgetFailure = SyncDocumentLimitException()
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
    private val cleared = mutableSetOf<String>()

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

    /** Stop the automatic timer so a background process does not keep syncing every minute. */
    fun pauseAutomaticSync() {
        timer?.cancel()
        timer = null
        debounce?.cancel()
        debounce = null
    }

    fun resumeAutomaticSync() {
        scope.launch {
            val retry = memoryPaused || memoryCooling
            if (retry) clearMemoryHold()
            schedule(if (retry) 0L else AUTO_INTERVAL_MS)
        }
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
        if (memoryPaused || memoryCooling || session == null || !options.automatic()) return
        debounce?.cancel()
        debounce = scope.launch {
            delay(LOCAL_DEBOUNCE_MS)
            syncNowOnEngine("local-change")
        }
    }

    /** The editor cleared this note on purpose. A blank file is not uploaded without it. */
    fun markCleared(path: String) {
        cleared += path
    }

    /** The user deleted or renamed this path. A missing file is not a delete. */
    suspend fun markDeleted(path: String) {
        val normal = path.trim().trim('/')
        if (normal.isEmpty() || normal.split('/').any { it.isEmpty() || it == "." || it == ".." }) return
        onEngine {
            val table = engineState ?: return@onEngine
            if (normal !in table.pendingDeletes) table.pendingDeletes += normal
            persistState()
        }
        notifyLocalChange()
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

    /** Bearer session for account-scoped APIs such as the Schulnetz link. Null when signed out. */
    suspend fun currentSession(): SyncSession? = onEngine { session }

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
        if (memoryPaused || memoryCooling) {
            if (reason != "manual" && reason != "phone" && reason != "resume") return
            clearMemoryHold()
        }
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
            memoryStrikes = 0
            memoryCooling = false
            engineState?.lastSyncAt = isoNow(options.now())
            persistState()
            publish(state.value.copy(status = SyncStatus.IDLE, progress = null, pendingLocal = 0, error = null, lastSyncAt = engineState?.lastSyncAt))
            if (reason != "timer" || pushed.uploads > 0 || pushed.deletes > 0 || conflicts > 0) {
                log("info", "Sync finished (${pushed.uploads} uploaded, ${pushed.deletes} deleted${if (conflicts > 0) ", $conflicts conflict(s)" else ""}).")
            }
            schedule(AUTO_INTERVAL_MS)
        } catch (_: OutOfMemoryError) {
            memoryFailure()
        } catch (error: Exception) {
            if (error is SyncDocumentLimitException || error is JsonLimitException) {
                // A single oversized file is skipped at the file boundary. What
                // reaches here is a process-wide failure. The first spikes retry;
                // a repeated failure still pauses below.
                diagnostic("sync memoryBudget rejected deepCopyDepth=0")
                memoryFailure()
                return
            }
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

    private fun clearMemoryHold() {
        memoryPaused = false
        memoryCooling = false
        memoryStrikes = 0
        if (emergencyReserve == null) emergencyReserve = ByteArray(256 * 1024)
    }

    private fun memoryFailure() {
        emergencyReserve = null
        memoryStrikes += 1
        queued = false
        timer?.cancel()
        debounce?.cancel()
        // Do not serialize state here. A transient spike retries on its own;
        // opening the app again and a manual sync both clear the hold.
        val pause = memoryStrikes >= 3 || !options.automatic()
        if (!pause) {
            memoryCooling = true
            memoryPaused = false
            publish(state.value.copy(status = SyncStatus.IDLE, progress = null, error = null))
            timer = scope.launch {
                delay(OFFLINE_RETRY_MS)
                if (disposed || !memoryCooling) return@launch
                // Drop the cooling flag before the retry so this attempt keeps
                // the strike count. Success resets it. Manual and phone retry clear it.
                memoryCooling = false
                if (emergencyReserve == null) emergencyReserve = ByteArray(256 * 1024)
                syncNowOnEngine("resume")
            }
            return
        }
        memoryCooling = false
        memoryPaused = true
        publish(state.value.copy(status = SyncStatus.PAUSED, progress = null,
            error = "Sync paused because memory is low. Local and remote copies were kept. Retry manually."))
    }

    private suspend fun pull(): Int {
        val active = session ?: return 0
        val currentHost = host ?: return 0
        val table = engineState ?: return 0
        val syncKeys = keys ?: return 0
        val pending = mutableListOf<SyncRemoteEntry>()
        var since = table.cursor
        var pages = 0
        var more = false
        while (pages < 2000) {
            val page = api.changes(active, since)
            pending += page.entries
            since = page.nextSince
            pages += 1
            more = page.more
            if (!more) break
        }
        if (more) log("warn", "Sync pull stopped after $pages pages; more changes remain.")
        val seen = pending.map { it.id }.toMutableSet()
        for (entry in table.skipped) {
            if (seen.add(entry.id)) pending += entry
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
            else if (result.result == "skipped") rememberSkip(table, entry)
            else forgetSkip(table, entry.id)
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
        rejected: Boolean = false,
    ): ApplyResult = try {
        applyRemoteDocument(entry, idIndex, syncKeys, currentHost, active, table, rejected)
    } catch (_: LocalReadFailed) {
        // The file is there but could not be read. Writing over it could lose a newer
        // local edit, so the entry waits and holds the cursor.
        diagnostic("sync applyRemote deferred reason=read deepCopyDepth=0")
        ApplyResult("deferred", null)
    } catch (error: RemoteEntryUnusable) {
        // One bad entry must not stop the pull or the push. The caller puts it on the skip
        // list, which is the only reason the cursor may pass it; every later pull retries it.
        diagnostic("sync applyRemote skipped reason=${error.why} deepCopyDepth=0")
        if (table.skipped.none { it.id == entry.id && it.revision == entry.revision }) {
            val subject = error.path?.let { "“$it”" } ?: "A note"
            log("warn", "$subject could not be taken from the server (${error.label}). It is retried on every sync.")
        }
        ApplyResult("skipped", error.path)
    } catch (_: OutOfMemoryError) {
        // Unwind document/crypto allocations before the cycle publishes its fixed failure state.
        emergencyReserve = null
        diagnostic("sync applyRemote rejected reason=oom deepCopyDepth=0")
        throw memoryBudgetFailure
    } catch (error: SyncDocumentLimitException) {
        // Headroom can return. Skipping here would advance the cursor past a
        // note that was never stored. The hard cap cannot fit, so that file
        // is left behind and the rest of the cycle continues.
        if (error.transient) {
            diagnostic("sync applyRemote rejected reason=budget deepCopyDepth=0")
            throw error
        }
        diagnostic("sync applyRemote skipped reason=budget deepCopyDepth=0")
        ApplyResult("skipped", null)
    } catch (error: JsonLimitException) {
        diagnostic("sync applyRemote skipped depth=${error.depth} nodes=${error.nodes} deepCopyDepth=0")
        ApplyResult("skipped", null)
    }

    /**
     * [rejected] is the server's current entry from a 409. It is applied even when its
     * revision is not above the tracked base, because the server just said the base is wrong.
     */
    private suspend fun applyRemoteDocument(
        entry: SyncRemoteEntry,
        idIndex: MutableMap<String, String>,
        syncKeys: SyncKeys,
        currentHost: SyncHost,
        active: SyncSession,
        table: EngineState,
        rejected: Boolean = false,
    ): ApplyResult {
        val knownPath = idIndex[entry.id]
        if (entry.deleted) {
            if (knownPath == null) return ApplyResult("noop", null)
            val base = table.files[knownPath] ?: return ApplyResult("noop", knownPath)
            if (!rejected && entry.revision <= base.revision) return ApplyResult("noop", knownPath)
            if (options.isPathBusy(knownPath)) return ApplyResult("deferred", knownPath)
            val local = localSnapshot(knownPath, currentHost)
            if (local == null) {
                table.files.remove(knownPath)
                idIndex.remove(entry.id)
                return ApplyResult("noop", knownPath)
            }
            if (local.kind != NoteSyncKind.UNREADABLE && (local.sha256 == base.sha256 || local.rawSha256 == base.sha256)) {
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
        } catch (_: Exception) {
            throw RemoteEntryUnusable("decrypt", null)
        }
        val path = meta.path
        if (!acceptsPath(path)) return ApplyResult("skipped", null)
        diagnostic("sync applyRemote declaredBytes=${meta.size} deepCopyDepth=0")
        requireSyncDocumentBudget(path, meta.size)
        val base = table.files[path]
        if (!rejected && base != null && base.id == entry.id && entry.revision <= base.revision) return ApplyResult("noop", path)
        if (options.isPathBusy(path)) return ApplyResult("deferred", path)
        val local = localSnapshot(path, currentHost)
        // Match the server hash only. A stored identity means the local file still
        // matches the previous revision, which is when a newer remote edit must be applied.
        if (local != null && local.kind != NoteSyncKind.UNREADABLE && (local.sha256 == meta.sha256 || local.rawSha256 == meta.sha256)) {
            val stat = currentHost.scan().firstOrNull { it.path == path }
            table.files[path] = LocalBase(
                entry.id,
                entry.revision,
                local.sha256.ifEmpty { meta.sha256 },
                local.bytes.size.toLong(),
                stat?.mtimeMs ?: 0L,
                local.identity,
                local.kind == NoteSyncKind.BLANK,
            )
            idIndex[entry.id] = path
            return ApplyResult("noop", path)
        }
        val changedLocal = local?.takeIf { snapshot ->
            base == null || snapshot.kind == NoteSyncKind.UNREADABLE || (
                if (base.contentSha256.isNotEmpty()) snapshot.identity != base.contentSha256
                else snapshot.sha256 != base.sha256 && snapshot.rawSha256 != base.sha256
            )
        }
        var result = "written"
        val response = try {
            api.download(active, entry.id)
        } catch (error: SyncApiError) {
            // Sign-in, network, rate-limit, and server errors concern the whole cycle. Anything
            // else (a blob the server no longer has) concerns this file only.
            if (error.unauthorized || error.offline || error.status == 429 || error.status >= 500) throw error
            throw RemoteEntryUnusable("download", path)
        }
        when (val download = response) {
            is DownloadResult.Deleted -> return ApplyResult("noop", path)
            is DownloadResult.Blob -> {
                if (sha256Hex(download.bytes) != download.sha256) throw RemoteEntryUnusable("damaged", path)
                val plain = try {
                    decryptBytes(syncKeys, entry.id, download.bytes)
                } catch (_: Exception) {
                    throw RemoteEntryUnusable("decrypt", path)
                }
                if (sha256Hex(plain) != meta.sha256) throw RemoteEntryUnusable("checksum", path)
                val plainIdentity = remoteIdentity(path, plain, "download")
                val localIdentity = local?.identity.orEmpty()
                if (local != null && local.kind != NoteSyncKind.UNREADABLE && plainIdentity.isNotEmpty() && plainIdentity == localIdentity) {
                    val stat = currentHost.scan().firstOrNull { it.path == path }
                    table.files[path] = LocalBase(entry.id, download.revision, meta.sha256, local.bytes.size.toLong(), stat?.mtimeMs ?: 0L, plainIdentity, local.kind == NoteSyncKind.BLANK)
                    idIndex[entry.id] = path
                    return ApplyResult("noop", path)
                }
                val remoteKind = noteSyncKind(path, plain)
                if (remoteKind == NoteSyncKind.UNREADABLE) throw RemoteEntryUnusable("unreadable", path)
                val body = if (local != null && isFamdSyncPath(path)) withLocalPageStats(plain, local.bytes, path) else plain
                // Finish all fallible document transforms before replacing the last good file.
                val storedIdentity = if (body === plain) plainIdentity else remoteIdentity(path, body, "stored")
                val storedKind = if (body === plain) remoteKind else noteSyncKind(path, body)
                val mergedHomework = if (path == HOMEWORK_NOTE_PATH && local != null && changedLocal != null &&
                    local.kind == NoteSyncKind.PRESENT && remoteKind == NoteSyncKind.PRESENT
                ) mergeHomeworkMarkdownBytes(local.bytes, plain) else null
                if (mergedHomework != null) {
                    // Task-by-task merge instead of a conflict copy. The base is the remote revision, so the next push uploads the merge.
                    log("info", "“$path” was merged task by task.")
                    currentHost.write(path, mergedHomework, options.now())
                    // Size and mtime of the remote copy, so the push scan sees the merged file as changed.
                    table.files[path] = LocalBase(entry.id, download.revision, meta.sha256, plain.size.toLong(), 0L, plainIdentity, false)
                    idIndex[entry.id] = path
                    return ApplyResult("written", path)
                }
                if (local != null && (changedLocal != null || (remoteKind == NoteSyncKind.BLANK && local.kind != NoteSyncKind.BLANK))) {
                    val at = java.time.Instant.ofEpochMilli(options.now())
                    val copyPath = freeConflictCopyPath(path, at, currentHost)
                    currentHost.write(copyPath, local.bytes, at.toEpochMilli())
                    val conflict = SyncConflict(path, copyPath, isoNow(at.toEpochMilli()))
                    table.conflicts.add(conflict)
                    if (table.conflicts.size > 50) table.conflicts.removeAt(0)
                    log("warn", "Conflict in “$path”. The local copy is now “$copyPath”.")
                    options.onConflict(conflict)
                    publish(state.value.copy(conflicts = table.conflicts.toList()))
                    result = "conflict"
                }
                val stat = currentHost.write(path, body, meta.mtimeMs.takeIf { it > 0 } ?: options.now())
                table.files[path] = LocalBase(entry.id, download.revision, meta.sha256, stat.size, stat.mtimeMs, storedIdentity, storedKind == NoteSyncKind.BLANK)
                idIndex[entry.id] = path
                return ApplyResult(result, path)
            }
        }
    }

    private fun diagnostic(message: String) {
        try {
            options.onDiagnostic(message)
        } catch (_: OutOfMemoryError) {
            emergencyReserve = null
        } catch (_: Exception) {
            // Diagnostics must not affect stored data or sync state.
        }
    }

    private fun remoteIdentity(path: String, bytes: ByteArray, phase: String): String {
        diagnostic("sync applyRemote phase=$phase bytes=${bytes.size} deepCopyDepth=0")
        return identitySyncBytes(path, bytes) { shape ->
            diagnostic("sync applyRemote phase=$phase bytes=${bytes.size} depth=${shape.depth} nodes=${shape.nodes} deepCopyDepth=0")
        }?.let { sha256Hex(it) }.orEmpty()
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
            if (entry.size > MAX_FILE_BYTES || options.isPathBusy(entry.path)) return@filter false
            val base = table.files[entry.path]
            base == null || base.size != entry.size || base.mtimeMs != entry.mtimeMs || entry.mtimeMs == 0L || base.sha256.isEmpty()
        }
        val missing = table.files.keys.filter { acceptsPath(it) && it !in present && !options.isPathBusy(it) }
        val deleted = missing.filter { isPendingDelete(table, it) }
        val vanished = missing.filter { !isPendingDelete(table, it) }
        for (path in vanished) restoreVanished(path, table, syncKeys, active, currentHost)
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
            } catch (error: SyncDocumentLimitException) {
                if (error.transient) throw error
                diagnostic("sync upload skipped reason=budget deepCopyDepth=0")
            } catch (error: JsonLimitException) {
                diagnostic("sync upload skipped depth=${error.depth} nodes=${error.nodes} deepCopyDepth=0")
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
        table.pendingDeletes.removeAll { prefix ->
            table.files.keys.none { it == prefix || it.startsWith("$prefix/") }
        }
        persistState()
        return PushResult(uploads, deletes, conflicts)
    }

    private data class PushResult(val uploads: Int, val deletes: Int, val conflicts: Int)

    private suspend fun uploadPath(entry: SyncScanEntry, table: EngineState, syncKeys: SyncKeys, active: SyncSession, currentHost: SyncHost): String {
        requireSyncDocumentBudget(entry.path, entry.size)
        val raw = try {
            currentHost.read(entry.path)
        } catch (_: Exception) {
            return "skipped"
        }
        val kind = noteSyncKind(entry.path, raw)
        val baseEarly = table.files[entry.path]
        if (kind == NoteSyncKind.UNREADABLE) {
            log("warn", "“${entry.path}” could not be read, so it was not uploaded.")
            if (baseEarly != null && !baseEarly.blank) return restoreInstead(entry, baseEarly, raw, table, syncKeys, active, currentHost)
            return "skipped"
        }
        val identityBytes = identitySyncBytes(entry.path, raw)
        if (identityBytes == null) {
            if (baseEarly != null && !baseEarly.blank) return restoreInstead(entry, baseEarly, raw, table, syncKeys, active, currentHost)
            return "skipped"
        }
        val bytes = canonicalSyncBytes(entry.path, raw)
        val hash = sha256Hex(bytes)
        val identity = sha256Hex(identityBytes)
        val base = table.files[entry.path]
        if (base != null && (base.contentSha256 == identity || base.sha256 == hash || base.sha256 == sha256Hex(raw))) {
            table.files[entry.path] = base.copy(size = entry.size, mtimeMs = entry.mtimeMs, contentSha256 = identity, blank = kind == NoteSyncKind.BLANK)
            cleared.remove(entry.path)
            return "unchanged"
        }
        val clearing = entry.path in cleared
        val severeShrink = base != null && !base.blank && base.size >= 4096 && (raw.size <= 1024 || raw.size * 4 < base.size)
        val baseHoldsContent = base != null && !base.blank && (base.size > raw.size + 64 || kind == NoteSyncKind.BLANK || severeShrink)
        if ((kind == NoteSyncKind.BLANK || severeShrink) && baseHoldsContent && !clearing) {
            log("warn", "“${entry.path}” is empty and was not uploaded over the copy already on the server.")
            return restoreInstead(entry, base!!, raw, table, syncKeys, active, currentHost)
        }
        val id = base?.id ?: fileIdFor(syncKeys, entry.path)
        val meta = encryptMeta(syncKeys, id, SyncFileMeta(entry.path, entry.mtimeMs, bytes.size.toLong(), hash))
        val blob = encryptBytes(syncKeys, id, bytes)
        val blank = kind == NoteSyncKind.BLANK
        var sentBase = base?.revision ?: 0L
        var recreating = false
        while (true) {
            try {
                val revision = api.upload(active, id, sentBase, meta, sha256Hex(blob), blob, blank, clearing && blank)
                cleared.remove(entry.path)
                table.files[entry.path] = LocalBase(id, revision, hash, entry.size, entry.mtimeMs, identity, blank)
                if (recreating) log("info", "“${entry.path}” had been deleted on the server. The copy on this device was uploaded again.")
                return "uploaded"
            } catch (error: SyncApiError) {
                if (error.status == 507) {
                    log("error", "“${entry.path}” does not fit in the account: ${error.message}")
                    return "skipped"
                }
                if (!error.conflict) throw error
                // The pull cursor may already be past the entry that caused this 409
                // (an old tombstone, a skipped entry, or the same revision for a
                // guard refusal). Resolve it here, or the same 409 repeats every cycle.
                val remote = error.entry?.let { if (it.id.isEmpty()) it.copy(id = id) else it }
                    ?.takeIf { it.id == id }
                    ?: return "conflict"
                val guard = !remote.deleted && (error.reason == "guard" || (error.reason == null && remote.revision == sentBase))
                when {
                    guard -> return keepBothOnFailure(entry.path) {
                        // Never send this body again. The local bytes become a conflict copy and the server copy returns.
                        restoreInstead(entry, base ?: LocalBase(id, remote.revision, "", 0L, 0L), raw, table, syncKeys, active, currentHost, refused = true)
                    }
                    remote.deleted && !blank && !recreating -> {
                        // A tombstone holds no content, so recreating on top of it overwrites nothing. Once per cycle.
                        recreating = true
                        sentBase = remote.revision
                    }
                    remote.deleted -> {
                        // A blank file does not bring a deleted note back. Track it at the tombstone so it is
                        // uploaded only once it has content. A second tombstone in one cycle waits for the next.
                        table.files[entry.path] = if (blank) {
                            LocalBase(id, remote.revision, hash, entry.size, entry.mtimeMs, identity, true)
                        } else {
                            LocalBase(id, remote.revision, "", 0L, 0L)
                        }
                        return "conflict"
                    }
                    else -> return applyRejected(remote, table, syncKeys, active, currentHost)
                }
            }
        }
    }

    /**
     * Applies the server's current entry from a 409 right away, like a pulled change:
     * an unchanged local file adopts it, a changed one becomes a conflict copy first.
     * The pull cursor is not consulted, so an entry below it is not lost.
     */
    private suspend fun applyRejected(
        remote: SyncRemoteEntry,
        table: EngineState,
        syncKeys: SyncKeys,
        active: SyncSession,
        currentHost: SyncHost,
    ): String = keepBothOnFailure(null) {
        val idIndex = table.files.map { (filePath, item) -> item.id to filePath }.toMap(linkedMapOf())
        val result = applyRemote(remote, idIndex, syncKeys, currentHost, active, table, rejected = true)
        when (result.result) {
            "skipped" -> rememberSkip(table, remote)
            "deferred" -> Unit
            else -> forgetSkip(table, remote.id)
        }
        val path = result.path
        if (path != null && (result.result == "written" || result.result == "conflict")) options.onApplied(listOf(path), emptyList())
        if (path != null && result.result == "removed") options.onApplied(emptyList(), listOf(path))
        "conflict"
    }

    /**
     * A 409 that cannot be resolved now (damaged download, unreadable remote note)
     * leaves both copies as they are and lets the rest of the push continue.
     */
    private suspend fun keepBothOnFailure(path: String?, block: suspend () -> String): String = try {
        block()
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (error: SyncApiError) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: Exception) {
        val subject = path?.let { "“$it”" } ?: "A note"
        log("warn", "$subject changed on the server, but that copy could not be applied (${error.message ?: "unknown"}). The local copy stays.")
        "conflict"
    }

    private suspend fun restoreInstead(
        entry: SyncScanEntry,
        base: LocalBase,
        localBytes: ByteArray,
        table: EngineState,
        syncKeys: SyncKeys,
        active: SyncSession,
        currentHost: SyncHost,
        refused: Boolean = false,
    ): String {
        val download = when (val response = api.download(active, base.id)) {
            is DownloadResult.Deleted -> return "conflict"
            is DownloadResult.Blob -> response
        }
        if (sha256Hex(download.bytes) != download.sha256) return "skipped"
        val plain = decryptBytes(syncKeys, base.id, download.bytes)
        if (noteSyncKind(entry.path, plain) != NoteSyncKind.PRESENT) {
            val identity = identitySyncBytes(entry.path, localBytes)?.let { sha256Hex(it) }.orEmpty()
            table.files[entry.path] = base.copy(size = entry.size, mtimeMs = entry.mtimeMs, contentSha256 = identity, blank = true)
            return "skipped"
        }
        val at = java.time.Instant.ofEpochMilli(options.now())
        val copyPath = freeConflictCopyPath(entry.path, at, currentHost)
        currentHost.write(copyPath, localBytes, at.toEpochMilli())
        val conflict = SyncConflict(entry.path, copyPath, isoNow(at.toEpochMilli()))
        table.conflicts.add(conflict)
        if (table.conflicts.size > 50) table.conflicts.removeAt(0)
        if (refused) {
            log("warn", "The server refused “${entry.path}” because it is empty or much shorter than the copy there. The local copy is now “$copyPath”, and the server copy was restored.")
        } else {
            log("warn", "“${entry.path}” was empty locally. That copy is now “$copyPath”, and the server copy was kept.")
        }
        options.onConflict(conflict)
        publish(state.value.copy(conflicts = table.conflicts.toList()))
        val stat = currentHost.write(entry.path, plain, at.toEpochMilli())
        val identity = identitySyncBytes(entry.path, plain)?.let { sha256Hex(it) }.orEmpty()
        // The file now holds the downloaded revision, so that is the base the next upload names.
        table.files[entry.path] = base.copy(revision = download.revision, sha256 = sha256Hex(plain), size = stat.size, mtimeMs = stat.mtimeMs, contentSha256 = identity, blank = false)
        options.onApplied(listOf(entry.path), emptyList())
        return "conflict"
    }

    private suspend fun deletePath(path: String, table: EngineState, active: SyncSession): String {
        val base = table.files[path] ?: return "skipped"
        return try {
            api.remove(active, base.id, base.revision)
            table.files.remove(path)
            "deleted"
        } catch (error: SyncApiError) {
            if (error.conflict) {
                val remote = error.entry?.let { if (it.id.isEmpty()) it.copy(id = base.id) else it }?.takeIf { it.id == base.id }
                val syncKeys = keys
                val currentHost = host
                if (remote != null && syncKeys != null && currentHost != null) {
                    // A newer remote edit wins over the local delete, even when it is below the pull cursor.
                    applyRejected(remote, table, syncKeys, active, currentHost)
                }
                "conflict"
            } else {
                throw error
            }
        }
    }

    private fun isPendingDelete(table: EngineState, path: String) =
        table.pendingDeletes.any { prefix -> path == prefix || path.startsWith("$prefix/") }

    private fun rememberSkip(table: EngineState, entry: SyncRemoteEntry) {
        if (entry.id.isEmpty()) return
        table.skipped.removeAll { it.id == entry.id }
        table.skipped += entry
        while (table.skipped.size > 200) table.skipped.removeAt(0)
    }

    private fun forgetSkip(table: EngineState, id: String) {
        table.skipped.removeAll { it.id == id }
    }

    private suspend fun restoreVanished(path: String, table: EngineState, syncKeys: SyncKeys, active: SyncSession, currentHost: SyncHost) {
        val base = table.files[path] ?: return
        // A listing can miss a file (a storage-provider hiccup). If it still reads, it is
        // not gone, and writing the server copy over it could lose a newer local edit.
        if (stillReadable(path, currentHost)) return
        try {
            when (val download = api.download(active, base.id)) {
                is DownloadResult.Deleted -> table.files.remove(path)
                is DownloadResult.Blob -> {
                    if (sha256Hex(download.bytes) != download.sha256) return
                    val plain = decryptBytes(syncKeys, base.id, download.bytes)
                    val stat = currentHost.write(path, plain, options.now())
                    val identity = identitySyncBytes(path, plain)?.let { sha256Hex(it) }.orEmpty()
                    table.files[path] = base.copy(
                        revision = download.revision,
                        sha256 = sha256Hex(plain),
                        size = stat.size,
                        mtimeMs = stat.mtimeMs,
                        contentSha256 = identity,
                        blank = false,
                    )
                }
            }
        } catch (_: Exception) {
            // Leave the tracking entry. Do not upload and do not tombstone.
        }
    }

    private suspend fun localSnapshot(path: String, currentHost: SyncHost): Snapshot? = try {
        if (isFamdSyncPath(path)) currentHost.scan().firstOrNull { it.path == path }?.let {
            requireSyncDocumentBudget(path, it.size)
        }
        val bytes = currentHost.read(path)
        val kind = noteSyncKind(path, bytes)
        if (kind == NoteSyncKind.UNREADABLE) {
            Snapshot(bytes, "", "", "", kind)
        } else {
            val identityBytes = identitySyncBytes(path, bytes)
            val canonical = canonicalSyncBytes(path, bytes)
            Snapshot(
                bytes,
                sha256Hex(canonical),
                sha256Hex(bytes),
                identityBytes?.let { sha256Hex(it) }.orEmpty(),
                if (identityBytes == null) NoteSyncKind.UNREADABLE else kind,
            )
        }
    } catch (error: JsonLimitException) {
        throw error
    } catch (error: SyncDocumentLimitException) {
        throw error
    } catch (_: NoSuchElementException) {
        null
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: Exception) {
        // Every host reports a missing file as NoSuchElementException. Anything else is a
        // failed read of a file that may hold unsynced edits; treating it as missing would
        // write the remote copy over it without a conflict copy.
        throw LocalReadFailed()
    }

    private class LocalReadFailed : Exception("The local file could not be read.")

    /** A remote entry that cannot be applied now. [why] is a fixed word for diagnostics; no content. */
    private class RemoteEntryUnusable(val why: String, val path: String?) : Exception("Remote entry unusable: $why") {
        val label get() = when (why) {
            "damaged" -> "the download was damaged"
            "decrypt" -> "it could not be decrypted"
            "checksum" -> "its checksum did not match"
            "unreadable" -> "it could not be read as a note"
            else -> "the server could not provide it"
        }
    }

    private suspend fun stillReadable(path: String, currentHost: SyncHost): Boolean = try {
        currentHost.read(path)
        true
    } catch (error: kotlinx.coroutines.CancellationException) {
        throw error
    } catch (_: NoSuchElementException) {
        false
    } catch (_: Exception) {
        // Present but unreadable: still not gone.
        true
    }

    /** [conflictCopyPath], numbered when a copy from the same minute already exists, so no copy is overwritten. */
    private suspend fun freeConflictCopyPath(path: String, at: java.time.Instant, currentHost: SyncHost): String {
        val first = conflictCopyPath(path, deviceInfo().first, at)
        if (!stillReadable(first, currentHost)) return first
        val name = path.substringAfterLast('/')
        val dot = name.lastIndexOf('.')
        val extension = if (dot > 0) name.substring(dot) else ""
        val stem = first.removeSuffix(extension).removeSuffix(")")
        for (number in 2..99) {
            val candidate = "$stem $number)$extension"
            if (!stillReadable(candidate, currentHost)) return candidate
        }
        return "$stem ${options.now()})$extension"
    }

    private data class Snapshot(val bytes: ByteArray, val sha256: String, val rawSha256: String, val identity: String, val kind: NoteSyncKind)

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
        if (memoryPaused || memoryCooling) return
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
                "contentSha256" to jsonString(base.contentSha256),
                "blank" to ch.fasrv.fanotes.json.jsonBool(base.blank),
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
        "pendingDeletes" to JsonValue.Arr(state.pendingDeletes.map { jsonString(it) }.toMutableList()),
        "skipped" to JsonValue.Arr(state.skipped.map { entry ->
            jsonObject(
                "id" to jsonString(entry.id),
                "revision" to jsonNumber(entry.revision.toDouble()),
                "deleted" to ch.fasrv.fanotes.json.jsonBool(entry.deleted),
                "size" to jsonNumber(entry.size.toDouble()),
                "sha256" to (entry.sha256?.let { jsonString(it) } ?: ch.fasrv.fanotes.json.jsonNull()),
                "meta" to (entry.meta?.let { jsonString(it) } ?: ch.fasrv.fanotes.json.jsonNull()),
                "updatedAt" to (entry.updatedAt?.let { jsonString(it) } ?: ch.fasrv.fanotes.json.jsonNull()),
                "deviceId" to (entry.deviceId?.let { jsonString(it) } ?: ch.fasrv.fanotes.json.jsonNull()),
            )
        }.toMutableList()),
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
                files[path] = LocalBase(
                    id,
                    base.double("revision")?.toLong() ?: 0L,
                    hash,
                    base.double("size")?.toLong() ?: 0L,
                    base.double("mtimeMs")?.toLong() ?: 0L,
                    base.string("contentSha256").orEmpty(),
                    base.bool("blank") == true,
                )
            }
        }
        val conflicts = parsed.array("conflicts")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val path = obj.string("path") ?: return@mapNotNull null
            val copy = obj.string("copyPath") ?: return@mapNotNull null
            SyncConflict(path, copy, obj.string("at") ?: "")
        }.takeLast(50).toMutableList()
        val pendingDeletes = parsed.array("pendingDeletes")?.items.orEmpty().mapNotNull { item ->
            (item as? JsonValue.Str)?.value?.takeIf { it.isNotEmpty() && it.length <= 1024 }
        }.takeLast(500).toMutableList()
        val skipped = parsed.array("skipped")?.items.orEmpty().mapNotNull { item ->
            val obj = item as? JsonValue.Obj ?: return@mapNotNull null
            val id = obj.string("id") ?: return@mapNotNull null
            SyncRemoteEntry(
                id,
                obj.double("revision")?.toLong() ?: 0L,
                obj.bool("deleted") == true,
                obj.double("size")?.toLong() ?: 0L,
                obj.string("sha256"),
                obj.string("meta"),
                obj.string("updatedAt"),
                obj.string("deviceId"),
            )
        }.takeLast(200).toMutableList()
        EngineState(
            accountId,
            parsed.double("cursor")?.toLong()?.coerceAtLeast(0) ?: 0L,
            parsed.string("lastSyncAt"),
            files,
            conflicts,
            pendingDeletes,
            skipped,
        )
    } catch (_: Exception) {
        EngineState(accountId, 0, null, linkedMapOf(), mutableListOf())
    }
}

private fun jsonObject(vararg pairs: Pair<String, JsonValue>) = JsonValue.Obj().also { obj ->
    for ((key, value) in pairs) obj.fields[key] = value
}
