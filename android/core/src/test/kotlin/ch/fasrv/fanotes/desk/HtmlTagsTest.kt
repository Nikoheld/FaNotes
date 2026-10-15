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
}
