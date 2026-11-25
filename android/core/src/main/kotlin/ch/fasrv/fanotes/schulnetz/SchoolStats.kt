package ch.fasrv.fanotes.schulnetz

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/*
 * School statistics computed only from the snapshot the app already holds: lesson cancellations,
 * grading time, tests waiting for a grade, corrected grades, exam load and absences. Nothing here reads
 * Schulnetz or sends anything. No mark is ever part of the result (guess-the-grade must not leak).
 * Mirrors fanotes-site/kanti-web/src/lib/stats.ts; both run core/src/test/resources/schulnetz/school-stats-cases.json.
 */

/** Counters of lessons: [total] counts every lesson, the others the lessons with that state. */
data class LessonCounts(
    val total: Int = 0,
    val cancelled: Int = 0,
    val substituted: Int = 0,
    val moved: Int = 0,
    val changed: Int = 0,
    val added: Int = 0,
) {
    val rate: Double get() = if (total == 0) 0.0 else cancelled.toDouble() / total
}

data class CourseCancellations(val key: String, val title: String, val teacher: String, val counts: LessonCounts)

/** Lessons and cancellations on one weekday (1 = Monday .. 7 = Sunday). */
data class WeekdayCount(val weekday: Int, val total: Int, val cancelled: Int)

/** Lessons and cancellations that start at one clock time (HH:mm). */
data class ClockCount(val clock: String, val total: Int, val cancelled: Int)

data class StatsCoverage(val firstDay: String, val lastDay: String, val weeks: Int)

data class RecentCancellation(val day: String, val title: String, val clock: String)

data class CancellationStats(
    val totals: LessonCounts,
    val courses: List<CourseCancellations>,
    val weekdays: List<WeekdayCount>,
    val clocks: List<ClockCount>,
    val coverage: StatsCoverage,
    val recent: List<RecentCancellation>,
)

data class CourseGrading(
    val key: String,
    val title: String,
    val teacher: String,
    val count: Int,
    val median: Double,
    val mean: Double,
    val fastest: Int,
    val slowest: Int,
)

data class RecentGrading(val title: String, val course: String, val testDay: String, val delay: Int)

data class GradingStats(
    val count: Int,
    val median: Double?,
    val mean: Double?,
    val courses: List<CourseGrading>,
    val recent: List<RecentGrading>,
)

data class WaitingExam(val title: String, val course: String, val examDay: String, val daysWaiting: Int)

data class ChangedGrade(val title: String, val course: String, val firstSeenDay: String, val versions: Int)

data class GradeChangeStats(val count: Int, val items: List<ChangedGrade>)

data class ExamWeek(val monday: String, val count: Int)

data class ExamLoad(val weeks: List<ExamWeek>, val busiestMonday: String, val busiestCount: Int, val next28: Int)

/** [subject] is blank for an absence without a subject; the screen names it. */
data class AbsenceSubject(val subject: String, val count: Int, val excused: Int)

data class SchoolStats(
    val cancellations: CancellationStats,
    val grading: GradingStats,
    val waiting: List<WaitingExam>,
    val gradeChanges: GradeChangeStats,
    val examLoad: ExamLoad,
    val absences: List<AbsenceSubject>,
)

const val STATS_MAX_DELAY_DAYS = 180
const val STATS_WAITING_MAX_DAYS = 120
const val STATS_MATCH_DAYS = 3
const val STATS_RECENT = 10
const val STATS_EXAM_AHEAD_DAYS = 28

private val statsZone: ZoneId = ZoneId.of("Europe/Zurich")
private val dayFormat = DateTimeFormatter.ISO_LOCAL_DATE

/** A real calendar day from an ISO or Swiss date, or null (the TS twin validates the calendar the same way). */
private fun statsDay(raw: String): LocalDate? = eventDate(raw)

private fun LocalDate.iso(): String = format(dayFormat)

private fun cmp(a: String, b: String): Int = a.compareTo(b)

private fun mostCommon(values: List<String>): String {
    val counts = values.groupingBy { it }.eachCount()
    val best = counts.values.maxOrNull() ?: return ""
    return counts.filterValues { it == best }.keys.minOf { it }
}

private fun teachersOf(event: AgendaEvent): String =
    event.teachers.map { cleanSchulnetzText(it) }.filter { it.isNotBlank() }.joinToString(", ")

private fun round1(value: Double): Double = Math.floor(value * 10 + 0.5) / 10

private fun median(sorted: List<Int>): Double {
    val n = sorted.size
    return if (n % 2 == 1) sorted[n / 2].toDouble() else (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
}

/** "subject|group" of a course label, else null: the identity stays stable when the teacher changes. */
private fun identityKey(label: String): String? = courseIdentity(label)?.let { "${it.subject}|${it.group}" }

private fun lessonKey(event: AgendaEvent): String =
    identityKey(event.courseName) ?: identityKey(event.text) ?: cleanSchulnetzText(event.label)

private class Counter {
    var total = 0
    var cancelled = 0
    var substituted = 0
    var moved = 0
    var changed = 0
    var added = 0
    fun add(cancelledNow: Boolean, substitutedNow: Boolean, event: AgendaEvent) {
        total++
        if (cancelledNow) cancelled++
        if (substitutedNow) substituted++
        if (event.marker == "moved") moved++
        if (event.marker == "changed") changed++
        if (event.marker == "added") added++
    }
    fun freeze() = LessonCounts(total, cancelled, substituted, moved, changed, added)
}

private class StatsLesson(val event: AgendaEvent, val day: LocalDate, val clock: String, val cancelled: Boolean) {
    val key = lessonKey(event)
}

private fun isCancelledLesson(event: AgendaEvent) = event.marker == "cancelled" || event.isCancelled()

/** Lessons of every loaded week, one per id and start (Schulnetz reuses a lesson id in every week). */
private fun dedupedLessons(events: List<AgendaEvent>): List<StatsLesson> {
    val byKey = LinkedHashMap<String, AgendaEvent>()
    for (event in events) if (event.isLesson()) byKey["${event.id}|${event.start}"] = event
    return byKey.values.mapNotNull { event ->
        val day = statsDay(event.start) ?: return@mapNotNull null
        StatsLesson(event, day, schulnetzClock(event.start), isCancelledLesson(event))
    }
}

private fun endClock(event: AgendaEvent, lesson: StatsLesson): String =
    schulnetzClock(event.end).ifBlank { lesson.clock }.ifBlank { "23:59" }

private fun courseTitles(lessons: List<StatsLesson>): Map<String, String> =
    lessons.groupBy { it.key }.mapValues { (_, items) ->
        // The most recent lesson names the course; on a tie the later one in the list wins.
        val latest = items.withIndex().maxWithOrNull(compareBy<IndexedValue<StatsLesson>>({ it.value.event.start }, { it.index }))!!.value
        preferredEventTitle(latest.event)
    }

private fun teacherLabels(lessons: List<StatsLesson>, keyOf: (StatsLesson) -> String = { it.key }): Map<String, String> =
    lessons.filter { !it.cancelled && keyOf(it).isNotEmpty() }.groupBy(keyOf).mapValues { (_, items) ->
        mostCommon(items.map { teachersOf(it.event) }.filter { it.isNotBlank() })
    }.filterValues { it.isNotEmpty() }

private fun cancellationStats(lessons: List<StatsLesson>, now: Instant, zone: ZoneId): CancellationStats {
    val nowLocal = now.atZone(zone).toLocalDateTime()
    val nowStamp = "${nowLocal.toLocalDate().iso()}T${"${nowLocal.hour.toString().padStart(2, '0')}:${nowLocal.minute.toString().padStart(2, '0')}"}"
    val past = lessons.filter { "${it.day.iso()}T${endClock(it.event, it)}" < nowStamp }
    val total = Counter()
    val perCourse = LinkedHashMap<String, Counter>()
    val weekdayTotals = IntArray(8)
    val weekdayCancelled = IntArray(8)
    val clockTotals = sortedMapOf<String, IntArray>()
    for (lesson in past) {
        val substituted = lesson.event.isSubstitution() && !lesson.cancelled
        total.add(lesson.cancelled, substituted, lesson.event)
        perCourse.getOrPut(lesson.key) { Counter() }.add(lesson.cancelled, substituted, lesson.event)
        val weekday = lesson.day.dayOfWeek.value
        weekdayTotals[weekday]++
        if (lesson.cancelled) weekdayCancelled[weekday]++
        if (lesson.clock.isNotBlank()) {
            val slot = clockTotals.getOrPut(lesson.clock) { IntArray(2) }
            slot[0]++
            if (lesson.cancelled) slot[1]++
        }
    }
    val titles = courseTitles(past)
    val teachers = teacherLabels(past)
    val courses = perCourse.map { (key, counter) ->
        CourseCancellations(key, titles[key].orEmpty(), teachers[key].orEmpty(), counter.freeze())
    }.sortedWith(Comparator { a, b ->
        // rate = cancelled / total, compared without division
        val byRate = (b.counts.cancelled.toLong() * a.counts.total).compareTo(a.counts.cancelled.toLong() * b.counts.total)
        if (byRate != 0) return@Comparator byRate
        val byCancelled = b.counts.cancelled.compareTo(a.counts.cancelled)
        if (byCancelled != 0) return@Comparator byCancelled
        val byTitle = cmp(a.title, b.title)
        if (byTitle != 0) byTitle else cmp(a.key, b.key)
    })
    val weekdays = (1..7).filter { it <= 5 || weekdayTotals[it] > 0 }.map { WeekdayCount(it, weekdayTotals[it], weekdayCancelled[it]) }
    val clocks = clockTotals.map { (clock, counts) -> ClockCount(clock, counts[0], counts[1]) }
    val days = past.map { it.day }
    val coverage = if (days.isEmpty()) StatsCoverage("", "", 0) else
        StatsCoverage(days.min().iso(), days.max().iso(), days.map { weekMonday(it) }.distinct().size)
    val recent = past.filter { it.cancelled }
        .sortedWith(Comparator { a, b ->
            val byStamp = cmp("${b.day.iso()}T${b.clock}", "${a.day.iso()}T${a.clock}")
            if (byStamp != 0) byStamp else cmp(b.event.id, a.event.id)
        })
        .take(STATS_RECENT)
        .map { RecentCancellation(it.day.iso(), preferredEventTitle(it.event), it.clock) }
    return CancellationStats(total.freeze(), courses, weekdays, clocks, coverage, recent)
}

private fun gradeKey(courseId: String, course: String, fallback: String): String =
    identityKey(courseId) ?: identityKey(course) ?: fallback

private fun trackKey(track: GradeTrack): String = gradeKey(track.courseId, track.course, track.courseKey)

private fun courseTitleOf(track: GradeTrack, grades: List<SchoolGrade>, key: String): String {
    val grade = grades.firstOrNull { gradeKey(it.courseId, it.course, it.courseKey) == key }
    return cleanSchulnetzText(grade?.displayCourseLabel() ?: track.course.ifBlank { track.courseId })
}

private data class Graded(val track: GradeTrack, val key: String, val testDay: LocalDate, val delay: Int)

private fun gradingStats(
    snapshot: SchulnetzSnapshot,
    lessons: List<StatsLesson>,
    zone: ZoneId,
): GradingStats {
    val teachers = teacherLabels(lessons)
    // A course the timetable names without a group part is found by its course id.
    val teachersById = teacherLabels(lessons) { cleanSchulnetzText(it.event.courseId) }
    val seen = snapshot.gradeHistory.associateWith { runCatching { Instant.parse(it.firstSeenAt) }.getOrNull() }
    val seed = seen.values.filterNotNull().minOrNull()
    val grades = snapshot.grades.withoutSummaryGrades()
    val graded = snapshot.gradeHistory.mapNotNull { track ->
        if (track.removedAt != null) return@mapNotNull null
        val first = seen[track] ?: return@mapNotNull null
        if (first == seed) return@mapNotNull null
        val testDay = statsDay(track.date) ?: return@mapNotNull null
        val delay = ChronoUnit.DAYS.between(testDay, first.atZone(zone).toLocalDate()).toInt()
        if (delay < 0 || delay > STATS_MAX_DELAY_DAYS) return@mapNotNull null
        Graded(track, trackKey(track), testDay, delay)
    }
    val courses = graded.groupBy { it.key }.map { (key, items) ->
        val delays = items.map { it.delay }.sorted()
        CourseGrading(
            key = key,
            title = courseTitleOf(items.first().track, grades, key),
            teacher = (teachers[key] ?: teachersById[cleanSchulnetzText(items.first().track.courseId)]).orEmpty(),
            count = delays.size,
            median = median(delays),
            mean = round1(delays.sum().toDouble() / delays.size),
            fastest = delays.first(),
            slowest = delays.last(),
        )
    }.sortedWith(Comparator { a, b ->
        val byMedian = a.median.compareTo(b.median)
        if (byMedian != 0) byMedian else cmp(a.title, b.title).let { if (it != 0) it else cmp(a.key, b.key) }
    })
    val all = graded.map { it.delay }.sorted()
    val titleOf = courses.associate { it.key to it.title }
    val recent = graded.sortedWith(Comparator { a, b ->
        val byFirst = cmp(b.track.firstSeenAt, a.track.firstSeenAt)
        if (byFirst != 0) byFirst else cmp(b.track.id, a.track.id)
    }).take(STATS_RECENT).map {
        RecentGrading(cleanSchulnetzText(it.track.title), titleOf[it.key].orEmpty(), it.testDay.iso(), it.delay)
    }
    return GradingStats(
        count = all.size,
        median = if (all.isEmpty()) null else median(all),
        mean = if (all.isEmpty()) null else round1(all.sum().toDouble() / all.size),
        courses = courses,
        recent = recent,
    )
}

private fun examIdentity(exam: AgendaEvent): String? =
    identityKey(exam.courseName) ?: identityKey(exam.text) ?: identityKey(exam.timetableText)

private data class ExamDay(val exam: AgendaEvent, val day: LocalDate)

private fun examDays(exams: List<AgendaEvent>): List<ExamDay> {
    val byKey = LinkedHashMap<String, AgendaEvent>()
    for (exam in exams) if (!isCancelledLesson(exam)) byKey["${exam.id}|${exam.start}"] = exam
    return byKey.values.mapNotNull { exam -> statsDay(exam.start)?.let { ExamDay(exam, it) } }
}

private fun waitingExams(snapshot: SchulnetzSnapshot, titles: Map<String, String>, today: LocalDate): List<WaitingExam> {
    // Every dated grade by course identity and by plain subject title.
    class Dated(val identity: String?, val names: Set<String>, val day: LocalDate)
    val dated = mutableListOf<Dated>()
    for (grade in snapshot.grades.withoutSummaryGrades()) {
        val day = statsDay(grade.date) ?: continue
        val names = listOf(grade.subject, grade.course, grade.courseId).map { cleanSchulnetzText(it).lowercase() }.filter { it.isNotBlank() }.toSet()
        dated += Dated(gradeKey(grade.courseId, grade.course, ""), names, day)
    }
    for (track in snapshot.gradeHistory) {
        if (track.removedAt != null) continue
        val day = statsDay(track.date) ?: continue
        val names = listOf(track.course, track.courseId).map { cleanSchulnetzText(it).lowercase() }.filter { it.isNotBlank() }.toSet()
        dated += Dated(gradeKey(track.courseId, track.course, ""), names, day)
    }
    return examDays(snapshot.exams).mapNotNull { (exam, day) ->
        val waited = ChronoUnit.DAYS.between(day, today).toInt()
        if (waited <= 0 || waited > STATS_WAITING_MAX_DAYS) return@mapNotNull null
        val identity = examIdentity(exam)
        val name = cleanSchulnetzText(exam.courseName).lowercase()
        if (identity == null && name.isBlank()) return@mapNotNull null
        val graded = dated.any { entry ->
            val sameCourse = if (identity != null) entry.identity == identity else name in entry.names
            sameCourse && Math.abs(ChronoUnit.DAYS.between(day, entry.day)) <= STATS_MATCH_DAYS
        }
        if (graded) return@mapNotNull null
        val title = cleanSchulnetzText(exam.text).ifBlank { cleanSchulnetzText(exam.timetableText) }.ifBlank { exam.label }
        val course = (identity?.let { titles[it] }).orEmpty().ifBlank { cleanSchulnetzText(exam.courseName).ifBlank { exam.label } }
        WaitingExam(title, course, day.iso(), waited)
    }.sortedWith(Comparator { a, b ->
        val byWait = b.daysWaiting.compareTo(a.daysWaiting)
        if (byWait != 0) byWait else cmp(a.title, b.title).let { if (it != 0) it else cmp(a.course, b.course) }
    })
}

private fun gradeChanges(snapshot: SchulnetzSnapshot, zone: ZoneId): GradeChangeStats {
    val grades = snapshot.grades.withoutSummaryGrades()
    val items = snapshot.gradeHistory.filter { track ->
        track.removedAt == null && track.versions.mapNotNull { it.mark }.distinct().size >= 2
    }.sortedWith(Comparator { a, b ->
        val byFirst = cmp(b.firstSeenAt, a.firstSeenAt)
        if (byFirst != 0) byFirst else cmp(b.id, a.id)
    }).map { track ->
        val first = runCatching { Instant.parse(track.firstSeenAt).atZone(zone).toLocalDate().iso() }.getOrDefault("")
        ChangedGrade(cleanSchulnetzText(track.title), courseTitleOf(track, grades, trackKey(track)), first, track.versions.size)
    }
    return GradeChangeStats(items.size, items)
}

private fun examLoad(snapshot: SchulnetzSnapshot, today: LocalDate): ExamLoad {
    val days = examDays(snapshot.exams).map { it.day }
    val perWeek = sortedMapOf<String, Int>()
    for (day in days) perWeek.merge(weekMonday(day).iso(), 1, Int::plus)
    val weeks = perWeek.map { ExamWeek(it.key, it.value) }
    // The earliest week wins a tie because the weeks are in date order and only a larger count replaces it.
    var busiest = ExamWeek("", 0)
    for (week in weeks) if (week.count > busiest.count) busiest = week
    val limit = today.plusDays(STATS_EXAM_AHEAD_DAYS.toLong())
    return ExamLoad(weeks, busiest.monday, busiest.count, days.count { !it.isBefore(today) && it.isBefore(limit) })
}

private fun absenceStats(absences: List<SchoolAbsence>): List<AbsenceSubject> =
    absences.groupBy { cleanSchulnetzText(it.subject) }.map { (subject, items) ->
        AbsenceSubject(subject, items.size, items.count { it.excused })
    }.sortedWith(Comparator { a, b ->
        val byCount = b.count.compareTo(a.count)
        if (byCount != 0) byCount else cmp(a.subject, b.subject)
    })

/** Every statistic the Statistik screen shows, as of [now]. Pure: the same snapshot gives the same numbers. */
fun schoolStats(snapshot: SchulnetzSnapshot, now: Instant, zone: ZoneId = statsZone): SchoolStats {
    val today = now.atZone(zone).toLocalDate()
    val lessons = dedupedLessons(snapshot.events)
    val titles = courseTitles(lessons)
    return SchoolStats(
        cancellations = cancellationStats(lessons, now, zone),
        grading = gradingStats(snapshot, lessons, zone),
        waiting = waitingExams(snapshot, titles, today),
        gradeChanges = gradeChanges(snapshot, zone),
        examLoad = examLoad(snapshot, today),
        absences = absenceStats(snapshot.absences),
    )
}
