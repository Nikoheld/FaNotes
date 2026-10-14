package ch.fasrv.fanotes.famd

import kotlin.test.Test
import kotlin.test.assertEquals
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
    fun attachesInkMarkerOnce() {
        val once = attachNoteInk("Hello", "abc-1")
        assertEquals("Hello\n\n<!-- fanotes-ink:abc-1 -->\n", once)
        assertEquals(once, attachNoteInk(once, "other"))
        assertEquals("abc-1", noteInkId(once))
    }
}
