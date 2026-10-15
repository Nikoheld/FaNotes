package ch.fasrv.fanotes.desk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DeskVaultTest {
    @Test
    fun homeworkRoundTripsTheDesktopMarker() {
        val document = HomeworkDocument(
            listOf(HomeworkTask("a", "Lesen", subject = "Deutsch", dueDate = "2026-10-20", kind = "homework")),
        )
        val text = serializeHomeworkMarkdown(document)
        val parsed = parseHomeworkMarkdown(text)
        assertEquals("Lesen", parsed.tasks.single().title)
        assertEquals("Deutsch", parsed.tasks.single().subject)
        assertEquals("2026-10-20", parsed.tasks.single().dueDate)
    }

    @Test
    fun calendarKeepsAnAllDayEvent() {
        val document = emptyCalendar().copy(
            events = listOf(CalendarEvent("e1", "school", "Probe", "2026-10-21", "2026-10-21")),
        )
        val parsed = parseCalendarMarkdown(serializeCalendarMarkdown(document))
        assertEquals("Probe", parsed.events.single().title)
        assertEquals("school", parsed.events.single().calendarId)
        assertTrue(occurrencesOn(parsed.events.single().copy(recurrence = "weekly"), java.time.LocalDate.parse("2026-10-28")))
        assertTrue(!occurrencesOn(parsed.events.single().copy(recurrence = "weekly"), java.time.LocalDate.parse("2026-10-22")))
    }

    @Test
    fun flashcardsComeFromLernfragenAndRememberAReview() {
        val markdown = """
            ## Lernfragen
            <details><summary>Was ist 2+2?</summary>4</details>
        """.trimIndent()
        val cards = cardsFromMarkdown(markdown, "2026-10-14")
        assertEquals("Was ist 2+2?", cards.single().front)
        val reviewed = applyReview(markdown, cards.single().id, "good", "2026-10-14")
        val again = cardsFromMarkdown(reviewed, "2026-10-14")
        assertTrue(again.single().due > "2026-10-14")
    }

    @Test
    fun searchSkipsMarkersAndCountsWords() {
        val hits = searchVault(listOf("Notes/A.md" to "Hallo Welt\n<!-- fanotes-ink:abc -->\n"), "welt")
        assertEquals(1, hits.single().line)
        assertEquals(2, wordCount("Zwei wörter <!-- fanotes-ink:abc -->"))
        assertEquals(2, statusWordCount("Zwei wörter <!-- fanotes-ink:abc -->"))
        assertEquals(0, statusWordCount("<!-- fanotes-worksheet:blatt -->"))
        val inspector = inspectorDocument("# Titel\n\n**Hallo**-Welt <!-- fanotes-ink:abc -->")
        assertEquals(3, inspector.words)
        assertEquals(1, inspectorDocument("").readingMinutes)
        assertEquals(2, inspectorDocument("wort ".repeat(211)).readingMinutes)
    }

    @Test
    fun tasksWikilinksAndBooksParse() {
        assertEquals(listOf("Andere"), wikiTargets("Siehe [[Andere#Kapitel|hier]]"))
        val toggled = toggleTask("- [ ] Offen\n- [x] Fertig", 0)
        assertTrue(toggled.startsWith("- [x]"))
        val books = parseSubjectBooks("""{"version":1,"books":[{"subjectPath":"Schule","bookPath":"Schule/Buch.pdf","lastPage":3}]}""")
        assertEquals(3, books.single().lastPage)
        val day = java.time.LocalDate.parse("2026-10-14")
        assertEquals("Daily Notes/2026-10-14.md", dailyNotePath("Daily Notes", day))
        assertEquals("14.10.2026", formatNoteDate("DD.MM.YYYY", day))
        assertEquals("26", formatNoteDate("YY", day))
        assertEquals("Tagesnotizen/14.10.2026.md", dailyNotePath("", day, "DD.MM.YYYY"))
        assertEquals("Tagesnotizen/2026-10-14.md", dailyNotePath("", day, "YYYY/MM/DD"))
        assertEquals("Eingang", defaultNoteParent(null, setOf("Eingang", "Schule")))
        assertEquals("", defaultNoteParent(null, setOf("Schule")))
        assertEquals("", defaultNoteParent("", setOf("Eingang")))
        assertEquals("Schule", defaultNoteParent("Schule", setOf("Eingang", "Schule")))
        assertEquals("", defaultNoteParent("Fehlt", setOf("Eingang")))
        assertEquals("Schule/Mathe", pdfNoteImportParent("Schule/Mathe", "Eingang"))
        assertEquals("Eingang", pdfNoteImportParent(null, "Eingang"))
        assertEquals("Eingang", pdfNoteImportParent("  ", "Eingang"))
        assertEquals("PDF „Algebra“ ist jetzt eine Notiz.", pdfNoteImportMessage("Schule/Algebra.pdf"))
    }

    @Test
    fun worksheetTextWrapsInsideTheCard() {
        assertEquals(listOf("hello", "world"), wrapBoxLines("hello world", 5))
        assertEquals(listOf("abcd", "efgh", "ij"), wrapBoxLines("abcdefghij", 4))
        assertEquals(listOf("one", "two"), wrapBoxLines("one\ntwo", 20))
        assertEquals(listOf(""), wrapBoxLines("", 8))
        assertTrue(worksheetCharsPerLine(400f, 16f, 1f) > worksheetCharsPerLine(80f, 16f, 1f))
        assertTrue(worksheetCardHeightPx("eine lange antwort die umbrechen muss", 80f, 16f, 1f) > worksheetCardHeightPx("kurz", 80f, 16f, 1f))
    }
}
