package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteBackupSearchTest {
    @Test
    fun backupsKeepTheNewestFortyAndRestoreThatNote() {
        var list = emptyList<NoteBackup>()
        for (index in 0 until 42) {
            list = createNoteBackup(list, "Notiz.md", "fassung $index", id = "nb-$index", createdAt = "2026-10-14T12:00:${index.coerceAtMost(59).toString().padStart(2, '0')}Z")
        }
        assertEquals(40, list.size)
        assertEquals("fassung 2", list.first().content)
        assertEquals("fassung 41", restoreNoteBackup(list, "nb-41", "Notiz.md"))
        assertNull(restoreNoteBackup(list, "../x", "Notiz.md"))
        val json = noteBackupsJson(list)
        assertEquals(40, parseNoteBackups(json).size)
    }

    @Test
    fun theBackupButtonFollowsTheDesktopPolicy() {
        assertEquals(NoteBackupPolicy(false, false, false), noteBackupControlPolicy(false, 3))
        assertEquals(NoteBackupPolicy(true, true, false), noteBackupControlPolicy(true, 0))
        assertEquals(NoteBackupPolicy(true, true, false), noteBackupControlPolicy(true, -2))
        assertEquals(NoteBackupPolicy(true, true, true), noteBackupControlPolicy(true, 1))
        assertEquals("später", noteBackupStamp("später"))
        val stamp = noteBackupStamp("2026-10-14T16:30:00Z", java.time.ZoneOffset.UTC)
        assertTrue(stamp.contains("14"))
        assertTrue(stamp.contains("16:30") || stamp.contains("16.30"))
    }

    @Test
    fun aTranscriptHitPointsAtTheLineOnThePage() {
        val transcript = "0.1000\talpha\n0.6400\tDie Hausaufgabe\n0.9000\tomega"
        assertEquals(0.64, inkAnchorForQuery(transcript, "hausaufgabe"))
        assertNull(inkAnchorForQuery(transcript, "z"))
        val hits = searchTranscriptHits(listOf("Schule/Blatt.md" to transcript), "Hausaufgabe")
        assertEquals(0.64, hits.single().anchorY)
        assertTrue(hits.single().text.contains("Hausaufgabe"))
    }
}
