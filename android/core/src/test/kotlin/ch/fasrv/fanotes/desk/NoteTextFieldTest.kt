package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.json.stringify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteTextFieldTest {
    @Test
    fun plainPageWithoutWorksheetBitmapStoresANoteTextField() {
        val markdown = "# Notiz\n\n- [ ] Aufgabe\n"
        val tap = commitArmedTextFieldTap(
            armed = true,
            x = 0.25,
            y = 0.4,
            frames = emptyList(),
            sourceWidth = 900.0,
            sourceHeight = 1200.0,
            existing = emptyList(),
            id = "tf-plain",
        )
        val placed = checkNotNull(tap.placed)
        assertEquals("tf-plain", placed.id)
        assertEquals(1, placed.page)
        assertEquals(0.25, placed.x, 0.0001)
        assertEquals(0.4, placed.y, 0.0001)
        assertEquals(NOTE_TEXT_FIELD_WIDTH, placed.width, 0.0001)
        assertEquals(NOTE_TEXT_FIELD_FONT, placed.fontSize)
        assertEquals("", placed.text)
        assertFalse(tap.stillPlacing)
        assertNull(tap.message)
        assertEquals(listOf(placed), tap.fields)

        val stored = writeNoteTextFields(
            jsonObject("schema" to jsonString("fanotes-famd-v1")),
            tap.fields,
        )
        assertFalse(stored.stringify().contains("fanotes-text-field"))
        val famd = serializeFamd(markdown, stored)
        val document = parseFamd(famd)
        assertEquals(markdown.trimEnd(), document.markdown)
        assertFalse(document.markdown.contains("fanotes-text-field"))
        val read = parseNoteTextFields(document.payload?.array("textFields")).single()
        assertEquals(placed, read)
    }

    @Test
    fun tapNearThePageEdgeKeepsTheFieldOnTheSheet() {
        val tap = commitArmedTextFieldTap(
            armed = true,
            x = 0.95,
            y = 0.99,
            frames = emptyList(),
            sourceWidth = 900.0,
            sourceHeight = 1200.0,
            existing = emptyList(),
            id = "tf-edge",
        )
        assertEquals(1.0 - NOTE_TEXT_FIELD_WIDTH, tap.placed?.x ?: -1.0, 0.0001)
        assertEquals(0.92, tap.placed?.y ?: -1.0, 0.0001)
        assertEquals(1, tap.placed?.page)
    }

    @Test
    fun aSecondFieldIsKeptAndTheTwoHundredthBlocksAnother() {
        val first = commitArmedTextFieldTap(
            armed = true,
            x = 0.1,
            y = 0.2,
            frames = emptyList(),
            sourceWidth = 800.0,
            sourceHeight = 1000.0,
            existing = emptyList(),
            id = "tf-one",
        )
        val second = commitArmedTextFieldTap(
            armed = true,
            x = 0.3,
            y = 0.5,
            frames = emptyList(),
            sourceWidth = 800.0,
            sourceHeight = 1000.0,
            existing = first.fields,
            id = "tf-two",
        )
        assertEquals(listOf("tf-one", "tf-two"), second.fields.map { it.id })
        assertEquals("tf-one", second.fields[0].id)
        assertEquals(0.1, second.fields[0].x, 0.0001)

        val full = (0 until NOTE_TEXT_FIELD_LIMIT).map { index ->
            placeNoteTextField(NoteLinkPoint(1, 0.1, 0.1), id = "tf-$index")
        }
        val blocked = commitArmedTextFieldTap(
            armed = true,
            x = 0.2,
            y = 0.2,
            frames = emptyList(),
            sourceWidth = 800.0,
            sourceHeight = 1000.0,
            existing = full,
            id = "tf-extra",
        )
        assertNull(blocked.placed)
        assertEquals(TEXT_FIELD_LIMIT_MESSAGE, blocked.message)
        assertTrue(blocked.stillPlacing)
        assertEquals(NOTE_TEXT_FIELD_LIMIT, blocked.fields.size)
        assertFalse(blocked.fields.any { it.id == "tf-extra" })
    }

    @Test
    fun pdfPageFramesChooseThatPageAndAnIdleTapStoresNothing() {
        val frames = listOf(
            PageFrame(page = 1, top = 0.0, height = 1000.0, width = 900.0),
            PageFrame(page = 2, top = 1040.0, height = 1000.0, width = 900.0),
        )
        val tap = commitArmedTextFieldTap(
            armed = true,
            x = 0.2,
            y = 1200.0 / 2040.0,
            frames = frames,
            sourceWidth = 900.0,
            sourceHeight = 2040.0,
            existing = emptyList(),
            id = "tf-page",
        )
        assertEquals(2, tap.placed?.page)
        val idle = commitArmedTextFieldTap(
            armed = false,
            x = 0.2,
            y = 0.2,
            frames = emptyList(),
            sourceWidth = 900.0,
            sourceHeight = 1000.0,
            existing = tap.fields,
            id = "tf-idle",
        )
        assertNull(idle.placed)
        assertEquals(tap.fields, idle.fields)
        assertFalse(idle.stillPlacing)
    }

    @Test
    fun desktopColourAndBoldSurviveParseMoveAndWrite() {
        val legacy = ch.fasrv.fanotes.json.JsonValue.Arr(mutableListOf(jsonObject(
            "id" to jsonString("tf-old"),
            "page" to ch.fasrv.fanotes.json.jsonNumber(1.0),
            "x" to ch.fasrv.fanotes.json.jsonNumber(0.2),
            "y" to ch.fasrv.fanotes.json.jsonNumber(0.3),
            "width" to ch.fasrv.fanotes.json.jsonNumber(0.3),
            "fontSize" to ch.fasrv.fanotes.json.jsonNumber(16.0),
            "text" to jsonString("alt"),
        )))
        val old = parseNoteTextFields(legacy)
        assertNull(old.single().color)
        assertFalse(old.single().bold)
        val written = noteTextFieldsJson(old).stringify()
        assertFalse(written.contains("color") || written.contains("bold"), "old files stay free of the new keys")

        val styled = ch.fasrv.fanotes.json.JsonValue.Arr(mutableListOf(jsonObject(
            "id" to jsonString("tf-new"),
            "page" to ch.fasrv.fanotes.json.jsonNumber(2.0),
            "x" to ch.fasrv.fanotes.json.jsonNumber(0.2),
            "y" to ch.fasrv.fanotes.json.jsonNumber(0.3),
            "width" to ch.fasrv.fanotes.json.jsonNumber(0.3),
            "fontSize" to ch.fasrv.fanotes.json.jsonNumber(18.0),
            "text" to jsonString("blau"),
            "color" to jsonString("#2563C9"),
            "bold" to ch.fasrv.fanotes.json.JsonValue.Bool(true),
        )))
        val fields = parseNoteTextFields(styled)
        assertEquals("#2563c9", fields.single().color)
        assertTrue(fields.single().bold)
        val moved = patchNoteTextField(fields, "tf-new", x = 0.4, text = "blau!")
        assertEquals("#2563c9", moved.single().color)
        assertTrue(moved.single().bold)
        val reparsed = parseNoteTextFields(noteTextFieldsJson(moved))
        assertEquals(moved, reparsed)
        val junk = parseNoteTextFields(ch.fasrv.fanotes.json.JsonValue.Arr(mutableListOf(jsonObject(
            "id" to jsonString("tf-x"), "color" to jsonString("red"),
        ))))
        assertNull(junk.single().color)
    }
}
