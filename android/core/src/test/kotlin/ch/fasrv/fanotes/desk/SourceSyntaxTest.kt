package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SourceSyntaxTest {
    @Test
    fun theCaretLineUsesTheDesktopSyntaxColors() {
        val note = "# Titel\n**fett** und *kursiv* sowie [Text](https://fanotes.example)\n---\n<!-- Hinweis -->\na \\* b\n`**nein**` **ja**\n```kotlin\ncode\n```"
        val heading = sourceSyntaxMarks(note, note.indexOf("Titel"), note.indexOf("Titel"))
        assertEquals(listOf(SyntaxMark(note.indexOf("Titel"), note.indexOf("Titel") + "Titel".length, SourceSyntax.HEADING)), heading)

        val boldAt = note.indexOf("fett")
        val styled = sourceSyntaxMarks(note, boldAt, boldAt)
        assertEquals(SyntaxMark(boldAt, boldAt + 4, SourceSyntax.STRONG), styled.first { it.style == SourceSyntax.STRONG })
        assertEquals(SyntaxMark(note.indexOf("kursiv"), note.indexOf("kursiv") + 6, SourceSyntax.EMPHASIS), styled.first { it.style == SourceSyntax.EMPHASIS })
        assertTrue(styled.any { it.style == SourceSyntax.ATOM && note.substring(it.start, it.end) == "Text" })
        assertTrue(styled.any { it.style == SourceSyntax.ATOM && note.substring(it.start, it.end) == "https://fanotes.example" })
        assertTrue(styled.none { it.style == SourceSyntax.HEADING })

        val ruleAt = note.indexOf("---")
        assertEquals(listOf(SyntaxMark(ruleAt, ruleAt + 3, SourceSyntax.ATOM)), sourceSyntaxMarks(note, ruleAt, ruleAt))
        val commentAt = note.indexOf("Hinweis")
        val comment = sourceSyntaxMarks(note, commentAt, commentAt).single()
        assertEquals(SourceSyntax.COMMENT, comment.style)
        assertEquals("<!-- Hinweis -->", note.substring(comment.start, comment.end))
        val escapeAt = note.indexOf("\\*")
        assertEquals(SyntaxMark(escapeAt, escapeAt + 2, SourceSyntax.ESCAPE), sourceSyntaxMarks(note, escapeAt, escapeAt).single())
        val codeAt = note.indexOf("nein")
        val codeLine = sourceSyntaxMarks(note, codeAt, codeAt)
        assertTrue(codeLine.none { note.substring(it.start, it.end) == "nein" })
        assertEquals("ja", note.substring(codeLine.single { it.style == SourceSyntax.STRONG }.start, codeLine.single { it.style == SourceSyntax.STRONG }.end))
        val fenceAt = note.indexOf("kotlin")
        assertEquals(listOf(SyntaxMark(fenceAt, fenceAt + 6, SourceSyntax.ATOM)), sourceSyntaxMarks(note, fenceAt, fenceAt))
        assertTrue(sourceSyntaxMarks(note, note.indexOf("code"), note.indexOf("code")).isEmpty())
        assertEquals(SYNTAX_ATOM_ARGB, 0xFF221199.toInt())
        assertEquals(SYNTAX_COMMENT_ARGB, 0xFF994400.toInt())
        assertEquals(SYNTAX_ESCAPE_ARGB, 0xFFEE4400.toInt())
    }
}
