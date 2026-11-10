package ch.fasrv.fanotes.schulnetz

import java.time.LocalDate
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class RefreshPolicyTest {
    private val now = 1_800_000_000_000L

    @Test
    fun openingTheAppSyncsAtOnceButNotTwiceWithinThirtySeconds() {
        assertTrue(foregroundSyncDue(lastSuccessAt = 0L, now = now, inFlight = false))
        assertFalse(foregroundSyncDue(now - 10_000, now, inFlight = false))
        assertFalse(foregroundSyncDue(now - 29_999, now, inFlight = false))
        assertTrue(foregroundSyncDue(now - FOREGROUND_DEBOUNCE_MS, now, inFlight = false))
        // A sync already running is not started again.
        assertFalse(foregroundSyncDue(now - 120_000, now, inFlight = true))
        // A clock that went back never blocks syncing.
        assertTrue(foregroundSyncDue(now + 60_000, now, inFlight = false))
    }

    @Test
    fun theAppReadsSchulnetzItselfOnlyWhenTheServerCopyIsOldOrItsOwnReadIs() {
        val fresh = now - 2 * 60_000
        // Server copy fresh, own read recent: the server's copy is enough.
        assertFalse(ownReadDue(serverLinked = true, serverFetchedAt = fresh, serverNeedsReauth = false, lastOwnReadAt = now - 5 * 60_000, now = now))
        // Server copy old, unknown, or the server needs a new sign-in.
        assertTrue(ownReadDue(true, now - SERVER_FRESH_MS, false, now - 60_000, now))
        assertTrue(ownReadDue(true, 0L, false, now - 60_000, now))
        assertTrue(ownReadDue(true, fresh, true, now - 60_000, now))
        // The app's own read is old (Terminliste, start page appointments come from it).
        assertTrue(ownReadDue(true, fresh, false, now - OWN_READ_EVERY_MS, now))
        assertTrue(ownReadDue(true, fresh, false, 0L, now))
        // Without a server link the app is the only reader: at most once a minute, as before.
        assertFalse(ownReadDue(false, 0L, false, now - 30_000, now))
        assertTrue(ownReadDue(false, 0L, false, now - LOCAL_READ_EVERY_MS, now))
    }

    @Test
    fun theBackgroundCheckIsRareAndNeverBelowWorkManagersMinimum() {
        assertEquals(60L, backgroundCheckMinutes(BackgroundMode.NORMAL, pushReady = true))
        assertEquals(30L, backgroundCheckMinutes(BackgroundMode.NORMAL, pushReady = false))
        assertEquals(240L, backgroundCheckMinutes(BackgroundMode.SAVER, pushReady = true))
        assertEquals(120L, backgroundCheckMinutes(BackgroundMode.SAVER, pushReady = false))
        for (mode in BackgroundMode.entries) for (push in listOf(true, false)) {
            val minutes = backgroundCheckMinutes(mode, push)
            assertTrue(minutes >= 15, "$mode $push")
            val flex = backgroundFlexMinutes(minutes)
            assertTrue(flex in 5..minutes / 2, "$mode $push flex $flex")
        }
        assertEquals(24, backgroundChecksPerDay(BackgroundMode.NORMAL, true))
        assertEquals(6, backgroundChecksPerDay(BackgroundMode.SAVER, true))
        // Normal is the default; an unknown stored value falls back to it.
        assertEquals(BackgroundMode.NORMAL, BackgroundMode.of(null))
        assertEquals(BackgroundMode.NORMAL, BackgroundMode.of("turbo"))
        assertEquals(BackgroundMode.SAVER, BackgroundMode.of("saver"))
    }

    @Test
    fun aChangeIsShownOnceWhetherThePushOrTheAppsOwnReadBringsItFirst() {
        // The app's own read and the server produce the same id for the same school change.
        val before = SchulnetzSnapshot(absences = emptyList(), absenceParser = ABSENCE_PARSER_VERSION)
        val report = SchoolAbsence("abs-open-1", "10.11.2026", "10.11.2026", "10:30", "11:15", "mat 2.1", "", false, false, "offen", pending = true)
        val after = before.copy(absences = listOf(report), absenceQuota = 30.0, absenceRemaining = 30.0)
        val local = diffSnapshots(before, after, today = LocalDate.of(2026, 11, 10)).single { it.category == "absence" }
        assertEquals("absence:abs-open-1", local.id)
        // The open-absence estimate from beta.21 is still in the notice.
        assertTrue(local.body.contains("geschätzt 2 Punkte"), local.body)
        val ledger = NoticeLedger()
        assertTrue(ledger.firstTime("absence:abs-open-1"))   // the push arrived first
        assertFalse(ledger.firstTime(local.id))               // the app's own read brings the same change
        assertFalse(ledger.firstTime(""))
    }

    @Test
    fun theLedgerKeepsTheNewestIds() {
        val ledger = NoticeLedger(cap = 3)
        listOf("a", "b", "c", "d").forEach { assertTrue(ledger.firstTime(it)) }
        assertEquals(listOf("b", "c", "d"), ledger.ids())
        // The oldest was dropped and could show again; the newest never do.
        assertFalse(ledger.firstTime("d"))
        assertTrue(NoticeLedger(listOf("x", "y")).ids() == listOf("x", "y"))
    }
}
