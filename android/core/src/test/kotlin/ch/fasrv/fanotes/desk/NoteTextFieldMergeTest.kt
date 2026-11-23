package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.emptyFamdPayload
import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.stringify
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class NoteTextFieldMergeTest {
    private fun fixture(encoding: String): String =
        requireNotNull(javaClass.getResourceAsStream("/textfields/desktop-$encoding.famd")).use { it.readBytes().decodeToString() }

    private fun box(id: String, text: String, stamp: Long? = null, x: Double = 0.2) =
        NoteTextField(id = id, page = 1, x = x, y = 0.3, width = 0.3, text = text, fontSize = 16, updatedAt = stamp)

    @Test
    fun aDesktopFileWithStampsTombstonesAndMarkdownRoundTripsThroughAnAndroidEdit() {
        for (encoding in listOf("v1", "v2")) {
            val document = parseFamd(fixture(encoding))
            val payload = document.payload!!
            val fields = parseNoteTextFields(payload.array("textFields"))
            assertEquals(listOf("tf-desk-md", "tf-plain"), fields.map { it.id }, encoding)
            val desk = fields.first()
            assertEquals(1763368200000L, desk.updatedAt, encoding)
            assertEquals("#2563c9", desk.color)
            assertTrue(desk.bold)
            assertEquals(20, desk.fontSize)
            assertTrue(desk.text.startsWith("# Aufgabe\n- [ ] lesen"), "Markdown is stored raw")
            assertNull(fields[1].updatedAt, "a box from an older build has no stamp")
            assertEquals(listOf(NoteTextFieldTombstone("tf-weg", 1763368100000L)), parseNoteTextFieldTombstones(payload.array("textFieldTombstones")))

            // Android ticks the task, resets the colour and deletes the old box.
            val now = 1763368300000L
            val ticked = patchNoteTextField(fields, "tf-desk-md", text = toggleNoteTextTask(desk.text, 2), now = now)
            val black = restyleNoteTextField(ticked, "tf-desk-md", setColor = true, color = null, now = now + 1)
            val (afterDelete, remaining) = deleteNoteTextFieldInPayload(writeNoteTextFields(payload, black), black, "tf-plain", now + 2)
            val saved = serializeFamd(document.markdown, afterDelete, encoding)

            val back = parseFamd(saved).payload!!
            val boxes = parseNoteTextFields(back.array("textFields"))
            assertEquals(remaining, boxes)
            val edited = boxes.single()
            assertEquals("# Aufgabe\n- [x] lesen\n- [x] **fertig**\n[Quelle](https://example.org)", edited.text)
            assertNull(edited.color, "default ink is written without a colour, as desktop does")
            assertTrue(edited.bold)
            assertEquals(now + 1, edited.updatedAt, "the newest edit stamps the box")
            val tombstones = parseNoteTextFieldTombstones(back.array("textFieldTombstones"))
            assertEquals(listOf("tf-plain", "tf-weg"), tombstones.map { it.id }, "newest first, the desktop's tombstone kept")
            assertEquals(now + 2, tombstones.first().deletedAt)
            // Exactly the keys and number forms the desktop parser reads.
            val json = back.array("textFields")!!.stringify()
            assertTrue(json.contains("\"updatedAt\":1763368300001"), json)
            assertFalse(json.contains("\"color\""), json)
            assertTrue(back.array("textFieldTombstones")!!.stringify().contains("\"deletedAt\":1763368300002"))
        }
    }

    @Test
    fun deletingTheLastBoxKeepsOnlyTheTombstone() {
        val payload = parseFamd(fixture("v1")).payload!!
        var fields = parseNoteTextFields(payload.array("textFields"))
        var current = payload
        for (id in fields.map { it.id }) {
            val (next, left) = deleteNoteTextFieldInPayload(current, fields, id, 1763368400000L)
            current = next
            fields = left
        }
        assertNull(current.array("textFields"))
        assertEquals(3, parseNoteTextFieldTombstones(current.array("textFieldTombstones")).size)
        val (same, unchanged) = deleteNoteTextFieldInPayload(current, fields, "nope", 1763368400000L)
        assertEquals(emptyList(), unchanged)
        assertEquals(current.stringify(), same.stringify())
    }

    @Test
    fun applyOpsFollowsTheDesktopRules() {
        val now = 1_000_000L
        val disk = listOf(box("a", "disk a", 500), box("b", "disk b", 900))
        // An older edit loses to a newer one on disk; a newer one wins.
        val stale = applyNoteTextFieldOps(disk, emptyList(), NoteTextFieldOps(listOf(box("b", "old b", 800)), emptyList()), now)
        assertEquals("disk b", stale.fields.first { it.id == "b" }.text)
        val fresh = applyNoteTextFieldOps(disk, emptyList(), NoteTextFieldOps(listOf(box("b", "new b", 950)), emptyList()), now)
        assertEquals("new b", fresh.fields.first { it.id == "b" }.text)
        // A delete older than the edit on disk does not remove the box; a newer one does and leaves a tombstone.
        val keep = applyNoteTextFieldOps(disk, emptyList(), NoteTextFieldOps(emptyList(), listOf(NoteTextFieldTombstone("a", 400))), now)
        assertEquals(2, keep.fields.size)
        val gone = applyNoteTextFieldOps(disk, emptyList(), NoteTextFieldOps(emptyList(), listOf(NoteTextFieldTombstone("a", 600))), now)
        assertEquals(listOf("b"), gone.fields.map { it.id })
        assertEquals(listOf(NoteTextFieldTombstone("a", 600)), gone.tombstones)
        // An edit older than a tombstone stays deleted; the very same millisecond keeps the box.
        val dead = applyNoteTextFieldOps(emptyList(), listOf(NoteTextFieldTombstone("c", 700)), NoteTextFieldOps(listOf(box("c", "late", 650)), emptyList()), now)
        assertTrue(dead.fields.isEmpty())
        val tie = applyNoteTextFieldOps(listOf(box("d", "x", 700)), emptyList(), NoteTextFieldOps(emptyList(), listOf(NoteTextFieldTombstone("d", 700))), now)
        assertEquals(listOf("d"), tie.fields.map { it.id })
        // A clock far ahead is clamped, so it cannot win every later conflict.
        val skewed = applyNoteTextFieldOps(listOf(box("e", "future", now + 10 * NOTE_TEXT_FIELD_CLOCK_SKEW_MS)), emptyList(), NoteTextFieldOps(listOf(box("e", "now", now + NOTE_TEXT_FIELD_CLOCK_SKEW_MS)), emptyList()), now)
        assertEquals("now", skewed.fields.single().text)
        // Old tombstones expire.
        val expired = applyNoteTextFieldOps(emptyList(), listOf(NoteTextFieldTombstone("f", now - NOTE_TEXT_FIELD_TOMBSTONE_TTL_MS - 1)), NoteTextFieldOps(emptyList(), emptyList()), now)
        assertTrue(expired.tombstones.isEmpty())
    }

    @Test
    fun threeWayMergeKeepsBothSidesWork() {
        val base = listOf(box("a", "a", 1), box("b", "b", 1), box("c", "c", 1))
        val local = listOf(box("a", "a local", 5), box("c", "c", 1), box("n", "new here", 6))
        val remote = listOf(box("a", "a", 1), box("b", "b remote", 4), box("r", "new there", 7))
        val merged = mergeNoteTextFields(base, local, remote)
        // c was deleted on the other side and not edited here; b was deleted here but edited there.
        assertEquals(listOf("a", "n", "b", "r"), merged.map { it.id })
        assertEquals("a local", merged.first().text)
        assertEquals("b remote", merged.first { it.id == "b" }.text)
        // Both edited: the newer stamp wins, a tie stays local.
        assertEquals("there", mergeNoteTextFields(base, listOf(box("a", "here", 3)), listOf(box("a", "there", 4))).single().text)
        assertEquals("here", mergeNoteTextFields(base, listOf(box("a", "here", 4)), listOf(box("a", "there", 4))).single().text)
    }

    @Test
    fun saveMergeLeavesAnUnchangedDiskAloneAndAppliesOnlyOwnChangesOtherwise() {
        val base = listOf(box("a", "a", 10), box("b", "b", 10))
        val local = listOf(box("a", "a edited", 20))
        val quiet = noteTextFieldsForSave(base, local, emptyList(), base, emptyList(), 100)
        assertSame(local, quiet.fields)
        // Meanwhile the desktop added a box and edited b; this device edited a and deleted b earlier than that edit.
        val disk = listOf(box("a", "a", 10), box("b", "b desktop", 30), box("d", "desktop new", 30))
        val merged = noteTextFieldsForSave(base, local, emptyList(), disk, listOf(NoteTextFieldTombstone("x", 50)), 25)
        assertEquals(listOf("a", "b", "d"), merged.fields.map { it.id })
        assertEquals("a edited", merged.fields.first().text)
        assertEquals("b desktop", merged.fields[1].text, "the newer desktop edit beats this device's older delete")
        assertEquals(listOf("x"), merged.tombstones.map { it.id })
    }

    @Test
    fun fontSizeLadderAndStylesMatchTheDesktopToolbar() {
        assertEquals(18, stepNoteTextFieldFontSize(16, 1))
        assertEquals(14, stepNoteTextFieldFontSize(16, -1))
        assertEquals(48, stepNoteTextFieldFontSize(48, 1))
        assertEquals(10, stepNoteTextFieldFontSize(10, -1))
        assertEquals(24, stepNoteTextFieldFontSize(22, 1), "an odd size snaps up to the next rung")
        assertEquals(20, stepNoteTextFieldFontSize(22, -1))
        assertEquals(6, NOTE_TEXT_FIELD_COLORS.size)
        assertNull(NOTE_TEXT_FIELD_COLORS.first().value)
        val fields = listOf(box("a", "x", 10))
        assertSame(fields, restyleNoteTextField(fields, "a", bold = false), "no change, no new stamp")
        val big = restyleNoteTextField(fields, "a", fontSize = 28, now = 5)
        assertEquals(28, big.single().fontSize)
        assertEquals(11L, big.single().updatedAt, "always newer than the old stamp")
        assertEquals(16, restyleNoteTextField(fields, "a", fontSize = 99).single().fontSize, "outside the ladder range is ignored")
        val red = restyleNoteTextField(fields, "a", setColor = true, color = "#C62F4A", now = 20)
        assertEquals("#c62f4a", red.single().color)
        assertNull(restyleNoteTextField(red, "a", setColor = true, color = null, now = 30).single().color)
        assertEquals(24, placeNoteTextField(NoteLinkPoint(1, 0.1, 0.1), fontSize = 24).fontSize, "a new box takes the remembered size")
    }

    @Test
    fun junkTombstonesAreDropped() {
        val array = ch.fasrv.fanotes.json.parseJson(
            """[{"id":"ok","deletedAt":5},{"id":"ok","deletedAt":9},{"id":"bad id!","deletedAt":5},{"id":"z","deletedAt":-1},{"id":"y"},"x"]""",
        ) as JsonValue.Arr
        assertEquals(listOf(NoteTextFieldTombstone("ok", 9)), parseNoteTextFieldTombstones(array))
    }

    @Test
    fun desktopsSheetBasisSurvivesAnAndroidRoundTripAndIsDroppedWhenAndroidMovesTheBox() {
        val basis = box("tf-basis", "Text", stamp = 1763368200000L).copy(aspect = 2.25)
        val plain = box("tf-plain", "Alt", stamp = 1763368200000L)
        val payload = writeNoteTextFields(emptyFamdPayload("2026-11-01T00:00:00.000Z"), listOf(basis, plain))
        for (encoding in listOf("v1", "v2")) {
            val back = parseNoteTextFields(parseFamd(serializeFamd("# x", payload, encoding)).payload!!.array("textFields"))
            assertEquals(2.25, back.first { it.id == "tf-basis" }.aspect, encoding)
            assertNull(back.first { it.id == "tf-plain" }.aspect, "an old box stays without a basis")
        }
        val texted = patchNoteTextField(listOf(basis), "tf-basis", text = "neu", now = 1763368300000L)
        assertEquals(2.25, texted.single().aspect, "editing the text keeps the basis of y")
        val moved = patchNoteTextField(listOf(basis), "tf-basis", y = 0.5, now = 1763368300000L)
        assertNull(moved.single().aspect, "y is a fraction of this device's sheet after Android moved the box")
        assertFalse(sameNoteTextFieldContent(basis, basis.copy(aspect = 2.5)), "a changed basis is a change that gets saved")
        assertEquals(2.25, parseNoteTextFieldList(listOf(basis.copy(aspect = 2.25))).single().aspect)
        assertNull(parseNoteTextFieldList(listOf(basis.copy(aspect = 0.0))).single().aspect, "an implausible basis is ignored")
    }
}
