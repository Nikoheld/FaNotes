package ch.fasrv.fanotes.famd

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import ch.fasrv.fanotes.vault.DirectoryVault
import ch.fasrv.fanotes.vault.NoteStore
import java.nio.file.Files
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class FamdCodecTest {
    @Test
    fun serializesTheDesktopPayloadShape() {
        val payload = emptyFamdPayload("2026-01-02T03:04:05.000Z")
        val text = serializeFamd("Hello", payload)
        val json = """{"schema":"fanotes-famd-v1","updatedAt":"2026-01-02T03:04:05.000Z","ink":null,"worksheets":[]}"""
        assertEquals("Hello\n\n<!-- fanotes-famd:v1 chars=${json.length} -->\n$json\n", text)
        val parsed = parseFamd(text)
        assertEquals("Hello", parsed.markdown)
        assertEquals(FAMD_SCHEMA, parsed.payload?.string("schema"))
        assertNull(parsed.payload?.obj("ink"))
    }

    @Test
    fun roundTripKeepsPageStatsAndMarkdown() {
        val stats = ch.fasrv.fanotes.json.JsonValue.Obj().also {
            it.put("createdAt", ch.fasrv.fanotes.json.jsonString("2026-01-02T03:04:05.000Z"))
            it.put("modifiedAt", ch.fasrv.fanotes.json.jsonString("2026-01-02T03:04:05.000Z"))
            it.put("customCounter", ch.fasrv.fanotes.json.jsonNumber(12.0))
        }
        val payload = emptyFamdPayload("2026-01-02T03:04:05.000Z")
        payload.put("pageStats", stats)
        payload.put("paperStyle", ch.fasrv.fanotes.json.jsonString("lines"))
        val source = serializeFamd("# Title\n\nBody", payload)
        val parsed = parseFamd(source)
        assertEquals("# Title\n\nBody", parsed.markdown)
        assertEquals("lines", parsed.payload?.string("paperStyle"))
        assertEquals(12.0, parsed.payload?.obj("pageStats")?.double("customCounter"))
        val again = serializeFamd(parsed.markdown, parsed.payload!!)
        assertEquals(source, again)
    }

    @Test
    fun stripsAPayloadThatLeakedIntoTheEditor() {
        val payload = emptyFamdPayload("2026-01-02T03:04:05.000Z")
        val full = serializeFamd("Note", payload)
        assertEquals("Note", stripFamdPayload(full))
        assertTrue(parseFamd("").payload == null)
    }

    @Test
    fun compactEncodingMatchesTheDesktopBytes() {
        val payload = emptyFamdPayload("2026-01-02T03:04:05.000Z")
        payload.put("ink", inkStroke())
        val text = serializeFamd("Hello", payload, "v2")
        val golden = "Hello\n\n<!-- fanotes-famd:v2 chars=278 crc=f1e3c17e -->\n" +
            """{"schema":"fanotes-famd-v2","updatedAt":"2026-01-02T03:04:05.000Z","ink":{"schemaVersion":1,"strokes":[{"color":"#3478df","baseWidth":2,"brush":"fineliner","famdPts":"!(iP8!!!!!!!)sB!!!!!!!*MR!!!!!!!*gE!!!!!!!*gEu9O(!!!!!!!!*MR!!!!!!!!.g!!!!!!!*gE!!!!!!!*gE"}]},"worksheets":[]}""" +
            "\n"
        assertEquals(golden, text)
        val parsed = parseFamd(text)
        assertEquals("Hello", parsed.markdown)
        assertEquals(FAMD_SCHEMA, parsed.payload?.string("schema"))
        assertEquals("Hello", stripFamdPayload(text))
        assertTrue(!stripFamdPayload(text).contains("famdPts"))
        val stroke = parsed.payload!!.obj("ink")!!.array("strokes")!!.items[0] as JsonValue.Obj
        assertEquals("#3478df", stroke.string("color"))
        assertEquals(2.0, stroke.double("baseWidth"))
        assertEquals("fineliner", stroke.string("brush"))
        val points = stroke.array("points")!!.items.map { it as JsonValue.Obj }
        assertTrue(abs(points[0].double("x")!! - 0.25) <= 1e-4)
        assertTrue(abs(points[0].double("y")!! - 0.5) <= 1e-4)
        assertEquals(0.5, points[0].double("pressure"))
        assertEquals(1.0, points[0].double("t"))
        assertEquals(1.0, points[1].double("x"))
        assertEquals(0.0, points[1].double("y"))
        assertEquals(2.5, points[1].double("t"))
        assertEquals(1.0, points[1].double("pressure"))
    }

    @Test
    fun aTruncatedOrChecksumFailedCompactFileIsRejected() {
        val text = serializeFamd("Hello", emptyFamdPayload("2026-01-02T03:04:05.000Z"), "v2")
        val truncated = text.substring(0, text.indexOf("fanotes-famd:v2") + 48)
        assertFailsWith<FamdCorruptException> { parseFamd(truncated) }
        val flipped = text.replace(Regex("""crc=([0-9a-f]{8})""")) { match ->
            val hex = match.groupValues[1]
            val digit = if (hex[0] == 'a') 'b' else 'a'
            "crc=$digit${hex.substring(1)}"
        }
        assertFailsWith<FamdCorruptException> { parseFamd(flipped) }
        assertEquals("Hello", stripFamdPayload(truncated))
    }

    @Test
    fun newNotesUseTheCompactEncodingAndV1EditsStayV1() {
        assertEquals("v2", famdEncodingForSave(null))
        assertEquals("v2", famdEncodingForSave(""))
        val v1 = serializeFamd("Hello", emptyFamdPayload("2026-01-02T03:04:05.000Z"))
        assertTrue(v1.contains("fanotes-famd:v1"))
        assertEquals("v1", famdEncodingForSave(v1))
        val edited = serializeFamd("Hello\n\nEdit", parseFamd(v1).payload!!, famdEncodingForSave(v1))
        assertTrue(edited.contains("fanotes-famd:v1"))
        assertTrue(!edited.contains("fanotes-famd:v2"))
        assertEquals("Hello\n\nEdit", parseFamd(edited).markdown)

        val root = Files.createTempDirectory("fanotes-famd-android")
        val vault = DirectoryVault(root)
        val store = NoteStore(vault)
        val created = store.createMarkdown("", "Neu")
        val createdFamd = vault.read("Neu.famd")!!.decodeToString()
        assertTrue(createdFamd.contains("fanotes-famd:v2"))
        assertTrue(!createdFamd.contains("fanotes-famd:v1"))
        assertTrue(store.readNote(created).markdown.trim().startsWith("# Neu"))
        assertTrue(parseFamd(createdFamd).markdown.trim().startsWith("# Neu"))

        vault.write("Alt.md", "# Alt\n\n".encodeToByteArray())
        vault.write("Alt.famd", v1.encodeToByteArray())
        val note = store.readNote("Alt.md")
        store.save(note, note.document, "# Alt\n\nEdit")
        val saved = vault.read("Alt.famd")!!.decodeToString()
        assertTrue(saved.contains("fanotes-famd:v1"))
        assertTrue(!saved.contains("fanotes-famd:v2"))
        assertTrue(parseFamd(saved).markdown.trim().startsWith("# Alt"))
        assertTrue(parseFamd(saved).markdown.contains("Edit"))
    }

    private fun inkStroke(): JsonValue.Obj {
        val stroke = JsonValue.Obj()
        stroke.put("color", jsonString("#3478df"))
        stroke.put("baseWidth", jsonNumber(2.0))
        stroke.put("brush", jsonString("fineliner"))
        val points = JsonValue.Arr()
        points.items.add(point(0.25, 0.5, 1.0, 0.5))
        points.items.add(point(1.0, 0.0, 2.5, 1.0))
        stroke.put("points", points)
        return JsonValue.Obj().also { ink ->
            ink.put("schemaVersion", jsonNumber(1.0))
            ink.put("strokes", JsonValue.Arr(mutableListOf(stroke)))
        }
    }

    private fun point(x: Double, y: Double, t: Double, pressure: Double) = JsonValue.Obj().also { point ->
        point.put("x", jsonNumber(x))
        point.put("y", jsonNumber(y))
        point.put("t", jsonNumber(t))
        point.put("pressure", jsonNumber(pressure))
    }

    @Test
    fun attachesInkMarkerOnce() {
        val once = attachNoteInk("Hello", "abc-1")
        assertEquals("Hello\n\n<!-- fanotes-ink:abc-1 -->\n", once)
        assertEquals(once, attachNoteInk(once, "other"))
        assertEquals("abc-1", noteInkId(once))
    }
}
