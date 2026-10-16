package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.confirmDialogShadow
import ch.fasrv.fanotes.desk.confirmShadowFavorsDown
import ch.fasrv.fanotes.desk.confirmShadowFrame
import java.nio.file.Files
import java.time.ZoneOffset
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
    fun historyStampLabelUsesTheDesktopClock() {
        assertEquals("15.10.2026 12:00", historyStampLabel("2026-10-15T12:00:00.000Z", ZoneOffset.UTC))
        assertEquals("15.10.2026 14:30", historyStampLabel("2026-10-15T12:30:00.000Z", ZoneOffset.ofHours(2)))
        assertEquals("nicht-lesbar", historyStampLabel("nicht-lesbar", ZoneOffset.UTC))
        assertEquals("1 KB", historySizeLabel(0))
        assertEquals("1 KB", historySizeLabel(400))
        assertEquals("1 KB", historySizeLabel(1024))
        assertEquals("2 KB", historySizeLabel(1536))
        assertEquals(520, HISTORY_DIALOG_MAX_DP)
        assertEquals(0.92f, HISTORY_DIALOG_WIDTH_FRACTION)
        assertEquals(12, HISTORY_DIALOG_RADIUS_DP)
        assertEquals(520, historyDialogWidthDp(800))
        assertEquals(368, historyDialogWidthDp(400))
        assertEquals(640, historyDialogMaxHeightDp(1200))
        assertEquals(280, historyDialogMaxHeightDp(400))
        assertEquals("Frühere Versionen", HISTORY_TITLE)
        assertEquals("Noch keine älteren Stände. Nach dem nächsten Speichern erscheint hier die vorherige Version.", HISTORY_EMPTY)
    }

    @Test
    fun theHistoryDialogUsesEachThemeShadow() {
        for (theme in listOf("light", "sepia", "dark", "midnight", "forest", "aurora")) {
            assertEquals(confirmDialogShadow(theme), historyDialogShadow(theme))
            assertEquals(confirmShadowFrame(400f, 200f, 2f, theme), historyShadowFrame(400f, 200f, 2f, theme))
        }
        val dark = historyDialogShadow("dark")
        assertEquals(0, dark.xDp)
        assertEquals(16, dark.yDp)
        assertEquals(48, dark.blurDp)
        assertEquals(0.28f, dark.alpha)
        assertEquals(0, dark.red)
        assertEquals(0, dark.green)
        assertEquals(0, dark.blue)
        val sepia = historyDialogShadow("sepia")
        assertEquals(0, sepia.xDp)
        assertEquals(12, sepia.yDp)
        assertEquals(40, sepia.blurDp)
        assertEquals(0.08f, sepia.alpha)
        assertEquals(55, sepia.red)
        assertEquals(48, sepia.green)
        assertEquals(36, sepia.blue)
        val deep = historyDialogShadow("midnight")
        assertEquals(16, deep.yDp)
        assertEquals(48, deep.blurDp)
        assertEquals(0.32f, deep.alpha)
        assertEquals(deep, historyDialogShadow("forest"))
        assertEquals(deep, historyDialogShadow("aurora"))
        val light = historyDialogShadow("light")
        assertEquals(12, light.yDp)
        assertEquals(40, light.blurDp)
        assertEquals(0.08f, light.alpha)
        assertEquals(15, light.red)
        assertEquals(15, light.green)
        assertEquals(15, light.blue)
        val sepiaFrame = checkNotNull(historyShadowFrame(400f, 200f, 2f, "sepia"))
        assertEquals(24f, sepiaFrame.shapeTopPx - sepiaFrame.padPx)
        assertEquals(0x14373024, sepiaFrame.color)
        val darkFrame = checkNotNull(historyShadowFrame(400f, 200f, 2f, "dark"))
        assertEquals(32f, darkFrame.shapeTopPx - darkFrame.padPx)
        assertEquals(0x47000000, darkFrame.color)
        assertTrue(confirmShadowFavorsDown(darkFrame, 200f))
        assertTrue(darkFrame.shapeBottomPx + darkFrame.blurPx < darkFrame.bitmapHeightPx)
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
