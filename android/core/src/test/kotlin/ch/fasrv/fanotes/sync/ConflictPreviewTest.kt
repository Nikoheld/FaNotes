package ch.fasrv.fanotes.sync

import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.ink.InkDocument
import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.StrokePoint
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.stringify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ConflictPreviewTest {
    private fun file(path: String, text: String) = ConflictFileBytes(path, text.encodeToByteArray())

    private fun inkDocument() = InkDocument(
        "t", "dots", 900.0, 1273.0,
        listOf(InkStroke(listOf(StrokePoint(0.1, 0.1, 0.0, 0.5, 0.0, 0.0, "pen"), StrokePoint(0.2, 0.2, 1.0, 0.5, 0.0, 0.0, "pen")), 3.0, true, "#000000")),
        "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z",
    )

    @Test
    fun missingAndDamagedVersionsAreNamed() {
        assertEquals(ConflictPreview.Missing, previewOfVersion(listOf(ConflictFileBytes("a.md", null))))
        assertIs<ConflictPreview.Damaged>(previewOfVersion(listOf(ConflictFileBytes("a.md", byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0xfd.toByte())))))
        assertIs<ConflictPreview.Damaged>(previewOfVersion(listOf(file("story/Roman.story/story.json", "{kaputt"))))
        assertEquals("Nicht vorhanden", conflictSummary(ConflictPreview.Missing))
    }

    @Test
    fun markdownShowsReadableTextWithoutHiddenMarkers() {
        val preview = previewOfVersion(listOf(file("a.md", "# Titel\n\n<!-- fanotes-ink:abc -->\nZwei Wörter\n\n\n\nEnde")))
        assertIs<ConflictPreview.Note>(preview)
        assertEquals(listOf("# Titel", "", "Zwei Wörter", "", "Ende"), preview.lines)
        assertEquals(4, preview.words)
        assertEquals(0, preview.strokes)
    }

    @Test
    fun aFamdNoteShowsItsHandwritingAndTextBoxes() {
        val payload = jsonObject(
            "schema" to jsonString("fanotes-famd-v1"),
            "ink" to inkDocument().toJson(),
            "textFields" to jsonArray(jsonObject("text" to jsonString("Notiz")), jsonObject("text" to jsonString(" "))),
        )
        val source = serializeFamd("# Skizze\nText", payload)
        val preview = previewOfVersion(listOf(file("Skizze.famd", source)))
        assertIs<ConflictPreview.Note>(preview)
        assertEquals(1, preview.strokes)
        assertEquals(1, preview.textFields)
        assertEquals(1, preview.ink!!.strokes.size)
        assertTrue(preview.lines.contains("# Skizze"))
        assertEquals(source.length, preview.size)
        assertTrue(conflictSummary(preview).contains("1 Striche"))
        val withMarkdown = previewOfVersion(listOf(file("Skizze.famd", source), file("Skizze.md", "Neuer Text")))
        assertIs<ConflictPreview.Note>(withMarkdown)
        assertEquals(listOf("Neuer Text"), withMarkdown.lines)
        assertEquals(1, withMarkdown.strokes)
    }

    @Test
    fun aBrokenFamdIsDamaged() {
        val preview = previewOfVersion(listOf(file("a.famd", "x\n<!-- fanotes-famd:v1 chars=99 -->\n{bad")))
        assertIs<ConflictPreview.Damaged>(preview)
    }

    @Test
    fun storyFilesReadAsParagraphsAndOutlines() {
        val scene = """{"paragraphs":[{"style":"chapter","runs":[{"text":"Kapitel 1"}]},{"runs":[{"text":"Es war "},{"text":"einmal"}]},{"deleted":true,"runs":[{"text":"weg"}]},{"conflictOf":"p1","runs":[{"text":"Andere Fassung"}]}]}"""
        val preview = previewOfVersion(listOf(file("Roman.story/scenes/abcdef12.json", scene)))
        assertIs<ConflictPreview.Story>(preview)
        assertEquals("scene", preview.role)
        assertEquals(listOf("# Kapitel 1", "Es war einmal", "» Andere Fassung"), preview.lines)
        assertEquals(3, preview.paragraphs)
        val manifest = """{"title":"Roman","author":"Ich","binder":[{"kind":"folder","title":"Teil 1","children":[{"kind":"scene","title":"Anfang","synopsis":"Es beginnt"}]}],"dictionary":["Alpha","Beta"]}"""
        val outline = previewOfVersion(listOf(file("Roman.story/story.json", manifest)))
        assertIs<ConflictPreview.Story>(outline)
        assertEquals(listOf("# Roman", "Ich", "## Teil 1", "- Anfang – Es beginnt", "", "Alpha, Beta"), outline.lines)
        val sheet = """{"name":"Anna","role":"Heldin","aliases":["A"],"fields":[{"label":"Alter","value":"17"},{"label":"Leer","value":""}],"notes":"Mag Tee"}"""
        val bible = previewOfVersion(listOf(file("Roman.story/bible/characters/abcdef12.json", sheet)))
        assertIs<ConflictPreview.Story>(bible)
        assertEquals(listOf("# Anna", "Heldin", "A", "- Alter: 17", "", "Mag Tee"), bible.lines)
    }

    @Test
    fun pdfsImagesInkAssetsAndTextFilesKeepTheirKind() {
        assertIs<ConflictPreview.Pdf>(previewOfVersion(listOf(ConflictFileBytes("Skript.pdf", byteArrayOf(1, 2, 3)))))
        val image = previewOfVersion(listOf(ConflictFileBytes("Bild.JPG", byteArrayOf(1))))
        assertIs<ConflictPreview.Image>(image)
        assertEquals("image/jpeg", image.mime)
        val ink = previewOfVersion(listOf(file(".fanotes/assets/abc.json", inkDocument().toJson().stringify())))
        assertIs<ConflictPreview.Ink>(ink)
        assertEquals(1, ink.strokes)
        val text = previewOfVersion(listOf(file("daten.csv", "a,b\r\n1,2")))
        assertIs<ConflictPreview.Text>(text)
        assertEquals(listOf("a,b", "1,2"), text.lines)
        assertIs<ConflictPreview.Binary>(previewOfVersion(listOf(ConflictFileBytes("x.bin", byteArrayOf(0, 1)))))
    }

    @Test
    fun changedLinesMarkWhatDiffersOnBothSides() {
        val changed = changedLines(listOf("a", "b", "c"), listOf("a", "x", "c", "d"))
        assertEquals(setOf(1), changed.original)
        assertEquals(setOf(1, 3), changed.copy)
        assertTrue(changedLines(listOf("a"), listOf("a")).original.isEmpty())
    }

    @Test
    fun sizesReadInGerman() {
        assertEquals("512 B", conflictSizeLabel(512))
        assertEquals("12 KB", conflictSizeLabel(12 * 1024 + 5))
        assertEquals("1,5 MB", conflictSizeLabel(1_572_864))
    }
}
