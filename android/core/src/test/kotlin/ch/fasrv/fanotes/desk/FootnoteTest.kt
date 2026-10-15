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
}
