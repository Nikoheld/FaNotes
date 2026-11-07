package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.desk.*
import ch.fasrv.fanotes.schulnetz.*
import ch.fasrv.fanotes.sync.SyncStatus
import ch.fasrv.fanotes.vault.NoteKind
import ch.fasrv.fanotes.vault.VaultNode
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/** Presentation routes are independent of the persisted desktop preference and push vocabulary. */
enum class Destination(val label: String, val legacy: String) {
    Today("Today", "Heute"), Planner("Planner", "Plan"), Notes("Notes", "Notizen"), School("School", "Mehr")
}
enum class Page(val title: String) {
    Search("Search"), Editor("Note"), Grades("Grades"), Course("Subject"), Exams("Exams"),
    Absences("Absences"), Updates("School updates"), Statement("School account"),
    Settings("Settings"), Connections("Account & sync"), Appearance("Appearance"), ArchivedSubjects("Archived subjects"),
    Navigation("Navigation bar"), Planning("Planning & grades"), Notifications("Notifications"),
    Profile("Your activity"), Diagnostics("Diagnostics"), Auth("Connect FaNotes"), Trash("Recently deleted")
}
data class CompanionRoute(val destination: Destination = Destination.Today, val page: Page? = null)

fun screenToken(route: CompanionRoute): String {
    val dest = route.destination.name.lowercase()
    val page = route.page?.name?.lowercase().orEmpty()
    return if (page.isBlank()) dest else "$dest/$page"
}
data class NavPlacement(val route: CompanionRoute, val plannerTasks: Boolean = false)
fun destinationFor(raw: String): Destination = when (startTabId(raw)) {
    "planner", "tasks" -> Destination.Planner
    "notes" -> Destination.Notes
    "school", "grades", "exams", "absences", "updates", "statement", "settings" -> Destination.School
    else -> Destination.Today
}
fun navBarLabel(id: String): String = when (startTabId(id)) {
    "planner" -> t(R.string.planner)
    "tasks" -> t(R.string.to_dos)
    "notes" -> t(R.string.notes)
    "school" -> t(R.string.school)
    "grades" -> t(R.string.grades)
    "exams" -> t(R.string.exams)
    "absences" -> t(R.string.absences)
    "updates" -> t(R.string.updates)
    "statement" -> t(R.string.account)
    "settings" -> t(R.string.settings)
    else -> t(R.string.today)
}

fun Destination.uiLabel(): String = when (this) {
    Destination.Today -> t(R.string.today)
    Destination.Planner -> t(R.string.planner)
    Destination.Notes -> t(R.string.notes)
    Destination.School -> t(R.string.school)
}

fun Page.uiTitle(): String = when (this) {
    Page.Search -> t(R.string.search)
    Page.Editor -> t(R.string.note)
    Page.Grades -> t(R.string.grades)
    Page.Course -> t(R.string.subject)
    Page.Exams -> t(R.string.exams)
    Page.Absences -> t(R.string.absences)
    Page.Updates -> t(R.string.school_updates)
    Page.Statement -> t(R.string.school_account)
    Page.Settings -> t(R.string.settings)
    Page.Connections -> t(R.string.account_sync)
    Page.Appearance -> t(R.string.appearance)
    Page.ArchivedSubjects -> t(R.string.archived_subjects)
    Page.Navigation -> t(R.string.navigation_bar)
    Page.Planning -> t(R.string.planning_grades)
    Page.Notifications -> t(R.string.notifications)
    Page.Profile -> t(R.string.your_activity)
    Page.Diagnostics -> t(R.string.diagnostics)
    Page.Auth -> t(R.string.connect_fanotes)
    Page.Trash -> t(R.string.recently_deleted)
}
fun navPlacement(id: String): NavPlacement = when (startTabId(id)) {
    "planner" -> NavPlacement(CompanionRoute(Destination.Planner))
    "tasks" -> NavPlacement(CompanionRoute(Destination.Planner), plannerTasks = true)
    "notes" -> NavPlacement(CompanionRoute(Destination.Notes))
    "school" -> NavPlacement(CompanionRoute(Destination.School))
    "grades" -> NavPlacement(CompanionRoute(Destination.School, Page.Grades))
    "exams" -> NavPlacement(CompanionRoute(Destination.School, Page.Exams))
    "absences" -> NavPlacement(CompanionRoute(Destination.School, Page.Absences))
    "updates" -> NavPlacement(CompanionRoute(Destination.School, Page.Updates))
    "statement" -> NavPlacement(CompanionRoute(Destination.School, Page.Statement))
    "settings" -> NavPlacement(CompanionRoute(Destination.School, Page.Settings))
    else -> NavPlacement(CompanionRoute(Destination.Today))
}
fun navChromeId(route: CompanionRoute, plannerTasks: Boolean, bar: List<String> = DEFAULT_NAV_BAR): String? {
    val shown = validateNavBar(bar)
    return when (route.page) {
        null -> when (route.destination) {
            Destination.Today -> "today"
            Destination.Planner -> if (plannerTasks && "tasks" in shown) "tasks" else "planner"
            Destination.Notes -> "notes"
            Destination.School -> "school"
        }
        Page.Grades -> "grades"
        Page.Exams -> "exams"
        Page.Absences -> "absences"
        Page.Updates -> "updates"
        Page.Statement -> "statement"
        Page.Settings -> "settings"
        else -> null
    }
}
fun showsNavBar(route: CompanionRoute, plannerTasks: Boolean, bar: List<String>): Boolean {
    val id = navChromeId(route, plannerTasks, bar) ?: return false
    return id in validateNavBar(bar) || route.page == null
}
fun selectedNavId(route: CompanionRoute, plannerTasks: Boolean, bar: List<String>): String? {
    val id = navChromeId(route, plannerTasks, bar) ?: return null
    return id.takeIf { it in validateNavBar(bar) }
}
fun isAtNavRoot(
    route: CompanionRoute,
    plannerTasks: Boolean,
    startTab: String,
    bar: List<String>,
    noteFolder: String,
    hasHistory: Boolean,
): Boolean {
    if (hasHistory || noteFolder.isNotBlank() || route.page == Page.Course) return false
    return navChromeId(route, plannerTasks, bar) == homeNavId(startTab, bar)
}
fun companionRoute(route: NotifyRoute): CompanionRoute = when {
    route.tab == "Noten" -> CompanionRoute(Destination.School, if (route.courseId.isBlank()) Page.Grades else Page.Course)
    route.section == "Einstellungen" -> CompanionRoute(Destination.School, Page.Notifications)
    route.section == "Pruefungen" -> CompanionRoute(Destination.School, Page.Exams)
    route.section == "Absenzen" -> CompanionRoute(Destination.School, Page.Absences)
    route.section == "Termine" -> CompanionRoute(Destination.School, Page.Updates)
    else -> CompanionRoute(destinationFor(route.tab))
}

fun flattenNotes(tree: List<VaultNode>): List<VaultNode> = tree.flatMap { node ->
    if (node.kind == NoteKind.FOLDER) flattenNotes(node.children) else listOf(node)
}.filter { it.path !in setOf(HOMEWORK_NOTE_PATH, CALENDAR_NOTE_PATH) }
fun flattenFolders(tree: List<VaultNode>): List<VaultNode> = tree.filter { it.kind == NoteKind.FOLDER }.flatMap { listOf(it) + flattenFolders(it.children) }
fun taskBucket(task: HomeworkTask, today: LocalDate): String = when (classifyHomeworkTask(task, today)) {
    "overdue" -> "Overdue"
    "today" -> "Today"
    "upcoming" -> "Upcoming"
    "done" -> "Completed"
    else -> "No due date"
}

fun bucketLabel(bucket: String): String = when (bucket) {
    "Overdue" -> t(R.string.overdue)
    "Today" -> t(R.string.today)
    "Upcoming" -> t(R.string.upcoming)
    "Completed" -> t(R.string.completed)
    "No due date" -> t(R.string.no_due_date)
    else -> bucket
}

fun recurrenceLabel(recurrence: String): String = when (recurrence) {
    "daily" -> t(R.string.recurrence_daily)
    "weekly" -> t(R.string.recurrence_weekly)
    "monthly" -> t(R.string.recurrence_monthly)
    "yearly" -> t(R.string.recurrence_yearly)
    else -> recurrence
}

fun dueLabel(raw: String?, today: LocalDate = LocalDate.now()): String {
    val day = parseDisplayDate(raw.orEmpty()) ?: return t(R.string.no_due_date)
    return when (day) {
        today -> t(R.string.today)
        today.plusDays(1) -> t(R.string.tomorrow)
        today.minusDays(1) -> t(R.string.yesterday)
        else -> formatSchoolDate(day, if (day.year == today.year) "EEE, d MMM" else "d MMM yyyy")
    }
}

/** German day-of-month keeps the ordinal period (`6.`). English stays `6`. */
fun schoolDatePattern(pattern: String, language: String = AppLanguage.formatLocale().language): String {
    if (!language.equals("de", ignoreCase = true)) return pattern
    return pattern.replace(Regex("""(?<![A-Za-z])d(?![A-Za-z.])"""), "d.")
}

fun formatSchoolDate(day: LocalDate, pattern: String): String =
    day.format(DateTimeFormatter.ofPattern(schoolDatePattern(pattern), AppLanguage.formatLocale()))

fun formatSchoolStamp(value: java.time.temporal.TemporalAccessor, pattern: String): String =
    DateTimeFormatter.ofPattern(schoolDatePattern(pattern), AppLanguage.formatLocale()).format(value)

/**
 * FaNotes sync only. A school-only session does not get this banner, and the action never
 * points at the school connection. School reconnect stays on its own banner.
 */
fun faNotesSyncCopy(status: SyncStatus, notesAccount: Boolean): Triple<Int, Int, Boolean>? {
    if (!notesAccount) return null
    return when (status) {
        SyncStatus.OFFLINE -> Triple(R.string.fanotes_offline, R.string.fanotes_offline_body, false)
        SyncStatus.ERROR -> Triple(R.string.fanotes_sync_needs_attention, R.string.fanotes_offline_body, true)
        else -> null
    }
}

fun parseDisplayDate(raw: String): LocalDate? = runCatching { LocalDate.parse(raw.take(10)) }.getOrNull() ?: parseSchoolDate(raw)
fun dateLabel(day: LocalDate): String = formatSchoolDate(day, "EEEE, d MMMM")
fun updatedLabel(raw: String): String = parseSchulnetzInstant(raw, ZoneId.systemDefault())?.atZone(ZoneId.systemDefault())
    ?.let { formatSchoolStamp(it, "d MMM · HH:mm") } ?: t(R.string.not_fetched_yet)
fun plainPreview(markdown: String): String = markdown.replace(Regex("<!--[\\s\\S]*?-->"), "")
    .replace(Regex("[#*`>_\\[\\]]"), "").trim().replace(Regex("\\s+"), " ").take(180)

fun searchableNoteText(markdown: String, transcript: String = ""): String =
    markdown.replace(Regex("""<!--[\s\S]*?-->"""), "") + "\n" + transcript

fun noteExcerpt(markdown: String, title: String): String = plainPreview(markdown.trimStart().replaceFirst(
    Regex("""^#{1,6}\s+${Regex.escape(title)}\s*(?:\n|$)""", RegexOption.IGNORE_CASE), ""))

enum class AgendaKind(val label: String) { Lesson("Lesson"), Exam("Exam"), Event("Event"), Task("Due");
    fun uiLabel(): String = when (this) {
        Lesson -> t(R.string.lesson)
        Exam -> t(R.string.exam)
        Event -> t(R.string.event)
        Task -> t(R.string.due)
    }
}
data class AgendaEntry(
    val key: String,
    val title: String,
    val kind: AgendaKind,
    val day: LocalDate,
    val start: String = "",
    val end: String = "",
    val detail: String = "",
    val school: AgendaEvent? = null,
    val local: CalendarEvent? = null,
    val task: HomeworkTask? = null,
) {
    val time: String get() = if (start.isBlank()) t(R.string.all_day) else if (end.isBlank() || end == start) start else "$start–$end"
}

fun nextCommitment(entries: List<AgendaEntry>, now: Instant, zone: ZoneId): AgendaEntry? {
    val today = now.atZone(zone).toLocalDate()
    val clock = now.atZone(zone).format(DateTimeFormatter.ofPattern("HH:mm"))
    return entries.filter { it.kind != AgendaKind.Task && it.school?.isCancelled() != true &&
        (it.day > today || (it.day == today && it.end.ifBlank { it.start.ifBlank { "23:59" } } >= clock)) }
        .minWithOrNull(compareBy<AgendaEntry> { it.day }.thenBy { it.start.isBlank() }.thenBy { it.start })
}

/** Includes inclusive all-day spans and recurring desktop events, without changing their metadata. */
fun calendarSpanOn(event: CalendarEvent, day: LocalDate, zone: ZoneId): Pair<LocalDateTime, LocalDateTime>? {
    fun wall(raw: String): LocalDateTime? = if (event.allDay || !raw.contains('T')) {
        parseDisplayDate(raw)?.atStartOfDay()
    } else parseSchulnetzInstant(raw, zone)?.atZone(zone)?.toLocalDateTime()
    val origin = wall(event.start) ?: return null
    val originalEnd = wall(event.end) ?: origin
    val duration = Duration.between(origin, originalEnd).let { if (it.isNegative) Duration.ZERO else it }
    val delta = when (event.recurrence) {
        "daily" -> ChronoUnit.DAYS.between(origin.toLocalDate(), day).toInt()
        "weekly" -> (ChronoUnit.DAYS.between(origin.toLocalDate(), day) / 7).toInt()
        "monthly" -> ChronoUnit.MONTHS.between(origin.toLocalDate().withDayOfMonth(1), day.withDayOfMonth(1)).toInt()
        "yearly" -> day.year - origin.year
        else -> 0
    }.coerceAtLeast(0)
    // A long-running occurrence may start in the preceding recurrence period.
    val lookBack = when (event.recurrence) {
        "daily" -> duration.toDays().coerceAtMost(delta.toLong()).toInt() + 1
        "weekly" -> (duration.toDays() / 7).coerceAtMost(delta.toLong()).toInt() + 1
        "monthly" -> (duration.toDays() / 28).coerceAtMost(delta.toLong()).toInt() + 1
        "yearly" -> (duration.toDays() / 365).coerceAtMost(delta.toLong()).toInt() + 1
        else -> 0
    }
    for (step in delta downTo (delta - lookBack).coerceAtLeast(0)) {
        val start = calendarInstanceStart(origin, step, event.recurrence)
        val until = event.recurrenceUntil?.let(::parseDisplayDate)
        if (until != null && start.toLocalDate() > until) continue
        if (start.toLocalDate().toString() in event.exceptionDates) continue
        val end = start.plus(duration)
        val lastDay = if (!event.allDay && end > start && end.toLocalTime() == LocalTime.MIDNIGHT) end.toLocalDate().minusDays(1) else end.toLocalDate()
        if (day >= start.toLocalDate() && day <= lastDay) return start to end
    }
    return null
}

/** True when closing the task sheet would throw away something the user typed. */
fun taskDraftDirty(
    existing: Boolean,
    title: String,
    subject: String,
    date: String,
    time: String,
    notes: String,
    important: Boolean,
    appointment: Boolean,
    originalTitle: String = "",
    originalSubject: String = "",
    originalDate: String = "",
    originalTime: String = "",
    originalNotes: String = "",
    originalImportant: Boolean = false,
    originalAppointment: Boolean = false,
): Boolean {
    if (!existing) {
        return title.isNotBlank() || subject.isNotBlank() || date.isNotBlank() || time.isNotBlank() || notes.isNotBlank() || important || appointment
    }
    return title != originalTitle || subject != originalSubject || date != originalDate || time != originalTime ||
        notes != originalNotes || important != originalImportant || appointment != originalAppointment
}

fun agendaForDays(
    days: List<LocalDate>,
    snapshot: SchulnetzSnapshot,
    calendar: CalendarDocument,
    tasks: List<HomeworkTask>,
    hidden: List<HiddenLesson>,
    zone: ZoneId = ZoneId.systemDefault(),
): Map<LocalDate, List<AgendaEntry>> {
    val schoolByDay = eventsByLocalDay(visibleEvents(snapshot.events + snapshot.exams, hidden, zone), zone)
    return days.associateWith { day -> agendaForDay(day, snapshot, calendar, tasks, hidden, zone, schoolByDay) }
}

fun agendaForDay(
    day: LocalDate,
    snapshot: SchulnetzSnapshot,
    calendar: CalendarDocument,
    tasks: List<HomeworkTask>,
    hidden: List<HiddenLesson>,
    zone: ZoneId = ZoneId.systemDefault(),
    schoolByDay: Map<LocalDate, List<AgendaEvent>>? = null,
): List<AgendaEntry> {
    val clock = DateTimeFormatter.ofPattern("HH:mm")
    val imported = calendar.events.map { it.id }.toSet()
    val school = (if (schoolByDay != null) schoolByDay[day].orEmpty() else eventsOn(visibleEvents(snapshot.events + snapshot.exams, hidden, zone), day, zone))
        .distinctBy(::lessonTargetId)
        .filterNot { "schulnetz-${it.id}" in imported }
        .map { event ->
            val startClock = eventClock(event, zone)
            val endClock = if (event.end.contains('T')) event.endsAt(zone)?.atZone(zone)?.format(clock).orEmpty() else ""
            val shownEnd = if (endClock == "00:00" && startClock.isBlank()) "" else endClock
            val room = cleanSchulnetzText(event.room)
            AgendaEntry("school:${lessonTargetId(event)}", preferredEventTitle(event), if (event.isExamLike() || event in snapshot.exams) AgendaKind.Exam else if (event.isLesson()) AgendaKind.Lesson else AgendaKind.Event, day,
                startClock, shownEnd,
                listOf(room.takeIf { it.isNotBlank() }?.let { t(R.string.room_named, it) }.orEmpty(), event.teachers.joinToString(", ") { cleanSchulnetzText(it) }).filter { it.isNotBlank() }.joinToString(" · "), school = event)
        }
    val visibleCalendars = calendar.calendars.filter { it.visible }.map { it.id }.toSet()
    val local = calendar.events.filter { it.calendarId in visibleCalendars && !(it.id.startsWith("hw:") && tasks.any { t -> "hw:${t.id}" == it.id }) }
        .mapNotNull { event ->
            val (start, end) = calendarSpanOn(event, day, zone) ?: return@mapNotNull null
            AgendaEntry("local:${event.id}:$day", event.title, AgendaKind.Event, day,
                if (event.allDay || day != start.toLocalDate()) "" else start.format(clock),
                if (event.allDay || day != end.toLocalDate()) "" else end.format(clock), event.location, local = event)
        }
    val due = tasks.filter { !it.done && parseDisplayDate(it.dueDate.orEmpty()) == day }.map { task ->
        AgendaEntry("task:${task.id}", task.title, AgendaKind.Task, day, task.dueTime.orEmpty(), detail = task.subject, task = task)
    }
    return (school + local + due).sortedWith(compareBy<AgendaEntry> { it.start.ifBlank { "00:00" } }.thenBy { it.kind.ordinal }.thenBy { it.title })
}
