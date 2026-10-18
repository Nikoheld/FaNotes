package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.WIKI_LINK_COPIED
import ch.fasrv.fanotes.vault.wikiLinkForNote
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TaskToggleTest {
    @Test
    fun wikiLinkMatchesTheDesktopStem() {
        assertEquals("[[Algebra]]", wikiLinkForNote("Math/Algebra.md"))
        assertEquals("[[A B]]", wikiLinkForNote("A[|]B.md"))
        assertEquals("[[Notiz]]", wikiLinkForNote(".md"))
        assertEquals("[[Blatt]]", wikiLinkForNote("Notes/Blatt.pdf"))
        assertEquals("Wiki-Link kopiert.", WIKI_LINK_COPIED)
    }

    @Test
    fun commandListOffersWikiLinkAndTaskToggle() {
        val commands = paletteCommands()
        val wiki = commands.first { it.label == "Wiki-Link kopieren" }
        val task = commands.first { it.label == "Aufgabe umschalten" }
        assertEquals("copy-wiki-link", wiki.id)
        assertEquals("toggle-task", task.id)
        assertEquals("Ctrl Enter", task.shortcut)
        assertEquals(task.id, deskShortcut(true, false, false, false, "enter"))
        assertEquals(task.id, deskShortcut(false, false, false, true, "enter"))
        assertNull(deskShortcut(true, false, true, false, "enter"))
        assertNull(deskShortcut(false, false, true, true, "enter"))
        assertEquals("stamp", deskShortcut(true, true, false, false, "d"))
    }

    @Test
    fun taskLinesFollowTheDesktopRule() {
        assertEquals("- [x] offen", toggleTaskLine("- [ ] offen"))
        assertEquals("- [ ] fertig", toggleTaskLine("- [x] fertig"))
        assertEquals("- [ ] fertig", toggleTaskLine("- [X] fertig"))
        assertEquals("  1. [ ] Punkt", toggleTaskLine("  1. Punkt"))
        assertEquals("- [ ] Hausaufgabe", toggleTaskLine("Hausaufgabe"))
        assertEquals("- [ ] ", toggleTaskLine(""))
        assertEquals("  - [ ] ", toggleTaskLine("  "))
        assertEquals("# Titel", toggleTaskLine("# Titel"))
        assertEquals("> Zitat", toggleTaskLine("> Zitat"))
        assertEquals("| A | B |", toggleTaskLine("| A | B |"))
        assertEquals("---", toggleTaskLine("---"))
        assertEquals("- [x] offen", toggleTasksInNote("- [ ] offen", 0, 0).text)
        assertEquals("- [ ] Hausaufgabe", toggleTasksInNote("Hausaufgabe", 0, 11).text)
        assertEquals(17, toggleTasksInNote("Hausaufgabe", 0, 0).selectionEnd)
    }

    @Test
    fun anOpenFenceLeavesTheLineAndAClosedFenceChangesIt() {
        assertTrue(isFenceLine("```kotlin"))
        assertTrue(isFenceLine("  ~~~"))
        assertFalse(isFenceLine("- [ ] drin"))
        assertTrue(fenceIsOpen(listOf("```")))
        assertFalse(fenceIsOpen(listOf("```", "~~~")))
        assertTrue(fenceIsOpen(listOf("```", "text", "~~~", "```")))

        val note = "```\n- [ ] drin\n```\n- [ ] draussen"
        val inner = note.indexOf("- [ ] drin")
        val kept = toggleTasksInNote(note, inner, inner + "- [ ] drin".length)
        assertEquals(note, kept.text)

        val outer = note.indexOf("- [ ] draussen")
        val changed = toggleTasksInNote(note, outer, outer)
        assertEquals(note.replace("- [ ] draussen", "- [x] draussen"), changed.text)

        val tilde = "~~~\n- [x] drin\n~~~\nHausaufgabe"
        val inside = tilde.indexOf("- [x] drin")
        assertEquals(tilde, toggleTasksInNote(tilde, inside, inside).text)
        val after = tilde.indexOf("Hausaufgabe")
        assertEquals(
            tilde.replace("Hausaufgabe", "- [ ] Hausaufgabe"),
            toggleTasksInNote(tilde, after, after).text,
        )

        val whole = toggleTasksInNote(note, 0, note.length)
        assertTrue(whole.text.contains("```\n- [ ] drin\n```"))
        assertTrue(whole.text.endsWith("- [x] draussen"))

        val excluded = "- [ ] a\n- [ ] b"
        val boundary = excluded.indexOf("- [ ] b")
        val firstOnly = toggleTasksInNote(excluded, 0, boundary)
        assertEquals("- [x] a\n- [ ] b", firstOnly.text)
    }
}
