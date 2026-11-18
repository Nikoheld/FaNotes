package ch.fasrv.fanotes.desk

import java.time.Duration
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/*
 * Which system notifications the tablet should have scheduled for the calendar and the homework list, and
 * whether the device lets the app deliver them. Pure logic: `ReminderScheduler` in the app turns the plan into
 * AlarmManager alarms and a WorkManager safety net, and reads the permissions that this file only classifies.
 */

data class ReminderSettings(
    val enabled: Boolean = false,
    /** Minutes before a timed calendar event. The in-app banner of the calendar uses 15 as well. */
    val calendarLeadMinutes: Int = 15,
    val homework: Boolean = true,
    /** Minutes before a homework task that has a due time. */
    val homeworkLeadMinutes: Int = 60,
    /** Hour of the evening before a task that only has a due date. */
    val homeworkEveningHour: Int = 18,
) {
    fun sanitized() = copy(
        calendarLeadMinutes = calendarLeadMinutes.coerceIn(0, 24 * 60),
        homeworkLeadMinutes = homeworkLeadMinutes.coerceIn(0, 24 * 60),
        homeworkEveningHour = homeworkEveningHour.coerceIn(0, 23),
    )
}

enum class ReminderKind { CALENDAR, HOMEWORK }

data class PlannedReminder(
    /** Stable for the same occurrence, so a later plan does not schedule it twice. */
    val id: String,
    val triggerAtMs: Long,
    val startsAtMs: Long,
    val title: String,
    val text: String,
    val kind: ReminderKind,
    /** The note the notification opens: the event's note or `Hausaufgaben.md`. Empty for the calendar itself. */
    val notePath: String,
)

const val REMINDER_HORIZON_DAYS = 7L
const val REMINDER_MAX_SCHEDULED = 40

/** A reminder whose time already passed but whose event has not started fires this many seconds after planning. */
const val REMINDER_LATE_DELAY_SECONDS = 3L

private val CLOCK = DateTimeFormatter.ofPattern("HH:mm")

private fun parseDue(task: HomeworkTask, zone: java.time.ZoneId): Pair<ZonedDateTime, Boolean>? {
    val day = task.dueDate?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() } ?: return null
    val time = task.dueTime?.takeIf { it.isNotBlank() }?.let { raw ->
        val parts = raw.split(':')
        val hours = parts.getOrNull(0)?.trim()?.toIntOrNull() ?: return@let null
        val minutes = parts.getOrNull(1)?.trim()?.toIntOrNull() ?: 0
        if (hours !in 0..23 || minutes !in 0..59) null else LocalTime.of(hours, minutes)
    }
    return if (time != null) ZonedDateTime.of(day, time, zone) to true else day.atStartOfDay(zone) to false
}

/**
 * The reminders to have scheduled at [now]: timed calendar events, and open homework (the evening before a
 * due date, or shortly before a due time). Done tasks, hidden calendars, all-day events (as on the desktop),
 * and the mirrored homework events are left out; homework is planned from the task list itself.
 * Wall-clock times are resolved in the zone of [now], so a change of the zone or a DST switch moves them correctly.
 */
fun planReminders(
    calendar: CalendarDocument,
    homework: HomeworkDocument,
    now: ZonedDateTime,
    settings: ReminderSettings,
    horizonDays: Long = REMINDER_HORIZON_DAYS,
    maxCount: Int = REMINDER_MAX_SCHEDULED,
): List<PlannedReminder> {
    val config = settings.sanitized()
    if (!config.enabled) return emptyList()
    val zone = now.zone
    val horizon = now.plusDays(horizonDays)
    val nowMs = now.toInstant().toEpochMilli()
    val planned = ArrayList<PlannedReminder>()
    val hidden = calendar.calendars.filter { !it.visible }.map { it.id }.toSet()

    fun add(id: String, start: ZonedDateTime, trigger: ZonedDateTime, title: String, text: String, kind: ReminderKind, notePath: String) {
        val startMs = start.toInstant().toEpochMilli()
        if (startMs <= nowMs) return
        val triggerMs = trigger.toInstant().toEpochMilli()
        if (triggerMs > horizon.toInstant().toEpochMilli()) return
        val fire = if (triggerMs <= nowMs) nowMs + REMINDER_LATE_DELAY_SECONDS * 1000 else triggerMs
        planned += PlannedReminder(id, fire, startMs, title, text, kind, notePath)
    }

    val lead = Duration.ofMinutes(config.calendarLeadMinutes.toLong())

    for (occurrence in calendarOccurrences(calendar, now, horizon.plus(lead))) {
        if (occurrence.allDay || occurrence.calendarId in hidden) continue
        if (isHomeworkEventId(occurrence.eventId) || occurrence.title.startsWith("✓ ")) continue
        val clock = occurrence.start.format(CLOCK)
        val where = occurrence.location.trim().takeIf { it.isNotEmpty() }?.let { " · $it" }.orEmpty()
        val text = if (config.calendarLeadMinutes > 0) "Beginnt um $clock (in ${config.calendarLeadMinutes} Min.)$where" else "Beginnt um $clock$where"
        add("cal:${occurrence.key}", occurrence.start, occurrence.start.minus(lead), occurrence.title, text, ReminderKind.CALENDAR, occurrence.notePath)
    }

    if (config.homework) {
        for (task in homework.tasks) {
            if (task.done) continue
            val (due, timed) = parseDue(task, zone) ?: continue
            val subject = task.subject.trim().takeIf { it.isNotEmpty() }
            val title = if (subject != null) "$subject: ${task.title}" else task.title
            if (timed) {
                val clock = due.format(CLOCK)
                add(
                    "hw:${task.id}@${task.dueDate}T${task.dueTime}",
                    due,
                    due.minusMinutes(config.homeworkLeadMinutes.toLong()),
                    title,
                    "Fällig heute um $clock",
                    ReminderKind.HOMEWORK,
                    HOMEWORK_NOTE_PATH,
                )
            } else {
                val evening = ZonedDateTime.of(due.toLocalDate().minusDays(1), LocalTime.of(config.homeworkEveningHour, 0), zone)
                add(
                    "hw:${task.id}@${task.dueDate}",
                    due,
                    evening,
                    title,
                    "Morgen fällig",
                    ReminderKind.HOMEWORK,
                    HOMEWORK_NOTE_PATH,
                )
            }
        }
    }
    return planned.distinctBy { it.id }.sortedWith(compareBy({ it.triggerAtMs }, { it.id })).take(maxCount)
}

/** Ids to cancel: scheduled before, no longer wanted. */
fun staleReminderIds(scheduled: Collection<String>, plan: List<PlannedReminder>): List<String> {
    val wanted = plan.map { it.id }.toSet()
    return scheduled.filter { it !in wanted }
}

// ---- what the device allows ----

enum class AlarmMode { EXACT, INEXACT }

/** The state of the Android 13 notification permission, as the settings card needs it. */
enum class NotificationAccess {
    /** Delivered without a prompt (Android 12 and older, notifications on). */
    GRANTED,

    /** Android 13 and newer: the system dialog can still be shown. */
    CAN_ASK,

    /** Denied for good (or switched off in the system settings): only the system settings can change it. */
    NEEDS_SETTINGS,
}

/**
 * [granted] is the permission on Android 13 and newer, and "notifications are on" before. [askedBefore] is the
 * app's own note that the dialog was shown once. After one denial Android shows the dialog again only while
 * [shouldShowRationale] is true; after a second denial it never does.
 */
fun notificationAccess(sdk: Int, granted: Boolean, askedBefore: Boolean, shouldShowRationale: Boolean): NotificationAccess = when {
    granted -> NotificationAccess.GRANTED
    sdk < 33 -> NotificationAccess.NEEDS_SETTINGS
    !askedBefore || shouldShowRationale -> NotificationAccess.CAN_ASK
    else -> NotificationAccess.NEEDS_SETTINGS
}

/** Exact alarms need the "Alarms & reminders" access from Android 12; without it the alarms are inexact. */
fun alarmMode(sdk: Int, canScheduleExact: Boolean): AlarmMode = if (sdk < 31 || canScheduleExact) AlarmMode.EXACT else AlarmMode.INEXACT

data class ReminderReadiness(
    val access: NotificationAccess,
    val mode: AlarmMode,
    /** Whether the settings card offers to open the exact-alarm switch of the system. */
    val offerExactAlarmSwitch: Boolean,
    val summary: String,
)

fun reminderReadiness(sdk: Int, access: NotificationAccess, canScheduleExact: Boolean, channelEnabled: Boolean = true): ReminderReadiness {
    val mode = alarmMode(sdk, canScheduleExact)
    val summary = when {
        access == NotificationAccess.CAN_ASK -> "Erinnerungen brauchen die Erlaubnis für Benachrichtigungen."
        access == NotificationAccess.NEEDS_SETTINGS -> "Benachrichtigungen sind für FaNotes ausgeschaltet. Das lässt sich nur in den Systemeinstellungen ändern."
        !channelEnabled -> "Der Kanal „Erinnerungen“ ist in den Systemeinstellungen ausgeschaltet."
        mode == AlarmMode.INEXACT -> "Erinnerungen kommen, können sich aber um einige Minuten verspäten. Mit „Genaue Alarme“ kommen sie pünktlich."
        else -> "Erinnerungen kommen pünktlich."
    }
    return ReminderReadiness(access, mode, offerExactAlarmSwitch = sdk >= 31 && mode == AlarmMode.INEXACT, summary = summary)
}

/** Hash to the int an alarm's PendingIntent uses as request code. Stable across runs. */
fun reminderRequestCode(id: String): Int {
    var hash = 0x811c9dc5.toInt()
    for (char in id) {
        hash = hash xor char.code
        hash *= 0x01000193
    }
    return hash and 0x7fffffff
}
