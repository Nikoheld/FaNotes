package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class HtmlTagsTest {
    @Test
    fun typingALessThanSignOffersTheDesktopHtmlTags() {
        val open = htmlTagCompletion("Siehe <", 7)
        assertEquals(6, open?.from)
        assertEquals("<a", open?.options?.first())
        assertEquals("<wbr", open?.options?.last())
        assertEquals(112, open?.options?.size)
        assertEquals(listOf("<del", "<details"), htmlTagCompletion("Siehe <de", 9)?.options)
        assertEquals(listOf("<div"), htmlTagCompletion("Siehe <di", 9)?.options)
        assertNull(htmlTagCompletion("Hallo", 5))
        assertNull(htmlTagCompletion("<!-- noch <", 11))
        assertNull(htmlTagCompletion("`noch <`", 7))
        assertNull(htmlTagCompletion("![Bild](https://<x>)", 17))
        val fenced = "```\n<\n```"
        assertNull(htmlTagCompletion(fenced, fenced.indexOf("<") + 1))
        assertTrue(htmlTagCompletion("Siehe <div", 10)?.options?.contains("<div") == true)
    }

    @Test
    fun attributesAndClosingTagsFollowTheDesktopHtmlSchema() {
        val names = htmlTagCompletion("<a ", 3)
        assertEquals("href", names?.options?.first())
        assertTrue(names?.options?.contains("class") == true)
        assertEquals(listOf("href", "hreflang"), htmlTagCompletion("<a hr", 5)?.options)
        val target = htmlTagCompletion("<a target=", 10)
        assertEquals(listOf("_blank", "_self", "_top", "_parent"), target?.options)
        assertEquals(listOf("\"_blank\"", "\"_self\"", "\"_top\"", "\"_parent\""), target?.inserts)
        val quoted = htmlTagCompletion("<a target=\"_b", 13)
        assertEquals(listOf("_blank"), quoted?.options)
        assertEquals(listOf("_blank\""), quoted?.inserts)
        assertEquals(listOf("_blank"), htmlTagCompletion("<a target=\"_b\"", 13)?.inserts)
        assertNull(htmlTagCompletion("<div class=", 11))
        assertEquals(listOf("open"), htmlTagCompletion("<details ", 9)?.options?.take(1))
        val opened = htmlAutoClose("<div", 4, 0, "<div>")
        assertEquals("<div></div>", opened?.text)
        assertEquals(5, opened?.selectionStart)
        assertNull(htmlAutoClose("<br", 3, 0, "<br>"))
        assertNull(htmlAutoClose("<img/", 5, 0, "<img/>"))
        assertNull(htmlAutoClose("1 < 2 ", 6, 0, "1 < 2 >"))
        val nested = htmlAutoClose("<div><span><", 12, 0, "<div><span></")
        assertEquals("<div><span></span>", nested?.text)
        assertEquals(nested?.text?.length, nested?.selectionStart)
        val fenced = "```\n<div>\n```"
        val gt = fenced.indexOf('>')
        assertNull(htmlAutoClose(fenced.removeRange(gt, gt + 1), gt, 0, fenced))
    }
}
