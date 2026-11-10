package ch.fasrv.fanotes.schulnetz

/*
 * When Kanti+ refreshes. The fast path for news is the server: it reads Schulnetz every few minutes
 * on school days and pushes a high-priority FCM message as soon as something changed. The phone
 * therefore never polls Schulnetz in a loop. It refreshes when the user opens or returns to the app
 * (cheap: the server's change feed and snapshot), reads Schulnetz itself only when the server copy
 * is old or the app has not read for a while, and keeps one periodic WorkManager check as a fallback
 * for a missed push.
 */

/** A foreground sync is skipped when a successful one finished this recently. */
const val FOREGROUND_DEBOUNCE_MS = 30_000L

/** The server's copy is fresh enough to show when it is younger than this. */
const val SERVER_FRESH_MS = 10 * 60_000L

/** The app reads Schulnetz itself on opening at most this often while the server copy is fresh. */
const val OWN_READ_EVERY_MS = 30 * 60_000L

/** Without a server link the app is the only reader; it reads at most this often on opening. */
const val LOCAL_READ_EVERY_MS = 60_000L

/** True when opening or returning to the app should sync now. */
fun foregroundSyncDue(lastSuccessAt: Long, now: Long, inFlight: Boolean): Boolean {
    if (inFlight) return false
    if (lastSuccessAt <= 0L || now < lastSuccessAt) return true
    return now - lastSuccessAt >= FOREGROUND_DEBOUNCE_MS
}

/**
 * True when the app should also read Schulnetz itself after taking the server's copy: there is no
 * server link, the server has not read recently (or needs a new sign-in), or the app's own read is
 * old. [serverFetchedAt] is the server snapshot's read time (0 when unknown).
 */
fun ownReadDue(serverLinked: Boolean, serverFetchedAt: Long, serverNeedsReauth: Boolean, lastOwnReadAt: Long, now: Long): Boolean {
    if (!serverLinked) return lastOwnReadAt <= 0L || now - lastOwnReadAt >= LOCAL_READ_EVERY_MS || now < lastOwnReadAt
    if (serverNeedsReauth) return true
    if (serverFetchedAt <= 0L || now - serverFetchedAt >= SERVER_FRESH_MS) return true
    return lastOwnReadAt <= 0L || now - lastOwnReadAt >= OWN_READ_EVERY_MS || now < lastOwnReadAt
}

/** "Hintergrund-Aktualisierung" in the notification settings. */
enum class BackgroundMode(val wire: String) {
    NORMAL("normal"),
    SAVER("saver");

    companion object {
        fun of(raw: String?): BackgroundMode = entries.firstOrNull { it.wire == raw } ?: NORMAL
    }
}

/**
 * Minutes between the periodic background checks (WorkManager's minimum is 15). Each check asks the
 * server for its change feed only; it never reads Schulnetz. With push working the check only catches
 * a missed push, so it is rare; without push it is the only way news arrives.
 */
fun backgroundCheckMinutes(mode: BackgroundMode, pushReady: Boolean): Long = when (mode) {
    BackgroundMode.NORMAL -> if (pushReady) 60L else 30L
    BackgroundMode.SAVER -> if (pushReady) 240L else 120L
}

/** Flex window: WorkManager may run the check anywhere in the last part of the period, batched with other jobs. */
fun backgroundFlexMinutes(intervalMinutes: Long): Long = (intervalMinutes / 4).coerceIn(5L, 60L)

/** Checks per day at most, for the battery budget. */
fun backgroundChecksPerDay(mode: BackgroundMode, pushReady: Boolean): Int = (24 * 60 / backgroundCheckMinutes(mode, pushReady)).toInt()

/**
 * Notices already shown, by stable change id. The server push and the app's own read produce the
 * same id for the same school change, so whichever arrives second is dropped. Keeps the newest [cap].
 */
class NoticeLedger(seen: Iterable<String> = emptyList(), private val cap: Int = 2000) {
    private val ids = LinkedHashSet<String>().apply { addAll(seen) }

    /** True the first time [id] is seen. */
    fun firstTime(id: String): Boolean {
        if (id.isBlank() || id in ids) return false
        ids.add(id)
        while (ids.size > cap) ids.remove(ids.first())
        return true
    }

    fun ids(): List<String> = ids.toList()
}
