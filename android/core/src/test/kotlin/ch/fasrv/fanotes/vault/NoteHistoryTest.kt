package ch.fasrv.fanotes.vault

import ch.fasrv.fanotes.desk.confirmDialogShadow
import ch.fasrv.fanotes.desk.confirmShadowFavorsDown
import ch.fasrv.fanotes.desk.confirmShadowFrame
import java.nio.file.Files
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class NoteHistoryTest {
    @Test
    fun snapshotsUseTheDesktopSha1FolderAndTheTwelveHourCadence() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history"))
        assertEquals("bfb8d1331084ef9b03ef8565520777f39e519f99", sha1Hex("Note.md"))
        assertEquals(".fanotes/history/bfb8d1331084ef9b03ef8565520777f39e519f99", historyDirectory("Note.md"))
        val start = "2026-10-14T12:00:00.000Z"
        val halfDay = "2026-10-15T00:00:00.000Z"
        recordNoteHistory(vault, "Note.md", "first revision\n", start, "aa0001")
        recordNoteHistory(vault, "Note.md", "first revision\n", "2026-10-14T12:00:01.000Z", "aa0002")
        assertEquals(1, listNoteHistory(vault, "Note.md", Instant.parse("2026-10-14T12:00:01.000Z").toEpochMilli()).size)
        recordNoteHistory(vault, "Note.md", "second revision\n", "2026-10-14T12:00:02.000Z", "aa0003")
        assertEquals(1, listNoteHistory(vault, "Note.md", Instant.parse("2026-10-14T12:00:02.000Z").toEpochMilli()).size)
        recordNoteHistory(vault, "Note.md", "half day\n", halfDay, "aa0004")
        val listed = listNoteHistory(vault, "Note.md", Instant.parse(halfDay).toEpochMilli())
        assertEquals(2, listed.size)
        assertEquals("half day\n", readNoteHistory(vault, "Note.md", listed.first().id).content)
        assertEquals("first revision\n", readNoteHistory(vault, "Note.md", listed.last().id).content)
        assertTrue(vault.read("${historyDirectory("Note.md")}/index.json")!!.decodeToString().contains("\"format\": \"fanotes-history-v1\""))
        assertFailsWith<IllegalArgumentException> { readNoteHistory(vault, "Note.md", "../secret") }
    }

    @Test
    fun aTwelveHourSnapshotExpiresAfterTwoDaysAndAWeeklySnapshotStays() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history-limit"))
        recordNoteHistory(vault, "Long.md", "week\n", "2026-03-01T00:00:00.000Z", "bb0000")
        recordNoteHistory(vault, "Long.md", "too soon\n", "2026-03-01T00:01:00.000Z", "bb0001")
        val halfDay = "2026-03-01T12:00:00.000Z"
        recordNoteHistory(vault, "Long.md", "half day\n", halfDay, "bb0002")
        val during = listNoteHistory(vault, "Long.md", Instant.parse(halfDay).toEpochMilli())
        assertEquals(2, during.size)
        assertEquals("half day\n", readNoteHistory(vault, "Long.md", during.first().id).content)
        val expiredAt = Instant.parse(halfDay).toEpochMilli() + HISTORY_SHORT_RETENTION_MS
        val expired = listNoteHistory(vault, "Long.md", expiredAt)
        assertEquals(1, expired.size)
        assertEquals("week\n", readNoteHistory(vault, "Long.md", expired.single().id).content)
        assertEquals(1, vault.list(historyDirectory("Long.md")).count { it.path.endsWith(".md") })
        recordNoteHistory(vault, "Long.md", "next week\n", "2026-03-08T00:00:00.000Z", "bb0003")
        val weeks = listNoteHistory(vault, "Long.md", Instant.parse("2026-03-08T00:00:00.000Z").toEpochMilli())
        assertEquals(2, weeks.size)
        assertEquals(listOf("week", "week"), weeks.asReversed().map { it.tier })
    }

    @Test
    fun famdSnapshotsKeepTheFamdExtensionAndMarkdownSnapshotsKeepTheCompanion() {
        val vault = DirectoryVault(Files.createTempDirectory("fanotes-history-famd"))
        val stamp = "2026-03-01T00:00:00.000Z"
        val now = Instant.parse(stamp).toEpochMilli()
        recordNoteHistory(vault, "Ink.famd", "handwriting-bytes", stamp, "cc0001")
        val famdFiles = vault.list(historyDirectory("Ink.famd"))
        assertEquals(1, famdFiles.count { it.path.endsWith(".famd") })
        assertEquals(0, famdFiles.count { it.path.endsWith(".md") })
        assertEquals("handwriting-bytes", readNoteHistory(vault, "Ink.famd", listNoteHistory(vault, "Ink.famd", now).single().id).content)
        recordNoteHistory(vault, "Both.md", "# Text\n", stamp, "dd0001", companion = "companion-famd")
        val loaded = readNoteHistory(vault, "Both.md", listNoteHistory(vault, "Both.md", now).single().id)
        assertEquals("# Text\n", loaded.content)
        assertEquals("companion-famd", loaded.companion)
        val bothFiles = vault.list(historyDirectory("Both.md"))
        assertEquals(1, bothFiles.count { it.path.endsWith(".md") && !it.path.endsWith("index.json") })
        assertEquals(1, bothFiles.count { it.path.endsWith(".famd") })
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
        val restored = readNoteHistory(vault, path, history.single().id)
        assertTrue(restored.content.contains("Lecture"))
        assertTrue(restored.companion?.contains("fanotes-famd") == true)
    }
}
