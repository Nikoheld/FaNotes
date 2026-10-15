package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LinkFollowTest {
    @Test
    fun aTapOnTheVisibleLabelFollowsTheNoteOrTheWebAddress() {
        val note = "Siehe [Text](https://fanotes.example) und [[Algebra#Beweis|Name]] sowie [[Lokal]]."
        val web = followedLinkAt(note, note.indexOf("Text"))
        assertEquals("https://fanotes.example", web?.target)
        assertTrue(web?.web == true)
        val alias = followedLinkAt(note, note.indexOf("Name"))
        assertEquals("Algebra", alias?.target)
        assertFalse(alias?.web == true)
        assertEquals("Lokal", followedLinkAt(note, note.indexOf("Lokal"))?.target)
        assertEquals(FollowedLink("mailto:ada@example.com", true), followedLinkAt("[Mail](mailto:ada@example.com)", 1))
        assertNull(followedLinkAt(note, 0))
        assertNull(followedLinkAt(note, note.indexOf("https")))
        val script = followedLinkAt("[Text](javascript:alert(1))", 1)
        assertEquals("javascript:alert(1", script?.target)
        assertFalse(script?.web == true)
    }
}