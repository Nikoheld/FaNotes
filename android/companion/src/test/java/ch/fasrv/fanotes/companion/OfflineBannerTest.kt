package ch.fasrv.fanotes.companion

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import ch.fasrv.fanotes.sync.SyncStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** Synthetic state only. Covers the tracker, the debounce and the banner copy that the screens share. */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34], application = Application::class)
class OfflineBannerTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private var status by mutableStateOf(SyncStatus.SYNCING)
    private var deviceOnline by mutableStateOf(true)
    private val tracker = SyncOfflineTracker()

    private fun feed(next: SyncStatus) { status = next; tracker.onStatus(next) }

    private fun show(notesAccount: Boolean = true) = rule.setContent {
        val copy = rememberFaNotesSyncCopy(status, notesAccount, tracker, deviceOnline)
        Text(if (copy?.first == R.string.fanotes_offline) "OFFLINE" else "quiet")
    }

    private fun offlineShown() = rule.onAllNodesWithText("OFFLINE").fetchSemanticsNodes().isNotEmpty()

    @Test fun `fresh start with a sync in progress shows no offline banner`() {
        feed(SyncStatus.SYNCING)
        show()
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS * 3)
        rule.onAllNodesWithText("OFFLINE").assertCountEquals(0)
        assertEquals(0, tracker.failures)
    }

    @Test fun `a single failed attempt does not show offline`() {
        feed(SyncStatus.SYNCING)
        show()
        feed(SyncStatus.OFFLINE)
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS * 3)
        assertFalse(offlineShown())
    }

    @Test fun `repeated failed attempts show offline only after the debounce`() {
        feed(SyncStatus.SYNCING)
        show()
        feed(SyncStatus.OFFLINE); feed(SyncStatus.SYNCING); feed(SyncStatus.OFFLINE)
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS / 2)
        assertFalse(offlineShown())
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS)
        assertTrue(offlineShown())
    }

    @Test fun `no network shows offline after the debounce and recovery hides it at once`() {
        feed(SyncStatus.OFFLINE)
        show()
        deviceOnline = false
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS / 2)
        assertFalse(offlineShown())
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS)
        assertTrue(offlineShown())
        deviceOnline = true
        feed(SyncStatus.IDLE)
        rule.mainClock.advanceTimeByFrame()
        assertFalse(offlineShown())
    }

    @Test fun `a network flap shorter than the debounce never shows`() {
        feed(SyncStatus.OFFLINE)
        show()
        deviceOnline = false
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS / 2)
        deviceOnline = true
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS * 2)
        assertFalse(offlineShown())
    }

    @Test fun `a school only session never gets the FaNotes banner`() {
        feed(SyncStatus.OFFLINE)
        show(notesAccount = false)
        deviceOnline = false
        rule.mainClock.advanceTimeBy(OFFLINE_DEBOUNCE_MS * 2)
        assertFalse(offlineShown())
    }

    @Test fun `unconfirmed offline reads as syncing in the status line`() {
        assertEquals(SyncStatus.SYNCING, shownSyncStatus(SyncStatus.OFFLINE, false))
        assertEquals(SyncStatus.OFFLINE, shownSyncStatus(SyncStatus.OFFLINE, true))
        assertEquals(SyncStatus.ERROR, shownSyncStatus(SyncStatus.ERROR, false))
        assertNull(faNotesSyncCopy(SyncStatus.OFFLINE, true, offlineConfirmed = false))
    }
}
