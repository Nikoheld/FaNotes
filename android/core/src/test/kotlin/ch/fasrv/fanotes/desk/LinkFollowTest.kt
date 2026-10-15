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

    @Test
    fun aPaperTapHitsTheRenderedLinkLabel() {
        assertNull(paperLinkTarget(-1, listOf(PaperTextLink(0, 4, "A"))))
        assertEquals("A", paperLinkTarget(0, listOf(PaperTextLink(0, 4, "A"))))
        assertNull(paperLinkTarget(4, listOf(PaperTextLink(0, 4, "A"))))
        assertEquals("B", paperLinkTarget(5, listOf(PaperTextLink(0, 4, "A"), PaperTextLink(5, 8, "B"))))
        assertNull(paperLinkTarget(1, listOf(PaperTextLink(0, 4, "  "))))
        val (plain, marks) = detailsPlain("Siehe [Text](https://fanotes.example) und [[Algebra#Beweis|Name]]")
        val links = marks.filter { it.kind == "link" }.map { PaperTextLink(it.start, it.end, it.target) }
        val web = paperLinkTarget(plain.indexOf("Text"), links)
        assertEquals(FollowedLink("https://fanotes.example", true), followedTarget(web!!))
        val note = paperLinkTarget(plain.indexOf("Name"), links)
        assertEquals(FollowedLink("Algebra", false, "Beweis"), followedTarget(note!!))
        assertNull(paperLinkTarget(plain.indexOf("Siehe"), links))
    }
}