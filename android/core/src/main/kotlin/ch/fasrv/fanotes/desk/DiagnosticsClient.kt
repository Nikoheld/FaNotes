package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.parseJson
import ch.fasrv.fanotes.json.stringify

/** Small key-value store (SharedPreferences on Android). */
interface DiagnosticsStorage {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

/** The network. Implementations send no cookies, no credentials and no referrer. */
interface DiagnosticsTransport {
    suspend fun post(url: String, json: String): Boolean
    suspend fun delete(url: String): Boolean
}

const val DIAGNOSTICS_KEY_ID = "diagnostics.installId"
const val DIAGNOSTICS_KEY_LAST = "diagnostics.lastSentAt"
const val DIAGNOSTICS_KEY_COUNTERS = "diagnostics.counters"
const val DIAGNOSTICS_URL = "$DIAGNOSTICS_ORIGIN$DIAGNOSTICS_PATH"

/**
 * Opt-in diagnostics, stateful half; the Kotlin counterpart of `diagnosticsClient.ts`. Everything
 * stays local until a toggle is on (one daily report) or "Jetzt Logs senden" is pressed. While
 * both toggles are off nothing is counted, stored or sent.
 */
class DiagnosticsClient(
    private val storage: DiagnosticsStorage,
    private val transport: DiagnosticsTransport,
    private val app: () -> DiagnosticsApp,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { newInstallId() },
) {
    /** One daily send at a time: a tick and a toggle change must not both post the same report. */
    private val dailyInFlight = java.util.concurrent.atomic.AtomicBoolean(false)
    private var consent = DiagnosticsConsent()
    private var context = DiagnosticsContext()
    private var counters = LinkedHashMap<String, Int>()
    private var errors = LinkedHashMap<String, Int>()
    private var logs = ArrayList<LogEntry>()
    private var vaultNotes = 0L
    private var vaultBytes = 0L
    private var startupMs = 0L
    private var dirty = false

    @Synchronized
    fun installId(): String {
        val existing = storage.get(DIAGNOSTICS_KEY_ID)
        if (existing != null && INSTALL_ID.matches(existing)) return existing
        val created = newId()
        storage.put(DIAGNOSTICS_KEY_ID, created)
        return created
    }

    @Synchronized
    fun rotateInstallId(): String {
        val created = newId()
        storage.put(DIAGNOSTICS_KEY_ID, created)
        return created
    }

    private fun wipeLocal() {
        counters = LinkedHashMap(); errors = LinkedHashMap(); logs = ArrayList(); dirty = false
        storage.put(DIAGNOSTICS_KEY_COUNTERS, null)
    }

    /** Called whenever a toggle changes and at start. Switching a toggle off deletes what it had collected. */
    @Synchronized
    fun configure(next: DiagnosticsConsent, nextContext: DiagnosticsContext = context) {
        consent = next
        context = nextContext
        if (consent.usage && !dirty && counters.isEmpty()) loadSaved()
        if (!consent.usage && !consent.logs) wipeLocal()
        else if (!consent.usage) {
            counters = LinkedHashMap(); errors = LinkedHashMap(); dirty = false
            storage.put(DIAGNOSTICS_KEY_COUNTERS, null)
        }
    }

    private fun loadSaved() {
        try {
            val saved = storage.get(DIAGNOSTICS_KEY_COUNTERS)?.let { parseJson(it) as? JsonValue.Obj } ?: return
            saved.obj("counters")?.fields?.forEach { (name, value) ->
                val count = (value as? JsonValue.Num)?.value?.toInt() ?: return@forEach
                if (COUNTER_NAME.matches(name) && count > 0) counters[name] = count
            }
            saved.obj("errors")?.fields?.forEach { (key, value) ->
                val count = (value as? JsonValue.Num)?.value?.toInt() ?: return@forEach
                if (ERROR_KEY.matches(key) && count > 0) errors[key] = count
            }
        } catch (_: Exception) {
            // A damaged store is simply empty.
        }
    }

    @Synchronized
    fun setVault(notes: Long, bytes: Long) {
        vaultNotes = notes; vaultBytes = bytes
    }

    /** True while a toggle is on. With both off there is nothing to collect, count or send, so callers can skip all work. */
    @Synchronized
    fun enabled(): Boolean = consent.usage || consent.logs

    /**
     * True when a toggle is on and the last report is a day old: a daily report may go out now. One small
     * preference read and no other I/O, so a periodic check can ask before it collects anything.
     */
    @Synchronized
    fun dailyDue(): Boolean {
        if (!consent.usage && !consent.logs) return false
        return dailySendDue(consent, storage.get(DIAGNOSTICS_KEY_LAST)?.toLongOrNull() ?: 0L, clock())
    }

    @Synchronized
    fun markStartupReady(ms: Long) {
        if (startupMs == 0L) startupMs = ms
    }

    @Synchronized
    fun recordFeature(name: String) {
        if (!consent.usage || !COUNTER_NAME.matches(name)) return
        counters[name] = (counters[name] ?: 0) + 1
        dirty = true
    }

    /** Only a class, a code, app frames and a hash are kept. The message text is dropped here. */
    @Synchronized
    fun recordError(error: Throwable) {
        if (!consent.usage && !consent.logs) return
        if (error is kotlinx.coroutines.CancellationException) return
        val entry = describeError(error, context)
        if (consent.usage) {
            val key = errorGroupKey(entry)
            errors[key] = (errors[key] ?: 0) + 1
            dirty = true
        }
        // The ring lives in memory only. It is sent only with a toggle or an explicit click.
        logs.add(LogEntry(clock(), entry))
        while (logs.size > DIAGNOSTICS_MAX_LOGS) logs.removeAt(0)
    }

    /** Persists the counters while usage sharing is on. Call from the lifecycle (stop). */
    @Synchronized
    fun flush() {
        if (!dirty || !consent.usage) return
        dirty = false
        val json = jsonObject(
            "counters" to JsonValue.Obj().also { o -> counters.forEach { (k, v) -> o.put(k, jsonNumber(v.toDouble())) } },
            "errors" to JsonValue.Obj().also { o -> errors.forEach { (k, v) -> o.put(k, jsonNumber(v.toDouble())) } },
        )
        storage.put(DIAGNOSTICS_KEY_COUNTERS, json.stringify())
    }

    /** The exact JSON that would leave the device. [assumeConsent] shows it before a toggle is on. */
    @Synchronized
    fun preview(manual: Boolean = false, comment: String? = null, assumeConsent: Boolean = false): JsonValue.Obj? = buildDiagnosticsPayload(
        consent = if (assumeConsent) DiagnosticsConsent(usage = true, logs = true) else consent,
        installId = installId(),
        app = app(),
        usage = DiagnosticsUsage(LinkedHashMap(counters), LinkedHashMap(errors), startupMs, vaultNotes, vaultBytes),
        logs = ArrayList(logs),
        comment = comment,
        context = context,
        nowMs = clock(),
        manual = manual,
    )

    /** Preview text as the settings card shows it (daily and manual report side by side). */
    fun previewText(comment: String?): String {
        val root = jsonObject(
            "daily" to (preview(assumeConsent = true) ?: JsonValue.Null),
            "report" to (preview(manual = true, comment = comment) ?: JsonValue.Null),
        )
        return prettyJson(root)
    }

    /** Called on start and then now and then; sends at most one report per day and only while a toggle is on. */
    suspend fun sendDailyIfDue(): Boolean {
        if (!dailyInFlight.compareAndSet(false, true)) return false
        try {
            return sendDailyLocked()
        } finally {
            dailyInFlight.set(false)
        }
    }

    private suspend fun sendDailyLocked(): Boolean {
        val now = clock()
        val payload: JsonValue.Obj
        synchronized(this) {
            val last = storage.get(DIAGNOSTICS_KEY_LAST)?.toLongOrNull() ?: 0L
            if (!dailySendDue(consent, last, now)) return false
            payload = preview() ?: return false
        }
        if (!runCatching { transport.post(DIAGNOSTICS_URL, payload.stringify()) }.getOrDefault(false)) return false
        synchronized(this) {
            storage.put(DIAGNOSTICS_KEY_LAST, now.toString())
            counters = LinkedHashMap(); errors = LinkedHashMap(); logs = ArrayList(); dirty = false
            storage.put(DIAGNOSTICS_KEY_COUNTERS, null)
        }
        return true
    }

    /** Explicit "Jetzt Logs senden": the recent errors (class, code, frames, hash) plus an optional scrubbed comment. */
    suspend fun sendLogsNow(comment: String): Boolean {
        val payload = synchronized(this) {
            buildDiagnosticsPayload(
                consent = DiagnosticsConsent(logs = true),
                installId = installId(),
                app = app(),
                logs = ArrayList(logs),
                comment = comment,
                context = context,
                nowMs = clock(),
                manual = true,
            )
        } ?: return false
        return runCatching { transport.post(DIAGNOSTICS_URL, payload.stringify()) }.getOrDefault(false)
    }

    /** Deletes everything held under this install id on the server, wipes the local counters, and renews the id on success. */
    suspend fun deleteMyData(): Boolean {
        val id = installId()
        val ok = runCatching { transport.delete("$DIAGNOSTICS_URL/$id") }.getOrDefault(false)
        synchronized(this) {
            wipeLocal()
            storage.put(DIAGNOSTICS_KEY_LAST, null)
            if (ok) rotateInstallId()
        }
        return ok
    }
}

/** What a diagnostics report says about the vault: grouped notes and all bytes. */
class VaultFigures(val notes: Long, val bytes: Long)

/**
 * The vault size for a report from what is already known: the statistics of this session, else the
 * saved ones of the last run, else the note count of the open tree (no size then). Null when none of
 * them knows anything. Nothing here reads the vault.
 */
fun diagnosticsFigures(current: StatsSummary?, saved: StatsSummary?, treeNotes: Int): VaultFigures? = when {
    current != null -> VaultFigures(current.notes, current.bytes)
    saved != null -> VaultFigures(saved.notes, saved.bytes)
    treeNotes > 0 -> VaultFigures(treeNotes.toLong(), 0L)
    else -> null
}

/**
 * The periodic check, run now and then and whenever a toggle changes. While both toggles are off, or
 * the last report is less than a day old, it returns at once and never calls [figures], so nothing is
 * collected and the vault is not touched. Only when a report is due does it ask [figures], which has to
 * answer from data that is already there (see [diagnosticsFigures]) and must never walk the vault.
 */
suspend fun DiagnosticsClient.runDailyCheck(figures: () -> VaultFigures?): Boolean {
    if (!enabled() || !dailyDue()) return false
    figures()?.let { setVault(it.notes, it.bytes) }
    return sendDailyIfDue()
}
