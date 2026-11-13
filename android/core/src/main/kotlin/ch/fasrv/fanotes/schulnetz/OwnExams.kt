package ch.fasrv.fanotes.schulnetz

/*
 * The student's own exams. The class overview (klassenuebersicht) and the Prüfungsplan list the whole
 * Abteilung, so an exam stays only when it does not name a course the student does not take.
 * Mirrors ownExams / courseIdentity in fanotes-site/schulnetz-logic.mjs.
 */

/** Subject, group part and optional teacher of a course label, all lower case. */
data class CourseIdentity(val subject: String, val group: String, val teacher: String)

private val courseGroupToken = Regex("""(?i)^(?:[a-z]{1,2}\d{2}[a-z]{0,2}|\d+(?:\.\d+)+)$""")
private val courseHead = Regex("""^([^\s_]+)(?:([_\s])([^\s_]+))?(?:([_\s])([^\s_]+))?""")
private val teacherToken = Regex("""(?iu)^[a-zäöüéèà]+$""")

/**
 * A label starts with the subject, then a group part (a class group such as `G24a`, or a group number
 * such as `2.3`), then optionally a teacher. `_` and a space both separate the parts. A label without a
 * group part (`Bio Test ...`, a class appointment) has no course identity and is never filtered.
 */
fun courseIdentity(label: String): CourseIdentity? {
    val head = cleanSchulnetzText(label).lineSequence().firstOrNull().orEmpty().trim()
    val match = courseHead.find(head) ?: return null
    val group = match.groupValues[3]
    if (!courseGroupToken.matches(group)) return null
    // A teacher only counts when the code joins it with `_`; after a space the words are the exam title.
    val teacher = match.groupValues[5].takeIf { match.groupValues[4] == "_" && teacherToken.matches(it) }.orEmpty().lowercase()
    return CourseIdentity(match.groupValues[1].lowercase(), group.lowercase(), teacher)
}

private fun sameCourse(own: CourseIdentity, exam: CourseIdentity): Boolean =
    own.subject == exam.subject && own.group == exam.group &&
        (own.teacher.isEmpty() || exam.teacher.isEmpty() || own.teacher == exam.teacher)

/** [exams] narrowed to the courses of the lessons in [events] (every loaded week). */
data class OwnExams(val exams: List<AgendaEvent>, val unfiltered: Boolean)

/**
 * Without any lesson the personal timetable has not loaded: nothing is filtered and [OwnExams.unfiltered]
 * says so, rather than hiding every exam.
 */
fun ownExams(exams: List<AgendaEvent>, events: List<AgendaEvent>): OwnExams {
    val lessons = events.filter { it.isLesson() }
    if (lessons.isEmpty()) return OwnExams(exams, exams.isNotEmpty())
    val courses = lessons.mapNotNull { courseIdentity(it.courseName) ?: courseIdentity(it.text) }
    val kept = exams.filter { exam ->
        val identity = courseIdentity(exam.courseName) ?: courseIdentity(exam.text) ?: courseIdentity(exam.timetableText)
        identity == null || courses.any { sameCourse(it, identity) }
    }
    return OwnExams(kept, false)
}

/** The snapshot with its exam list narrowed to the student's courses and the unfiltered state recorded. */
fun SchulnetzSnapshot.withOwnExams(): SchulnetzSnapshot {
    val own = ownExams(exams, events)
    return if (own.exams.size == exams.size && own.unfiltered == examsUnfiltered) this else copy(exams = own.exams, examsUnfiltered = own.unfiltered)
}

/** An exam listed both in the timetable and in the overview (same slot, same label) is one exam. */
fun dedupeExams(exams: List<AgendaEvent>): List<AgendaEvent> = distinctExams(exams)
