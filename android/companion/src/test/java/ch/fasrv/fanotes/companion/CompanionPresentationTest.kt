package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.*
import ch.fasrv.fanotes.schulnetz.*
import androidx.core.app.NotificationCompat
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.ZoneId

class CompanionPresentationTest {
    private val zone = ZoneId.of("Europe/Zurich")
    private val day = LocalDate.of(2026, 11, 2)
    private fun school(id: String = "lesson", kind: String = "lesson", start: String = "2026-11-02T08:00") = AgendaEvent(id, start, "2026-11-02T08:45", "Math", "", "B12", listOf("Teacher"), "math", "Math", "", kind, "", "")
    private fun local(id: String = "local", start: String = "2026-11-02", end: String = start, recurrence: String = "none", allDay: Boolean = true) = CalendarEvent(id, "personal", "Study", start, end, allDay = allDay, recurrence = recurrence)

    @Test fun `legacy starts and all notification destinations adapt without changing core routes`() {
        assertEquals(Destination.School, destinationFor("Noten"))
        assertEquals(Destination.Notes, destinationFor("Notizen"))
        assertEquals(Destination.Today, destinationFor("unknown"))
        assertEquals(CompanionRoute(Destination.School, Page.Course), companionRoute(NotifyRoute("Noten", "Menu", courseId = "math")))
        assertEquals(Page.Grades, companionRoute(NotifyRoute("Noten", "Menu")).page)
        assertEquals(Page.Exams, companionRoute(NotifyRoute("Mehr", "Pruefungen")).page)
        assertEquals(Page.Absences, companionRoute(NotifyRoute("Mehr", "Absenzen")).page)
        assertEquals(Page.Notifications, companionRoute(NotifyRoute("Mehr", "Einstellungen")).page)
        assertEquals(Page.Updates, companionRoute(NotifyRoute("Mehr", "Termine")).page)
        assertEquals(Destination.Planner, companionRoute(NotifyRoute("Plan", "Menu")).destination)
        assertEquals(Page.Grades, companionRoute(NotifyRoute("Noten", "Menu")).page)
        assertEquals(Page.Exams, navPlacement("exams").route.page)
        assertTrue(navPlacement("tasks").plannerTasks)
        assertFalse(navPlacement("planner").plannerTasks)
    }

    @Test fun `nav bar keeps off-bar start pages and notification targets reachable`() {
        val defaultBar = DEFAULT_NAV_BAR
        val custom = listOf("notes", "grades", "settings")
        assertEquals("today", selectedNavId(CompanionRoute(), false, defaultBar))
        assertTrue(showsNavBar(CompanionRoute(), false, defaultBar))
        assertEquals("grades", selectedNavId(navPlacement("grades").route, false, custom))
        assertTrue(showsNavBar(navPlacement("grades").route, false, custom))
        assertFalse(showsNavBar(CompanionRoute(Destination.School, Page.Grades), false, defaultBar))
        assertFalse(showsNavBar(CompanionRoute(Destination.School, Page.Course), false, custom))
        assertFalse(showsNavBar(CompanionRoute(Destination.School, Page.Appearance), false, custom))
        assertFalse(showsNavBar(CompanionRoute(Destination.Today, Page.Search), false, defaultBar))
        assertTrue(showsNavBar(CompanionRoute(Destination.Today), false, custom))
        assertEquals(null, selectedNavId(CompanionRoute(Destination.Today), false, custom))
        assertEquals(Page.Grades, navPlacement(startTabId("Noten")).route.page)
        assertEquals("notes", homeNavId("Heute", custom))
        assertFalse(isAtNavRoot(navPlacement("grades").route, false, "Heute", custom, "", false))
        assertTrue(isAtNavRoot(navPlacement("notes").route, false, "Heute", custom, "", false))
        val notifyGrades = companionRoute(NotifyRoute("Noten", "Menu", courseId = "math"))
        assertEquals(Page.Course, notifyGrades.page)
        assertFalse(showsNavBar(notifyGrades, false, custom))
        assertEquals("tasks", navChromeId(CompanionRoute(Destination.Planner), true, listOf("today", "planner", "tasks", "notes")))
        assertEquals("planner", navChromeId(CompanionRoute(Destination.Planner), true, defaultBar))
    }
    @Test fun `merged agenda sorts chronologically and preserves actionable sources`() {
        val task = HomeworkTask("homework", "Read chapter", dueDate = day.toString(), dueTime = "10:00")
        // This JVM test checks ordering and source actions without Android room-label resources.
        val snapshot = SchulnetzSnapshot(events = listOf(school().copy(room = "")))
        val event = local(start = "2026-11-02T09:00", end = "2026-11-02T09:30", allDay = false)
        val entries = agendaForDay(day, snapshot, emptyCalendar().copy(events = listOf(event)), listOf(task), emptyList(), zone)
        assertEquals(listOf(AgendaKind.Lesson, AgendaKind.Event, AgendaKind.Task), entries.map { it.kind })
        assertEquals("08:00–08:45", entries.first().time)
        assertNotNull(entries[0].school); assertNotNull(entries[1].local); assertEquals(task, entries[2].task)
    }
    @Test fun `imported exams and mirrored homework do not duplicate agenda entries`() {
        val exam = school("exam", "exam")
        val task = HomeworkTask("t", "Read", dueDate = day.toString())
        val calendar = emptyCalendar().copy(events = listOf(local("schulnetz-exam"), local("hw:t")))
        val entries = agendaForDay(day, SchulnetzSnapshot(events = listOf(exam), exams = listOf(exam)), calendar, listOf(task), emptyList(), zone)
        assertEquals(2, entries.size)
        assertEquals(1, entries.count { it.local != null }); assertEquals(1, entries.count { it.task != null })
    }
    @Test fun `hidden lessons and hidden calendars remain hidden while completed tasks leave schedule`() {
        val lesson = school()
        val hidden = hideOnce(lesson, emptyList())
        val calendar = CalendarDocument(listOf(CalendarDef("personal", "Personal", "#000000", false)), listOf(local()))
        assertTrue(agendaForDay(day, SchulnetzSnapshot(events = listOf(lesson)), calendar, listOf(HomeworkTask("t", "Done", dueDate = day.toString(), done = true)), hidden, zone).isEmpty())
    }
    @Test fun `monthly repeats clamp short months without drifting and honor exceptions and until`() {
        val event = local(start = "2026-01-31", recurrence = "monthly")
        assertNotNull(calendarSpanOn(event, LocalDate.of(2026, 2, 28), zone))
        assertNotNull(calendarSpanOn(event, LocalDate.of(2026, 3, 31), zone))
        assertNull(calendarSpanOn(event, LocalDate.of(2026, 3, 28), zone))
        assertNull(calendarSpanOn(event.copy(exceptionDates = listOf("2026-02-28")), LocalDate.of(2026, 2, 28), zone))
        assertNull(calendarSpanOn(event.copy(recurrenceUntil = "2026-02-28"), LocalDate.of(2026, 3, 31), zone))
    }
    @Test fun `inclusive all-day spans and midnight timed ends use desktop semantics`() {
        assertNotNull(calendarSpanOn(local(start = "2026-11-01", end = "2026-11-03"), day, zone))
        assertNotNull(calendarSpanOn(local(start = "2026-11-01", end = "2026-11-03"), day.plusDays(1), zone))
        assertNull(calendarSpanOn(local(start = "2026-11-01", end = "2026-11-03"), day.plusDays(2), zone))
        assertNull(calendarSpanOn(local(start = "2026-11-01T22:00", end = "2026-11-02T00:00", allDay = false), day, zone))
    }
    @Test fun `task buckets preserve completed undated and overdue work`() {
        assertEquals("Overdue", taskBucket(HomeworkTask("a", "Past", dueDate = day.minusDays(1).toString()), day))
        assertEquals("Today", taskBucket(HomeworkTask("b", "Now", dueDate = day.toString()), day))
        assertEquals("Upcoming", taskBucket(HomeworkTask("c", "Later", dueDate = day.plusDays(1).toString()), day))
        assertEquals("No due date", taskBucket(HomeworkTask("d", "Someday"), day))
        assertEquals("Completed", taskBucket(HomeworkTask("e", "Done", done = true), day))
    }
    @Test fun `today prioritizes a current timed commitment over all-day entries and skips finished work`() {
        val allDay = AgendaEntry("all", "Birthday", AgendaKind.Event, day)
        val finished = AgendaEntry("past", "Finished class", AgendaKind.Lesson, day, "08:00", "08:45")
        val current = AgendaEntry("current", "Current class", AgendaKind.Lesson, day, "09:00", "10:00")
        val due = AgendaEntry("task", "Due now", AgendaKind.Task, day, "09:00")
        val now = java.time.Instant.parse("2026-11-02T08:30:00Z")
        assertEquals(current, nextCommitment(listOf(allDay, finished, due, current), now, zone))
        assertNull(nextCommitment(listOf(finished), now, zone))
    }
    @Test fun `marker stripping keeps user prose and never exposes internal preview payloads`() {
        assertEquals("Before After", plainPreview("Before <!-- fanotes-ink:abc --> After"))
        assertEquals("Essay", plainPreview("# Essay\n<!-- hidden data -->"))
        assertFalse(searchableNoteText("Text <!-- fanotes-ink:hidden-id -->").contains("hidden-id"))
        assertTrue(searchableNoteText("Text", "wave superposition").contains("wave superposition"))
        assertEquals("Some text", noteExcerpt("# Essay\n\nSome text", "Essay"))
        assertEquals(LocalDate.of(2026, 11, 2), parseDisplayDate("2.11.2026"))
    }
    @Test fun `school fallback waits hours and stays off while push is healthy`() {
        assertEquals(6 * 60 * 60_000L, schoolFallbackIntervalMs())
        val now = 1_700_000_000_000L
        assertEquals("Fallback", deliveryModeLabel(false, now, now))
        assertEquals("Fallback", deliveryModeLabel(true, 0L, now))
        assertEquals("Instant via push", deliveryModeLabel(true, now - 60_000L, now))
        assertEquals("Fallback", deliveryModeLabel(true, now - FCM_HEALTHY_MS - 1, now))
    }

    @Test fun `lock screen notice, diagnostic zip and share path stay private`() {
        val lock = lockScreenNotice()
        assertEquals(NotificationCompat.VISIBILITY_PRIVATE, lock.visibility)
        assertEquals("Neue Schulnetz-Meldung", lock.publicTitle)
        assertEquals("Neue Schulnetz-Meldung", lock.publicText)
        assertTrue(diagnosticEntryAllowed("device.txt", false))
        assertTrue(diagnosticEntryAllowed("schulnetz.log", false))
        assertFalse(diagnosticEntryAllowed("captures/page.html", false))
        assertFalse(diagnosticEntryAllowed("last-page.html", false))
        assertTrue(diagnosticEntryAllowed("captures/page.html", true))
        assertTrue(diagnosticEntryAllowed("last-page.html", true))
        assertFalse(diagnosticEntryAllowed("notes/secret.txt", true))
        val root = File(System.getProperty("java.io.tmpdir"), "kanti-share-${System.nanoTime()}")
        val share = File(root, "share")
        assertTrue(share.mkdirs())
        val inside = File(share, "log.zip")
        inside.writeText("x")
        val outside = File(root, "other.txt")
        outside.writeText("y")
        assertTrue(sharePathAllowed(root, inside))
        assertFalse(sharePathAllowed(root, outside))
        assertFalse(sharePathAllowed(root, root))
        val now = 1_700_000_000_000L
        assertFalse(captureExpired(now, now))
        assertFalse(captureExpired(now - CAPTURE_MAX_AGE_MS, now))
        assertTrue(captureExpired(now - CAPTURE_MAX_AGE_MS - 1, now))
        assertFalse(captureExpired(0L, now))
        root.deleteRecursively()
    }
}
