package ch.fasrv.fanotes.desk

import ch.fasrv.fanotes.vault.formatNoteStamp
import ch.fasrv.fanotes.vault.stampToInsert
import java.time.LocalDate
import java.time.LocalTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DailyNoteActionsTest {
    @Test
    fun previousAndNextDailyNotesStepOneCalendarDay() {
        val iso = "Tagesnotizen/2026-10-16.md"
        val previous = shiftDailyNote(iso, "Tagesnotizen", "YYYY-MM-DD", -1)
        val next = shiftDailyNote(iso, "Tagesnotizen", "YYYY-MM-DD", 1)
        assertEquals(LocalDate.parse("2026-10-15"), previous)
        assertEquals(LocalDate.parse("2026-10-17"), next)
        assertEquals("Tagesnotizen/2026-10-15.md", dailyNotePath("Tagesnotizen", previous!!, "YYYY-MM-DD"))
        assertEquals("Tagesnotizen/2026-10-17.md", dailyNotePath("Tagesnotizen", next!!, "YYYY-MM-DD"))

        val dottedPrevious = shiftDailyNote("Notizen/16.10.2026.md", "Notizen", "DD.MM.YYYY", -1)
        val dottedNext = shiftDailyNote("Notizen/16.10.2026.md", "Notizen", "DD.MM.YYYY", 1)
        assertEquals(LocalDate.parse("2026-10-15"), dottedPrevious)
        assertEquals(LocalDate.parse("2026-10-17"), dottedNext)
        assertEquals("Notizen/15.10.2026.md", dailyNotePath("Notizen", dottedPrevious!!, "DD.MM.YYYY"))
        assertEquals("Notizen/17.10.2026.md", dailyNotePath("Notizen", dottedNext!!, "DD.MM.YYYY"))

        assertNull(shiftDailyNote("Los.md", "Tagesnotizen", "YYYY-MM-DD", 1))
        assertNull(shiftDailyNote("Andere/2026-10-16.md", "Tagesnotizen", "YYYY-MM-DD", -1))
        assertNull(shiftDailyNote("Tagesnotizen/Einkauf.md", "Tagesnotizen", "YYYY-MM-DD", 1))
        assertNull(shiftDailyNote("Notizen/16.10.2026.md", "Tagesnotizen", "DD.MM.YYYY", 1))
    }

    @Test
    fun dateStampOmitsTheClockUnlessAskedAndSpacesAgainstAWord() {
        val day = LocalDate.parse("2026-10-16")
        val clock = LocalTime.of(9, 5)
        assertEquals("2026-10-16", formatNoteStamp("YYYY-MM-DD", day))
        assertEquals("16.10.2026", formatNoteStamp("DD.MM.YYYY", day))
        assertEquals("2026-10-16 09:05", formatNoteStamp("YYYY-MM-DD", day, withTime = true, time = clock))
        assertEquals("16.10.2026 09:05", formatNoteStamp("DD.MM.YYYY", day, withTime = true, time = clock))
        val date = formatNoteStamp("YYYY-MM-DD", day)
        assertEquals(" $date", stampToInsert("Wort", date))
        assertEquals(date, stampToInsert("Wort\n", date))
        assertEquals(date, stampToInsert("", date))
    }

    @Test
    fun commandListOffersAdjacentDailyNotesAndBothStamps() {
        val labels = paletteCommands().map { it.label }
        assertTrue("Vorherige Tagesnotiz" in labels)
        assertTrue("Nächste Tagesnotiz" in labels)
        assertTrue("Datum einfügen" in labels)
        assertTrue("Datum und Uhrzeit einfügen" in labels)
        val commands = paletteCommands()
        assertEquals("daily-previous", commands.first { it.label == "Vorherige Tagesnotiz" }.id)
        assertEquals("daily-next", commands.first { it.label == "Nächste Tagesnotiz" }.id)
        assertEquals("insert-date", commands.first { it.label == "Datum einfügen" }.id)
        assertEquals("insert-date-time", commands.first { it.label == "Datum und Uhrzeit einfügen" }.id)
    }
}
