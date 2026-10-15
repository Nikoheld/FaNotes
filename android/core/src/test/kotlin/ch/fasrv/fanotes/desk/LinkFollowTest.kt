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
        assertEquals("Beweis", alias?.anchor)
        assertFalse(alias?.web == true)
        assertEquals(
            FollowedLink("Algebra.md", false, "Beweis"),
            followedLinkAt("[Name](Algebra.md#Beweis)", 1),
        )
        assertEquals("Lokal", followedLinkAt(note, note.indexOf("Lokal"))?.target)
        assertEquals(FollowedLink("mailto:ada@example.com", true), followedLinkAt("[Mail](mailto:ada@example.com)", 1))
        assertNull(followedLinkAt(note, 0))
        assertNull(followedLinkAt(note, note.indexOf("https")))
        val script = followedLinkAt("[Text](javascript:alert(1))", 1)
        assertEquals("javascript:alert(1", script?.target)
        assertFalse(script?.web == true)
        assertEquals(FollowedLink("https://example.com/a", true), followedTarget("https://example.com/a"))
        assertEquals(FollowedLink("mailto:ada@example.com", true), followedTarget(" mailto:ada@example.com "))
        assertEquals(FollowedLink("Algebra.md", false, "Beweis"), followedTarget("Algebra.md#Beweis"))
        assertNull(followedTarget("   "))
        assertNull(followedTarget("#nur-anker"))
    }
}