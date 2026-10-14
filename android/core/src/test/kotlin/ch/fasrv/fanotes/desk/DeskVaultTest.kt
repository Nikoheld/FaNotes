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
    }

    @Test
    fun tasksWikilinksAndBooksParse() {
        assertEquals(listOf("Andere"), wikiTargets("Siehe [[Andere#Kapitel|hier]]"))
        val toggled = toggleTask("- [ ] Offen\n- [x] Fertig", 0)
        assertTrue(toggled.startsWith("- [x]"))
        val books = parseSubjectBooks("""{"version":1,"books":[{"subjectPath":"Schule","bookPath":"Schule/Buch.pdf","lastPage":3}]}""")
        assertEquals(3, books.single().lastPage)
        assertEquals("Daily Notes/2026-10-14.md", dailyNotePath("Daily Notes", java.time.LocalDate.parse("2026-10-14")))
    }
}
