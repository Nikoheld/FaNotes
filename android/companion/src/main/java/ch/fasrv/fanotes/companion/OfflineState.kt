package ch.fasrv.fanotes.companion

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import ch.fasrv.fanotes.sync.SyncStatus
import kotlinx.coroutines.delay

/** How long "offline" must hold before it is shown. Recovery is shown at once. */
const val OFFLINE_DEBOUNCE_MS = 3_000L

/** Consecutive failed FaNotes sync attempts needed before the sync itself counts as offline. */
const val OFFLINE_FAILURES_NEEDED = 2

/**
 * Counts consecutive offline sync attempts. A fresh start begins with zero failures, which is
 * "unknown / checking", never "offline". One failed attempt (a radio that is still waking up) does
 * not count as offline; two in a row do. A sync that is running keeps the count, a success resets it.
 */
class SyncOfflineTracker {
    private var last: SyncStatus? = null
    var failures by mutableIntStateOf(0)
        private set

    fun onStatus(status: SyncStatus) {
        val previous = last
        last = status
        when (status) {
            SyncStatus.OFFLINE -> if (previous != SyncStatus.OFFLINE) failures += 1
            SyncStatus.SYNCING -> Unit
            else -> failures = 0
        }
    }

    /** True once the failures are real. [deviceOnline] false (no network at all) counts at once. */
    fun confirmedOffline(deviceOnline: Boolean): Boolean = !deviceOnline || failures >= OFFLINE_FAILURES_NEEDED
}

/** Only an offline sync that is confirmed shows the banner. Unconfirmed offline reads as "syncing". */
fun shownSyncStatus(status: SyncStatus, offlineConfirmed: Boolean): SyncStatus =
    if (status == SyncStatus.OFFLINE && !offlineConfirmed) SyncStatus.SYNCING else status

/**
 * Debounces [raw]: turning true only takes effect after [delayMs], turning false is immediate.
 * The first composition shows [initial], so a start never flashes the flagged state.
 */
@Composable
fun rememberDebouncedFlag(raw: Boolean, delayMs: Long = OFFLINE_DEBOUNCE_MS, initial: Boolean = false): Boolean {
    var shown by remember { mutableStateOf(initial) }
    LaunchedEffect(raw) {
        if (raw) delay(delayMs)
        shown = raw
    }
    return shown
}

/** The FaNotes sync banner copy, or null while nothing is confirmed offline. Shared by every screen that shows it. */
@Composable
fun rememberFaNotesSyncCopy(status: SyncStatus, notesAccount: Boolean, tracker: SyncOfflineTracker, deviceOnline: Boolean): Triple<Int, Int, Boolean>? =
    faNotesSyncCopy(status, notesAccount, rememberDebouncedFlag(tracker.confirmedOffline(deviceOnline)))
