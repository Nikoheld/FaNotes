package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class FootnoteTest {
    @Test
    fun detailsCardsNumberFootnotesLikeThePreview() {
        val prepared = prepareFootnotes("Zuerst [^b] dann [^a] und nochmal [^b].\n\n[^a]: A\n[^b]: B\n[^weg]: Unbenutzt")
        assertEquals(listOf("B", "A"), prepared.notes)
        assertEquals("Zuerst \u00031\u0003 dann \u00032\u0003 und nochmal \u00031\u0003.", prepared.body.trimEnd())
        assertFalse(prepared.body.contains("[^weg]"))
        assertFalse(prepared.body.contains("Unbenutzt"))

        val missing = prepareFootnotes("Siehe [^fehlt] im Text.")
        assertEquals("Siehe [^fehlt] im Text.", missing.body)
        assertTrue(missing.notes.isEmpty())

        val coded = prepareFootnotes("Code `[^a]` und [^a]\n\n[^a]: Ja")
        assertEquals("Code `[^a]` und \u00031\u0003", coded.body.trim())
        assertEquals(listOf("Ja"), coded.notes)

        val fenced = prepareFootnotes("```\n[^a]: im Code\n```\n\nSiehe [^a]")
        assertTrue(fenced.body.contains("[^a]: im Code"))
        assertTrue(fenced.body.contains("[^a]"))
        assertTrue(fenced.notes.isEmpty())

        // A shorter line, or one with an info string, does not end the fence.
        // remark-gfm leaves the definition in the code block.
        val shorter = prepareFootnotes("````\ncode\n```\n[^a]: im Code\n````\n\nSiehe [^a]")
        assertTrue(shorter.body.contains("[^a]: im Code"), shorter.body)
        assertTrue(shorter.body.contains("Siehe [^a]"), shorter.body)
        assertTrue(shorter.notes.isEmpty(), shorter.notes.toString())
        val labeled = prepareFootnotes("```\ncode\n```js\n[^a]: gestohlen\n```\n\nSiehe [^a]")
        assertTrue(labeled.body.contains("[^a]: gestohlen"), labeled.body)
        assertTrue(labeled.body.contains("Siehe [^a]"), labeled.body)
        assertTrue(labeled.notes.isEmpty(), labeled.notes.toString())
        val tildeInInfo = prepareFootnotes("```foo~bar\n[^a]: drin\n```\n\nSiehe [^b]\n\n[^b]: draus")
        assertTrue(tildeInInfo.body.contains("[^a]: drin"), tildeInInfo.body)
        assertEquals(listOf("draus"), tildeInInfo.notes)
        assertTrue(tildeInInfo.body.contains("\u00031\u0003"), tildeInInfo.body)

        val continued = prepareFootnotes("[^lang]: Erste Zeile\n\n    Zweite **Zeile**\n\nDanach [^lang]")
        assertEquals("Erste Zeile\n\nZweite **Zeile**", continued.notes.single())
        assertEquals("Danach \u00031\u0003", continued.body.trim())

        val duplicate = prepareFootnotes("[^a]: Erste\n[^a]: Zweite\n\nSiehe [^a]")
        assertEquals(listOf("Erste"), duplicate.notes)
        assertFalse(duplicate.body.contains("Zweite"))

        val card = detailsReadingLines("Siehe [^note] und **fett**.\n\n[^note]: Die Quelle")
        assertEquals("Siehe 1 und fett.", card[0].text)
        val mark = card[0].inlines.first { it.kind == "footnote" }
        assertEquals("1", card[0].text.substring(mark.start, mark.end))
        assertEquals("rule", card[1].kind)
        assertEquals("footnote", card[2].kind)
        assertEquals("1. Die Quelle ↩", card[2].text)
        assertEquals(FOOTNOTE_SCALE, card[2].scale)
        val rich = detailsReadingLines("Text [^a]\n\n[^a]: Siehe **Quelle** und https://example.com/a.")
        val definition = rich.last()
        assertEquals("1. Siehe Quelle und https://example.com/a. ↩", definition.text)
        assertEquals("Quelle", definition.text.substring(definition.inlines.first { it.kind == "strong" }.let { it.start until it.end }))
        assertEquals("https://example.com/a", definition.inlines.first { it.kind == "link" }.target)
    }

    @Test
    fun footnoteMarksJumpToTheDefinitionAndBack() {
        val lines = detailsReadingLines("Siehe [^note] und nochmal [^note].\n\n[^note]: Erste Zeile\n\n    Zweite Zeile")
        val body = lines[0]
        val first = body.text.indexOf('1')
        val second = body.text.indexOf('1', first + 1)
        assertEquals(2, footnoteDefinitionIndex(lines, 1))
        assertEquals(0, footnoteReferenceIndex(lines, 1))
        assertEquals(2, footnoteJumpIndex(lines, 0, first))
        assertEquals(2, footnoteJumpIndex(lines, 0, second))
        assertEquals(null, footnoteJumpIndex(lines, 0, 0))
        assertEquals(null, footnoteDefinitionIndex(lines, 9))

        val definition = lines.last()
        assertTrue(definition.text.endsWith(FOOTNOTE_RETURN))
        assertEquals(0, footnoteJumpIndex(lines, lines.lastIndex, definition.text.lastIndexOf(FOOTNOTE_RETURN)))
        assertEquals(null, footnoteJumpIndex(lines, lines.lastIndex, definition.text.lastIndexOf(FOOTNOTE_RETURN) - 1))
        assertEquals(null, footnoteJumpIndex(lines, 2, 3))

        val pair = detailsReadingLines("Zuerst [^b] dann [^a].\n\n[^a]: A\n[^b]: B")
        val back = pair.last()
        assertEquals("2. A $FOOTNOTE_RETURN", back.text)
        assertEquals(pair.lastIndex, footnoteJumpIndex(pair, 0, pair[0].text.lastIndexOf('2')))
        assertEquals(0, footnoteJumpIndex(pair, pair.lastIndex, back.text.lastIndexOf(FOOTNOTE_RETURN)))
        assertEquals(null, footnoteNumberAtOffset(back.text, back.inlines, 0))
    }
}
