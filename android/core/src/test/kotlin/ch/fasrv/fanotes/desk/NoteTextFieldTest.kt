package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNull
import ch.fasrv.fanotes.json.jsonNumber
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
        assertFalse(written.contains("color") || written.contains("bold") || written.contains("updatedAt"), "old files stay free of the new keys")
        assertNull(old.single().updatedAt)

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

    private fun desktopBox(id: String, text: String, updatedAt: JsonValue?): JsonValue.Obj = jsonObject(
        "id" to jsonString(id),
        "page" to jsonNumber(1.0),
        "x" to jsonNumber(0.2),
        "y" to jsonNumber(0.3),
        "width" to jsonNumber(0.3),
        "fontSize" to jsonNumber(16.0),
        "text" to jsonString(text),
        "updatedAt" to updatedAt,
    )

    /** What desktop writes once boxes are merged one by one: edit stamps, and deleted boxes in a key of their own. */
    private fun desktopPayload(): JsonValue.Obj = jsonObject(
        "schema" to jsonString("fanotes-famd-v1"),
        "updatedAt" to jsonString("2026-11-16T10:00:00.000Z"),
        "ink" to jsonNull(),
        "worksheets" to jsonArray(),
        "textFields" to JsonValue.Arr(mutableListOf(desktopBox("tf-desk", "von Desktop", jsonNumber(1731800000000.0)))),
        "textFieldTombstones" to JsonValue.Arr(mutableListOf(jsonObject(
            "id" to jsonString("tf-gone"),
            "deletedAt" to jsonNumber(1731800000500.0),
        ))),
    )

    @Test
    fun editStampsAndTombstonesFromDesktopSurviveAnAndroidSave() {
        for (encoding in listOf("v1", "v2")) {
            val document = parseFamd(serializeFamd("Text\n", desktopPayload(), encoding))
            val fields = parseNoteTextFields(document.payload?.array("textFields"))
            assertEquals(1731800000000L, fields.single().updatedAt, "$encoding: the stamp is read")

            // A save that touches nothing keeps both keys byte for byte.
            val untouched = parseFamd(serializeFamd("Text\n", writeNoteTextFields(document.payload!!, fields), encoding))
            assertEquals(1731800000000L, parseNoteTextFields(untouched.payload?.array("textFields")).single().updatedAt, "$encoding: stamp kept")
            val tombstone = untouched.payload?.array("textFieldTombstones")?.items?.single() as JsonValue.Obj
            assertEquals("tf-gone", tombstone.string("id"), "$encoding: the tombstone is kept")
            assertEquals(1731800000500.0, tombstone.double("deletedAt"), "$encoding: the tombstone time is kept")

            // An edit on Android stamps the box with a newer time, so desktop can tell it is the later edit.
            val edited = patchNoteTextField(fields, "tf-desk", text = "von Android", now = 1731800009000L)
            assertEquals(1731800009000L, edited.single().updatedAt)
            val saved = parseFamd(serializeFamd("Text\n", writeNoteTextFields(document.payload!!, edited), encoding))
            val back = parseNoteTextFields(saved.payload?.array("textFields")).single()
            assertEquals("von Android", back.text)
            assertEquals(1731800009000L, back.updatedAt, "$encoding: the new stamp is written")
            assertEquals(1, saved.payload?.array("textFieldTombstones")?.items?.size, "$encoding: the tombstone still there")

            // A deleted box is gone from the list; the other desktop keys stay out of its way.
            val emptied = writeNoteTextFields(document.payload!!, removeNoteTextField(fields, "tf-desk"))
            assertNull(emptied.array("textFields"))
            assertEquals(1, parseFamd(serializeFamd("Text\n", emptied, encoding)).payload?.array("textFieldTombstones")?.items?.size)
        }
    }

    @Test
    fun aStampIsOnlyTakenWhenItIsAPositiveWholeTime() {
        fun parsed(stamp: JsonValue?) = parseNoteTextFields(JsonValue.Arr(mutableListOf(desktopBox("tf-x", "a", stamp)))).single()
        assertEquals(1731800000000L, parsed(jsonNumber(1731800000000.0)).updatedAt)
        assertNull(parsed(null).updatedAt)
        assertNull(parsed(jsonNumber(0.0)).updatedAt)
        assertNull(parsed(jsonNumber(-5.0)).updatedAt)
        assertNull(parsed(jsonNumber(1e300)).updatedAt)
        assertNull(parsed(jsonString("1731800000000")).updatedAt)
        assertFalse(noteTextFieldsJson(listOf(parsed(jsonNumber(0.0)))).stringify().contains("updatedAt"))
    }

    @Test
    fun onlyARealChangeStampsABoxAndANewStampIsAlwaysNewer() {
        val placed = placeNoteTextField(NoteLinkPoint(1, 0.1, 0.1), id = "tf-p", now = 1000L)
        assertEquals(1000L, placed.updatedAt)
        val same = patchNoteTextField(listOf(placed), "tf-p", text = "", now = 9000L)
        assertEquals(listOf(placed), same, "a patch that changes nothing keeps the box and its stamp")
        val typed = patchNoteTextField(listOf(placed), "tf-p", text = "a", now = 2000L)
        assertEquals(2000L, typed.single().updatedAt)
        val slowClock = patchNoteTextField(typed, "tf-p", text = "ab", now = 100L)
        assertEquals(2001L, slowClock.single().updatedAt, "a clock that runs behind never stamps a box older than its last edit")
        val unstamped = patchNoteTextField(listOf(placed.copy(updatedAt = null)), "tf-p", x = 0.5, now = 3000L)
        assertEquals(3000L, unstamped.single().updatedAt)
    }
}
