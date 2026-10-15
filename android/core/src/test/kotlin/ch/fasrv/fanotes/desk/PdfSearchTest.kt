package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class PdfSearchTest {
    @Test
    fun searchFindsLaterPagesAndKeepsTheDesktopExcerpt() {
        val pages = listOf(
            "Die Einleitung bleibt leer.",
            "Hier steht Beta und danach noch mehr Text für den Ausschnitt.",
            "beta nochmal und Beta am Ende",
        )
        assertEquals(emptyList(), searchPdfPages(pages, "  "))
        val hits = searchPdfPages(pages, "beta")
        assertEquals(listOf(2, 3, 3), hits.map { it.page })
        assertEquals(listOf(0, 0, 1), hits.map { it.index })
        assertTrue(hits[0].excerpt.contains("Beta"))
        assertTrue(hits[0].excerpt.contains("Ausschnitt") || hits[0].excerpt.length < 80)
        assertEquals(400, searchPdfPages(List(20) { "wort ".repeat(30) }, "wort").size)
    }
}