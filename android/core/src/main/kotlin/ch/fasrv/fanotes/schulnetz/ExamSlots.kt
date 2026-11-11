package ch.fasrv.fanotes.schulnetz

import java.time.ZoneId

/** One exam that takes the place of one or two lessons: [original] as listed, [shown] with the lesson slot and room. */
data class ExamInSlot(val original: AgendaEvent, val shown: AgendaEvent)

/**
 * Result of [examsInLessonSlots]. Lessons are identified by id plus start because Schulnetz reuses
 * lesson ids every week.
 */
data class ExamSlotMerge(val droppedLessons: Set<String>, val exams: List<ExamInSlot>) {
    fun lessonDropped(lesson: AgendaEvent): Boolean = lessonKey(lesson) in droppedLessons

    /** First merged exam per key, as the former scan returned it; a lookup instead of a scan per event. */
    private val shownByKey: Map<String, AgendaEvent> by lazy(LazyThreadSafetyMode.PUBLICATION) {
        val map = LinkedHashMap<String, AgendaEvent>()
        exams.forEach { map.putIfAbsent(examKey(it.original), it.shown) }
        map
    }

    fun replacement(exam: AgendaEvent): AgendaEvent? = if (exams.isEmpty()) null else shownByKey[examKey(exam)]

    /** [events] without the replaced lessons, with the merged exams in their slots, once per slot and title. */
    fun apply(events: List<AgendaEvent>): List<AgendaEvent> =
        events.mapNotNull { replacement(it) ?: it.takeUnless { event -> lessonDropped(event) } }
            .distinctBy(::slotDedupKey)
}

/**
 * One entry per slot and title. A cancelled lesson stays its own entry, so it neither hides an exam of the
 * same title and time nor is hidden by one.
 */
fun slotDedupKey(event: AgendaEvent): List<Any> = listOf(event.start, event.end, event.label.lowercase(), event.isCancelled())

private fun examKey(event: AgendaEvent) = "${event.id}|${event.start}|${event.label}"

private fun lessonKey(event: AgendaEvent) = "${event.id}|${event.start}|"

private val offsetSuffix = Regex("""[+-]\d{2}:\d{2}$""")
private val clockOnly = Regex("""^(\d{2}):(\d{2})$""")

private fun zonedStamp(raw: String): Boolean = raw.contains('Z') || offsetSuffix.containsMatchIn(raw)

private fun minutesOf(raw: String, zone: ZoneId): Int? {
    val clock = if (zonedStamp(raw)) {
        parseSchulnetzInstant(raw, zone)?.atZone(zone)?.toLocalTime()?.toString()?.take(5).orEmpty()
    } else schulnetzClock(raw)
    val match = clockOnly.find(clock) ?: return null
    return match.groupValues[1].toInt() * 60 + match.groupValues[2].toInt()
}

private fun dayOf(raw: String, zone: ZoneId): java.time.LocalDate? =
    if (zonedStamp(raw)) parseSchulnetzInstant(raw, zone)?.atZone(zone)?.toLocalDate() else eventDate(raw)

private fun lowerText(vararg parts: String) = parts.joinToString(" ") { cleanSchulnetzText(it) }.lowercase()

private fun belongsToCourse(exam: AgendaEvent, lesson: AgendaEvent): Boolean {
    if (exam.courseId.isNotBlank() && exam.courseId == lesson.courseId) return true
    val name = cleanSchulnetzText(lesson.courseName).lowercase()
    if (name.isNotBlank() && lowerText(exam.text, exam.courseName, exam.timetableText).contains(name)) return true
    val token = colorKeys(lesson.label).getOrNull(1) ?: colorKeys(lesson.label).firstOrNull() ?: return false
    return token.length >= 2 && exam.label.lowercase().startsWith(token)
}

/**
 * Exams scheduled for exactly one lesson, or two consecutive lessons, of one course take that slot:
 * the lessons are dropped and the exam is shown from the first lesson's start to the last one's end,
 * with the lesson's room when the exam has none. Every other exam is left alone.
 */
fun examsInLessonSlots(lessons: List<AgendaEvent>, exams: List<AgendaEvent>, zone: ZoneId = SCHOOL_ZONE): ExamSlotMerge {
    val dayLessons = lessons.filter { it.isLesson() && !it.isCancelled() }.mapNotNull { lesson ->
        val day = dayOf(lesson.start, zone) ?: return@mapNotNull null
        val from = minutesOf(lesson.start, zone) ?: return@mapNotNull null
        val to = minutesOf(lesson.end, zone) ?: return@mapNotNull null
        if (to <= from) null else Triple(day, from..to, lesson)
    }.groupBy { it.first }.mapValues { (_, list) -> list.sortedBy { it.second.first } }
    val dropped = mutableSetOf<String>()
    val merged = mutableListOf<ExamInSlot>()
    for (exam in exams) {
        val day = dayOf(exam.start, zone) ?: continue
        val from = minutesOf(exam.start, zone) ?: continue
        val to = minutesOf(exam.end, zone) ?: continue
        if (to <= from) continue
        val sameDay = dayLessons[day].orEmpty()
        val hits = sameDay.withIndex().filter { (_, l) -> l.second.first < to && l.second.last > from }
        if (hits.isEmpty() || hits.size > 2) continue
        if (hits.size == 2 && hits[1].index != hits[0].index + 1) continue
        val first = hits.first().value.third
        val last = hits.last().value.third
        if (hits.any { it.value.third.label != first.label }) continue
        if (!belongsToCourse(exam, first)) continue
        val shown = exam.copy(
            start = first.start,
            end = last.end,
            room = exam.room.ifBlank { first.room },
            eventType = if (exam.isExamLike()) exam.eventType else "exam",
        )
        hits.forEach { dropped += lessonKey(it.value.third) }
        merged += ExamInSlot(exam, shown)
    }
    return ExamSlotMerge(dropped, merged)
}
