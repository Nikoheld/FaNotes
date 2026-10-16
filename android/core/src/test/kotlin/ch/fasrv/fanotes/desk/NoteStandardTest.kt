package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.famd.parseFamd
import ch.fasrv.fanotes.famd.serializeFamd
import ch.fasrv.fanotes.ink.OVERLAY_QUALITY
import ch.fasrv.fanotes.json.jsonArray
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonObject
import ch.fasrv.fanotes.json.jsonString
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NoteStandardTest {
    @Test
    fun anOldInkPageIsStampedWithoutTouchingTheWriting() {
        val source = famd(quality = 1.0)
        val converted = convertFamdToCurrentStandard(source)
        assertTrue(converted.converted)
        val payload = parseFamd(converted.source).payload!!
        assertEquals(OVERLAY_QUALITY, payload.obj("ink")!!.double("overlayQuality"))
        assertEquals(6.0, payload.obj("ink")!!.double("overlayQualityZoom"))
        assertEquals("# Hallo", parseFamd(converted.source).markdown.trim())
        assertEquals(listOf("sheet-1"), stringWorksheets(payload))
        assertEquals("dots", payload.string("paperStyle"))
        val again = convertFamdToCurrentStandard(converted.source)
        assertFalse(again.converted)
        assertEquals(converted.source, again.source)
    }

    @Test
    fun emptyOrCurrentInkIsLeftAlone() {
        assertFalse(convertFamdToCurrentStandard(famd(quality = OVERLAY_QUALITY)).converted)
        assertFalse(convertFamdToCurrentStandard(famd(quality = 1.0, strokes = false)).converted)
        assertFalse(convertFamdToCurrentStandard("# Nur Text\n").converted)
    }

    @Test
    fun historyFilesAreNotConvertibleNotes() {
        assertTrue(isConvertibleFamdPath("Schule/Blatt.famd"))
        assertFalse(isConvertibleFamdPath(".fanotes/history/Blatt.famd"))
        assertFalse(isConvertibleFamdPath("Schule/.fanotes/history/Blatt.famd"))
        assertFalse(isConvertibleFamdPath("Schule/Blatt.md"))
    }

    private fun famd(quality: Double, strokes: Boolean = true): String {
        val strokeList = if (strokes) {
            jsonArray(jsonObject(
                "points" to jsonArray(jsonObject("x" to jsonNumber(0.2), "y" to jsonNumber(0.4))),
                "baseWidth" to jsonNumber(3.0),
            ))
        } else {
            jsonArray()
        }
        return serializeFamd(
            "# Hallo\n",
            jsonObject(
                "schema" to jsonString("fanotes-famd-v1"),
                "updatedAt" to jsonString("2020-01-01T00:00:00.000Z"),
                "ink" to jsonObject(
                    "overlayQuality" to jsonNumber(quality),
                    "overlayQualityZoom" to jsonNumber(1.0),
                    "strokes" to strokeList,
                ),
                "worksheets" to jsonArray(jsonString("sheet-1")),
                "paperStyle" to jsonString("dots"),
            ),
        )
    }

    private fun stringWorksheets(payload: ch.fasrv.fanotes.json.JsonValue.Obj) =
        payload.array("worksheets")!!.items.map { (it as ch.fasrv.fanotes.json.JsonValue.Str).value }
}
