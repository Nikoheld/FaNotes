package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals

class SyntaxMotionTest {
    @Test
    fun altArrowsMoveByTheMarkdownConstruct() {
        assertEquals(5, moveByMarkdownSyntax("Hallo", 0, true))
        assertEquals(0, moveByMarkdownSyntax("Hallo", 5, false))
        assertEquals(5, moveByMarkdownSyntax("Hallo\n\nWelt", 0, true))
        assertEquals(11, moveByMarkdownSyntax("Hallo\n\nWelt", 5, true))
        val linked = "Siehe [Text](https://x) Ende"
        val linkEnd = linked.indexOf(" Ende")
        assertEquals(linkEnd, moveByMarkdownSyntax(linked, 0, true))
        assertEquals(linkEnd, moveByMarkdownSyntax(linked, linked.indexOf("Text"), true))
        assertEquals(linked.indexOf("["), moveByMarkdownSyntax(linked, linked.indexOf("Text"), false))
        assertEquals(linked.length, moveByMarkdownSyntax(linked, linkEnd, true))
        val fenced = "```\ncode\n```"
        assertEquals(fenced.length, moveByMarkdownSyntax(fenced, 0, true))
        assertEquals(5 to 5, editorSyntaxSelection("Hallo", 2, 2, true, false))
        assertEquals(0 to 10, editorSyntaxSelection("Hallo Welt", 0, 0, true, true))
    }
}
