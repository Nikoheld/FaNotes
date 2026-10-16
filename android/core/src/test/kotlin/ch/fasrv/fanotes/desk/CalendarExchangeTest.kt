package ch.fasrv.fanotes.desk

import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class CalendarExchangeTest {
    @Test
    fun icsRoundTripsTheDesktopProbeAndEscapesText() {
        val homework = HomeworkDocument(
            listOf(
                HomeworkTask(
                    id = "t1",
                    title = "Seite 4",
                    subject = "Mathe",
                    dueDate = "2026-10-12",
                    kind = "homework",
                    createdAt = "2026-10-01T00:00:00.000Z",
                    updatedAt = "2026-10-01T00:00:00.000Z",
                ),
            ),
        )
        val synced = applyHomeworkToCalendar(emptyCalendar(), homework)
        assertTrue(synced.calendars.any { it.name == "Hausaufgaben" && it.color == "#e15b64" })
        assertTrue(synced.events.any { it.id == "hw:t1" && it.title == "Seite 4" && it.notePath == HOMEWORK_NOTE_PATH && it.allDay })
        val exported = exportIcs(synced)
        assertTrue(exported.contains("BEGIN:VCALENDAR"))
        assertTrue(exported.contains("SUMMARY:Seite 4"))
        assertTrue(exported.contains("DTSTART;VALUE=DATE:20261012"))
        assertTrue(exported.contains("DTEND;VALUE=DATE:20261013"))
        assertTrue(exported.endsWith("\n"))

        val done = applyHomeworkToCalendar(
            synced,
            homework.copy(tasks = homework.tasks.map { it.copy(done = true) }),
        )
        assertTrue(done.events.any { it.id == "hw:t1" && it.title.startsWith("✓") })

        val imported = importIcs(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:abc\nSUMMARY:Probe\nDTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR\n",
            synced.calendars.first().id,
        )
        assertEquals("Probe", imported[0].title)
        assertEquals("weekly", imported[0].recurrence)
        assertEquals("abc", imported[0].id)
        assertEquals("2026-10-20", imported[0].start)
        assertEquals("2026-10-20", imported[0].end)
        assertTrue(imported[0].allDay)

        val folded = importIcs(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Hel\r\n lo\\, Welt\r\nDTSTART:20261014T153000\r\nLOCATION:Raum\\n2\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "personal",
        )
        assertEquals("Hello, Welt", folded[0].title)
        assertEquals("2026-10-14T15:30", folded[0].start)
        assertEquals("Raum\n2", folded[0].location)
        assertFalse(folded[0].allDay)
        assertEquals("kalender.ics", icsFileName("!!!"))
        assertEquals("Mein-Kalender.ics", icsFileName("Mein Kalender"))

        val zone = ZoneId.of("Europe/Zurich")
        val timed = importIcs(
            listOf(
                "BEGIN:VCALENDAR",
                "BEGIN:VEVENT",
                "UID:lesson",
                "SUMMARY:Hello\\, Welt",
                "DESCRIPTION:Zeile\\\\n2",
                "DTSTART:20261014T153000",
                "DURATION:PT45M",
                "END:VEVENT",
                "BEGIN:VEVENT",
                "UID:gone",
                "STATUS:CANCELLED",
                "SUMMARY:Entfällt",
                "DTSTART:20261014T180000",
                "END:VEVENT",
                "END:VCALENDAR",
            ).joinToString("\n"),
            "personal",
            zone,
        )
        assertEquals(1, timed.size)
        assertEquals("Hello, Welt", timed[0].title)
        assertEquals("Zeile\\n2", timed[0].notes)
        assertEquals("2026-10-14T15:30", timed[0].start)
        assertEquals("2026-10-14T16:15", timed[0].end)

        val utc = importIcs(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:utc-call\nSUMMARY:Anruf\nDTSTART:20261016T070000Z\nDURATION:PT90M\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
            zone,
        )
        val utcStart = ZonedDateTime.of(2026, 10, 16, 7, 0, 0, 0, ZoneOffset.UTC).withZoneSameInstant(zone)
        val wall = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
        assertEquals(utcStart.format(wall), utc[0].start)
        assertEquals(utcStart.plusMinutes(90).format(wall), utc[0].end)
        assertEquals("2026-10-16T09:00", utc[0].start)

        val existing = emptyCalendar().copy(
            events = listOf(
                CalendarEvent(
                    id = "lesson",
                    calendarId = "school",
                    title = "Alt",
                    start = "2026-10-14T15:30",
                    end = "2026-10-14T16:15",
                    allDay = false,
                    notePath = "Schule/Mathe.md",
                    exceptionDates = listOf("2026-10-21"),
                ),
            ),
        )
        val merged = applyIcsImport(
            existing,
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:lesson\nSUMMARY:Neu\nDTSTART:20261014T153000\nDURATION:PT45M\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
            zone,
        )
        assertEquals(1, merged.updated)
        assertEquals(0, merged.added)
        assertEquals("Neu", merged.document.events[0].title)
        assertEquals("school", merged.document.events[0].calendarId)
        assertEquals("Schule/Mathe.md", merged.document.events[0].notePath)
        assertEquals(listOf("2026-10-21"), merged.document.events[0].exceptionDates)
        val removed = applyIcsImport(
            merged.document,
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:lesson\nSTATUS:CANCELLED\nSUMMARY:Neu\nDTSTART:20261014T153000\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
            zone,
        )
        assertEquals(1, removed.removed)
        assertTrue(removed.document.events.isEmpty())
    }

    @Test
    fun remindersFireInsideTheLeadAndSkipHiddenOrDoneHomework() {
        val zone = ZoneId.of("Europe/Zurich")
        val now = ZonedDateTime.of(2026, 10, 14, 15, 0, 0, 0, zone)
        val soon = now.plusMinutes(5)
        val event = CalendarEvent(
            id = "soon",
            calendarId = "personal",
            title = "Jetzt",
            start = "2026-10-14T15:05",
            end = "2026-10-14T15:35",
            allDay = false,
        )
        val withSoon = emptyCalendar().copy(events = listOf(event))
        assertEquals(soon.toLocalTime().toString(), "15:05")
        assertTrue(dueReminders(withSoon, now, 15).any { it.title == "Jetzt" && it.minutesUntil == 5 })
        assertTrue(dueReminders(withSoon, now, 15).none { it.title == "Jetzt" && it.key != "soon@2026-10-14" })
        val hidden = withSoon.copy(calendars = withSoon.calendars.map { if (it.id == "personal") it.copy(visible = false) else it })
        assertTrue(dueReminders(hidden, now, 15).isEmpty())
        val done = withSoon.copy(events = listOf(event.copy(title = "✓ Seite 4")))
        assertTrue(dueReminders(done, now, 15).isEmpty())
        assertTrue(dueReminders(withSoon, now, 3).isEmpty())
        val allDay = CalendarEvent(
            id = "day",
            calendarId = "personal",
            title = "Abgabe",
            start = "2026-10-15",
            end = "2026-10-15",
            allDay = true,
        )
        val beforeMidnight = ZonedDateTime.of(2026, 10, 14, 23, 50, 0, 0, zone)
        assertTrue(dueReminders(emptyCalendar().copy(events = listOf(allDay)), beforeMidnight, 15).isEmpty())
        val rent = CalendarEvent(
            id = "rent",
            calendarId = "personal",
            title = "Miete",
            start = "2026-01-31T09:00",
            end = "2026-01-31T10:00",
            allDay = false,
            recurrence = "monthly",
        )
        val marchMorning = ZonedDateTime.of(2026, 3, 31, 8, 50, 0, 0, zone)
        assertTrue(dueReminders(emptyCalendar().copy(events = listOf(rent)), marchMorning, 15).any {
            it.key == "rent@2026-03-31" && it.minutesUntil == 10
        })
    }

    @Test
    fun utcAndANumericOffsetBecomeLocalWallTime() {
        val wall = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm")
        val imported = importIcs(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:utc\nSUMMARY:Pfad\\\\notes\nDTSTART:20261020T090000Z\nDTEND:20261020T100000Z\nDESCRIPTION:C:\\\\notes\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
        )
        val start = ZonedDateTime.of(2026, 10, 20, 9, 0, 0, 0, ZoneOffset.UTC).withZoneSameInstant(ZoneId.systemDefault())
        assertEquals(start.format(wall), imported[0].start)
        assertEquals(start.plusHours(1).format(wall), imported[0].end)
        assertEquals("Pfad\\notes", imported[0].title)
        assertEquals("C:\\notes", imported[0].notes)
        val offset = importIcs(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Versetzt\nDTSTART:20261020T090000+0200\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
        )
        val shifted = ZonedDateTime.of(2026, 10, 20, 9, 0, 0, 0, ZoneOffset.ofHours(2)).withZoneSameInstant(ZoneId.systemDefault())
        assertEquals(shifted.format(wall), offset[0].start)
        assertTrue(importIcs(
            "BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Nein\nDTSTART:20260231T090000Z\nEND:VEVENT\nEND:VCALENDAR\n",
            "personal",
        ).isEmpty())
    }
}
