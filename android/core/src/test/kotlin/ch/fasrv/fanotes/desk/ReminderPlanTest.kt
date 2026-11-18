package ch.fasrv.fanotes.desk

import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ReminderPlanTest {
    private val zurich = ZoneId.of("Europe/Zurich")
    private val on = ReminderSettings(enabled = true)

    private fun event(id: String, start: String, end: String, title: String = id, allDay: Boolean = false, recurrence: String = "none") =
        CalendarEvent(id = id, calendarId = "personal", title = title, start = start, end = end, allDay = allDay, recurrence = recurrence)

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int = 0) = ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zurich)

    @Test
    fun disabledSettingsPlanNothing() {
        val calendar = emptyCalendar().copy(events = listOf(event("a", "2026-10-14T16:00", "2026-10-14T17:00")))
        assertTrue(planReminders(calendar, HomeworkDocument(emptyList()), at(2026, 10, 14, 12), ReminderSettings()).isEmpty())
    }

    @Test
    fun timedEventsRemindBeforeTheStartAndAllDayEventsAreSkipped() {
        val calendar = emptyCalendar().copy(
            events = listOf(
                event("lesson", "2026-10-14T16:00", "2026-10-14T17:00", "Mathe"),
                event("holiday", "2026-10-15", "2026-10-15", "Ferien", allDay = true),
                event("past", "2026-10-14T09:00", "2026-10-14T10:00", "Vorbei"),
            ),
        )
        val plan = planReminders(calendar, HomeworkDocument(emptyList()), at(2026, 10, 14, 12), on)
        assertEquals(listOf("cal:lesson@2026-10-14"), plan.map { it.id })
        assertEquals(at(2026, 10, 14, 15, 45).toInstant().toEpochMilli(), plan[0].triggerAtMs)
        assertEquals("Mathe", plan[0].title)
        assertEquals("Beginnt um 16:00 (in 15 Min.)", plan[0].text)
    }

    @Test
    fun anEventInsideTheLeadFiresSoonAndOnlyOnceAsOneId() {
        val calendar = emptyCalendar().copy(events = listOf(event("soon", "2026-10-14T12:05", "2026-10-14T12:35")))
        val now = at(2026, 10, 14, 12)
        val plan = planReminders(calendar, HomeworkDocument(emptyList()), now, on)
        assertEquals(1, plan.size)
        assertEquals(now.toInstant().toEpochMilli() + REMINDER_LATE_DELAY_SECONDS * 1000, plan[0].triggerAtMs)
        assertEquals(plan, planReminders(calendar, HomeworkDocument(emptyList()), now, on))
    }

    @Test
    fun hiddenCalendarsAndDoneMarkedEventsStaySilent() {
        val hidden = emptyCalendar().let { base ->
            base.copy(
                calendars = base.calendars.map { it.copy(visible = false) },
                events = listOf(event("a", "2026-10-14T16:00", "2026-10-14T17:00")),
            )
        }
        assertTrue(planReminders(hidden, HomeworkDocument(emptyList()), at(2026, 10, 14, 12), on).isEmpty())
        val done = emptyCalendar().copy(events = listOf(event("b", "2026-10-14T16:00", "2026-10-14T17:00", "✓ Seite 4")))
        assertTrue(planReminders(done, HomeworkDocument(emptyList()), at(2026, 10, 14, 12), on).isEmpty())
    }

    @Test
    fun recurringEventsGetOneReminderPerOccurrenceInsideTheHorizon() {
        val calendar = emptyCalendar().copy(events = listOf(event("daily", "2026-10-10T07:30", "2026-10-10T08:00", "Frühstück", recurrence = "daily")))
        val plan = planReminders(calendar, HomeworkDocument(emptyList()), at(2026, 10, 14, 12), on)
        assertEquals(7, plan.size)
        assertEquals("cal:daily@2026-10-15", plan.first().id)
        assertEquals(plan.map { it.triggerAtMs }.sorted(), plan.map { it.triggerAtMs })
    }

    @Test
    fun homeworkWithoutATimeRemindsTheEveningBefore() {
        val homework = HomeworkDocument(
            listOf(
                HomeworkTask(id = "t1", title = "Seite 4", subject = "Mathe", dueDate = "2026-10-16"),
                HomeworkTask(id = "t2", title = "Fertig", dueDate = "2026-10-16", done = true),
                HomeworkTask(id = "t3", title = "Ohne Datum"),
                HomeworkTask(id = "t4", title = "Alt", dueDate = "2026-10-01"),
            ),
        )
        val plan = planReminders(emptyCalendar(), homework, at(2026, 10, 14, 12), on)
        assertEquals(listOf("hw:t1@2026-10-16"), plan.map { it.id })
        assertEquals(at(2026, 10, 15, 18).toInstant().toEpochMilli(), plan[0].triggerAtMs)
        assertEquals("Mathe: Seite 4", plan[0].title)
        assertEquals("Morgen fällig", plan[0].text)
        assertEquals(HOMEWORK_NOTE_PATH, plan[0].notePath)
    }

    @Test
    fun homeworkWithATimeRemindsAnHourBeforeAndMirroredEventsAreNotDoubled() {
        val homework = HomeworkDocument(listOf(HomeworkTask(id = "t1", title = "Vortrag", dueDate = "2026-10-15", dueTime = "08:30")))
        val mirrored = applyHomeworkToCalendar(emptyCalendar(), homework)
        val plan = planReminders(mirrored, homework, at(2026, 10, 14, 12), on)
        assertEquals(1, plan.size)
        assertEquals(at(2026, 10, 15, 7, 30).toInstant().toEpochMilli(), plan[0].triggerAtMs)
        assertEquals("Fällig heute um 08:30", plan[0].text)
        assertTrue(planReminders(mirrored, homework, at(2026, 10, 14, 12), on.copy(homework = false)).isEmpty())
    }

    @Test
    fun wallClockTimesFollowDaylightSavingTime() {
        // Europe/Zurich leaves summer time on 2026-10-25: the evening before is 25 h long.
        val homework = HomeworkDocument(listOf(HomeworkTask(id = "t1", title = "Test", dueDate = "2026-10-26")))
        val plan = planReminders(emptyCalendar(), homework, at(2026, 10, 24, 12), on)
        assertEquals(at(2026, 10, 25, 18).toInstant().toEpochMilli(), plan[0].triggerAtMs)
        assertEquals("2026-10-25T17:00:00Z", java.time.Instant.ofEpochMilli(plan[0].triggerAtMs).toString())
        // Spring forward 2027-03-28: a 02:30 due time does not exist and moves to 03:30 local.
        val gap = HomeworkDocument(listOf(HomeworkTask(id = "t2", title = "Nacht", dueDate = "2027-03-28", dueTime = "02:30")))
        val spring = planReminders(emptyCalendar(), gap, at(2027, 3, 27, 12), on)
        assertEquals(1, spring.size)
        assertEquals(ZonedDateTime.of(2027, 3, 28, 3, 30, 0, 0, zurich).toInstant().toEpochMilli(), spring[0].startsAtMs)
    }

    @Test
    fun theSameZoneRulesMoveAnEventWhenTheDeviceChangesZone() {
        val calendar = emptyCalendar().copy(events = listOf(event("lesson", "2026-10-14T16:00", "2026-10-14T17:00")))
        val tokyo = ZonedDateTime.of(2026, 10, 14, 12, 0, 0, 0, ZoneId.of("Asia/Tokyo"))
        val plan = planReminders(calendar, HomeworkDocument(emptyList()), tokyo, on)
        assertEquals(ZonedDateTime.of(2026, 10, 14, 15, 45, 0, 0, ZoneId.of("Asia/Tokyo")).toInstant().toEpochMilli(), plan[0].triggerAtMs)
    }

    @Test
    fun theListIsSortedCappedAndStaleIdsAreFound() {
        val tasks = (1..60).map { HomeworkTask(id = "t$it", title = "A$it", dueDate = "2026-10-${15 + (it % 5)}") }
        val plan = planReminders(emptyCalendar(), HomeworkDocument(tasks), at(2026, 10, 14, 12), on)
        assertEquals(REMINDER_MAX_SCHEDULED, plan.size)
        assertEquals(plan.map { it.triggerAtMs }.sorted(), plan.map { it.triggerAtMs })
        assertEquals(listOf("gone"), staleReminderIds(listOf("gone", plan[0].id), plan))
    }

    @Test
    fun notificationAccessFollowsTheAndroid13Flow() {
        assertEquals(NotificationAccess.GRANTED, notificationAccess(34, true, true, false))
        assertEquals(NotificationAccess.CAN_ASK, notificationAccess(34, false, false, false))
        assertEquals(NotificationAccess.CAN_ASK, notificationAccess(34, false, true, true))
        assertEquals(NotificationAccess.NEEDS_SETTINGS, notificationAccess(34, false, true, false))
        assertEquals(NotificationAccess.NEEDS_SETTINGS, notificationAccess(30, false, false, false))
        assertEquals(NotificationAccess.GRANTED, notificationAccess(30, true, false, false))
    }

    @Test
    fun exactAlarmsNeedTheAccessFromAndroid12() {
        assertEquals(AlarmMode.EXACT, alarmMode(30, false))
        assertEquals(AlarmMode.INEXACT, alarmMode(34, false))
        assertEquals(AlarmMode.EXACT, alarmMode(34, true))
        val inexact = reminderReadiness(34, NotificationAccess.GRANTED, false)
        assertTrue(inexact.offerExactAlarmSwitch)
        assertTrue(inexact.summary.contains("verspäten"))
        assertTrue(!reminderReadiness(30, NotificationAccess.GRANTED, false).offerExactAlarmSwitch)
        assertTrue(reminderReadiness(34, NotificationAccess.CAN_ASK, true).summary.contains("Erlaubnis"))
        assertTrue(reminderReadiness(34, NotificationAccess.GRANTED, true, channelEnabled = false).summary.contains("Kanal"))
    }

    @Test
    fun requestCodesAreStableAndNonNegative() {
        assertEquals(reminderRequestCode("cal:a@2026-10-14"), reminderRequestCode("cal:a@2026-10-14"))
        assertTrue(reminderRequestCode("hw:t1@2026-10-16") >= 0)
        assertTrue(reminderRequestCode("a") != reminderRequestCode("b"))
    }
}
