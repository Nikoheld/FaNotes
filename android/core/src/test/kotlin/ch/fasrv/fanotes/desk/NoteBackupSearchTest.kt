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
    fun aTranscriptHitPointsAtTheLineOnThePage() {
        val transcript = "0.1000\talpha\n0.6400\tDie Hausaufgabe\n0.9000\tomega"
        assertEquals(0.64, inkAnchorForQuery(transcript, "hausaufgabe"))
        assertNull(inkAnchorForQuery(transcript, "z"))
        val hits = searchTranscriptHits(listOf("Schule/Blatt.md" to transcript), "Hausaufgabe")
        assertEquals(0.64, hits.single().anchorY)
        assertTrue(hits.single().text.contains("Hausaufgabe"))
    }
}
