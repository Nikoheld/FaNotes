package ch.fasrv.fanotes.famd

import kotlin.test.Test
import kotlin.test.assertEquals

class WorksheetAttachTest {
    @Test
    fun attachingFollowsTheDesktopSeparatorAndDoesNotRepeat() {
        val id = "sheet-1"
        assertEquals("<!-- fanotes-worksheet:$id -->\n", attachWorksheet("", id))
        assertEquals("Hallo\n\n<!-- fanotes-worksheet:$id -->\n", attachWorksheet("Hallo", id))
        assertEquals("Hallo\n\n<!-- fanotes-worksheet:$id -->\n", attachWorksheet("Hallo\n", id))
        val once = attachWorksheet("Hallo", id)
        assertEquals(once, attachWorksheet(once, id))
        assertEquals("Hallo", attachWorksheet("Hallo", "bad id"))
        val removed = detachWorksheet("Hallo\n\n<!-- fanotes-worksheet:$id -->\n", id)
        assertEquals("Hallo\n", removed)
        assertEquals("Hallo", detachWorksheet("Hallo", "../x"))
    }
}