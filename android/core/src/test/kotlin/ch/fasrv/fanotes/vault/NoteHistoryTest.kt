package ch.fasrv.fanotes.vault

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class NoteHistoryTest {
    @Test
    fun snapshotsUseTheDesktopSha1FolderAndKeepThirty() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history"))
        assertEquals("bfb8d1331084ef9b03ef8565520777f39e519f99", sha1Hex("Note.md"))
        assertEquals(".fanotes/history/bfb8d1331084ef9b03ef8565520777f39e519f99", historyDirectory("Note.md"))
        recordNoteHistory(vault, "Note.md", "first revision\n", "2026-10-14T12:00:00.000Z", "aa0001")
        recordNoteHistory(vault, "Note.md", "first revision\n", "2026-10-14T12:00:01.000Z", "aa0002")
        assertEquals(1, listNoteHistory(vault, "Note.md").size)
        recordNoteHistory(vault, "Note.md", "second revision\n", "2026-10-14T12:00:02.000Z", "aa0003")
        val listed = listNoteHistory(vault, "Note.md")
        assertEquals("second revision\n", readNoteHistory(vault, "Note.md", listed.first().id).content)
        assertEquals("first revision\n", readNoteHistory(vault, "Note.md", listed.last().id).content)
        assertTrue(vault.read("${historyDirectory("Note.md")}/index.json")!!.decodeToString().contains("\"format\": \"fanotes-history-v1\""))
        assertFailsWith<IllegalArgumentException> { readNoteHistory(vault, "Note.md", "../secret") }
    }

    @Test
    fun theOldestSnapshotIsDroppedAfterTheLimit() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history-limit"))
        for (revision in 0..HISTORY_LIMIT) {
            val stamp = "2026-10-14T12:00:%02d.000Z".format(revision)
            recordNoteHistory(vault, "Long.md", "revision $revision\n", stamp, "bb%04d".format(revision))
        }
        val history = listNoteHistory(vault, "Long.md")
        assertEquals(HISTORY_LIMIT, history.size)
        assertEquals("revision $HISTORY_LIMIT\n", readNoteHistory(vault, "Long.md", history.first().id).content)
        val retained = history.map { readNoteHistory(vault, "Long.md", it.id).content }.toSet()
        assertTrue("revision 0\n" !in retained)
        val files = vault.list(historyDirectory("Long.md")).count { it.path.endsWith(".md") }
        assertEquals(HISTORY_LIMIT, files)
    }

    @Test
    fun savingANoteKeepsThePreviousMarkdown() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history-save"))
        val store = NoteStore(vault)
        val path = store.createMarkdown("", "Lecture")
        val note = store.readNote(path)
        store.save(note, note.document, "Zweite Fassung\n")
        val history = listNoteHistory(vault, path)
        assertEquals(1, history.size)
        assertTrue(readNoteHistory(vault, path, history.single().id).content.contains("Lecture"))
    }
}
