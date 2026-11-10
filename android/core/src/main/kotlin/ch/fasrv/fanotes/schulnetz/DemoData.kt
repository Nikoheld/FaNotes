package ch.fasrv.fanotes.schulnetz

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.temporal.TemporalAdjusters

/*
 * Demo mode: a complete, clearly invented school snapshot for app review and for trying Kanti+
 * without a Schulnetz account. Every name, mark, room and date below is synthetic and built
 * relative to "today", so the current week and the coming weeks always have lessons.
 * Nothing here is read from or sent to Schulnetz or the Kanti+ server.
 */

const val DEMO_ID_PREFIX = "demo-"
const val DEMO_DISPLAY_NAME = "Demo Schüler:in"

/** Weeks of timetable before and after the current week. */
private const val DEMO_WEEKS_BACK = 2L
private const val DEMO_WEEKS_AHEAD = 10L

private data class DemoSubject(val name: String, val code: String, val room: String, val teacher: String)

private val SUBJECTS = listOf(
    DemoSubject("Deutsch", "D", "D101", "Lehrperson A"),
    DemoSubject("Mathematik", "M", "M204", "Lehrperson B"),
    DemoSubject("Englisch", "E", "E112", "Lehrperson C"),
    DemoSubject("Französisch", "F", "F108", "Lehrperson D"),
    DemoSubject("Biologie", "B", "N301", "Lehrperson E"),
    DemoSubject("Chemie", "C", "N305", "Lehrperson F"),
    DemoSubject("Physik", "P", "N310", "Lehrperson G"),
    DemoSubject("Geschichte", "G", "G020", "Lehrperson H"),
    DemoSubject("Geografie", "GG", "G024", "Lehrperson I"),
    DemoSubject("Wirtschaft und Recht", "WR", "W015", "Lehrperson J"),
    DemoSubject("Bildnerisches Gestalten", "BG", "A001", "Lehrperson K"),
    DemoSubject("Musik", "MU", "A010", "Lehrperson L"),
    DemoSubject("Sport", "S", "Halle 1", "Lehrperson M"),
).associateBy { it.name }

private val SLOTS = listOf("07:45" to "08:30", "08:35" to "09:20", "09:40" to "10:25", "10:30" to "11:15", "11:25" to "12:10", "13:15" to "14:00")

/** Monday to Friday, one subject per slot; null is a free slot. */
private val WEEK = listOf(
    listOf("Deutsch", "Mathematik", "Englisch", "Englisch", "Biologie", "Sport"),
    listOf("Mathematik", "Französisch", "Geschichte", "Chemie", "Chemie", null),
    listOf("Physik", "Deutsch", "Mathematik", "Bildnerisches Gestalten", "Bildnerisches Gestalten", null),
    listOf("Englisch", "Geografie", "Deutsch", "Französisch", "Musik", "Sport"),
    listOf("Biologie", "Mathematik", "Wirtschaft und Recht", "Physik", "Geschichte", null),
)

/** True for any id the demo created. Real Schulnetz ids never start with this prefix. */
fun isDemoId(id: String): Boolean = id.startsWith(DEMO_ID_PREFIX)

/** True when a snapshot is the demo snapshot, so it is never cached, uploaded or diffed. */
fun SchulnetzSnapshot.isDemo(): Boolean = profile?.id == "${DEMO_ID_PREFIX}profile"

private fun weekday(day: LocalDate): LocalDate = when (day.dayOfWeek) {
    DayOfWeek.SATURDAY -> day.plusDays(2)
    DayOfWeek.SUNDAY -> day.plusDays(1)
    else -> day
}

private fun lesson(day: LocalDate, slot: Int, subject: DemoSubject, status: String = "", comment: String = "", teacher: String = subject.teacher) = AgendaEvent(
    id = "${DEMO_ID_PREFIX}lesson-$day-$slot",
    start = "${day}T${SLOTS[slot].first}:00",
    end = "${day}T${SLOTS[slot].second}:00",
    text = subject.name,
    comment = comment,
    room = subject.room,
    teachers = listOf(teacher),
    courseId = "${DEMO_ID_PREFIX}${subject.code}",
    courseName = subject.name,
    status = status,
    eventType = "0_stp",
    color = "",
    timetableText = subject.name,
)

private fun exam(day: LocalDate, slot: Int, subject: DemoSubject, topic: String) = AgendaEvent(
    id = "${DEMO_ID_PREFIX}exam-$day-${subject.code}",
    start = "${day}T${SLOTS[slot].first}:00",
    end = "${day}T${SLOTS[slot].second}:00",
    text = "${subject.name}: $topic",
    comment = topic,
    room = subject.room,
    teachers = listOf(subject.teacher),
    courseId = "${DEMO_ID_PREFIX}${subject.code}",
    courseName = subject.name,
    status = "",
    eventType = "exam",
    color = "",
    timetableText = "Prüfung ${subject.name}",
)

private fun appointment(day: LocalDate, id: String, title: String, room: String, from: String = "08:00", to: String = "12:00") = AgendaEvent(
    id = "${DEMO_ID_PREFIX}event-$id",
    start = "${day}T$from:00",
    end = "${day}T$to:00",
    text = title,
    comment = "",
    room = room,
    teachers = emptyList(),
    courseId = "",
    courseName = "",
    status = "",
    eventType = "event",
    color = "",
    timetableText = "",
)

private fun grade(id: String, subject: String, title: String, date: LocalDate, mark: Double, weight: Double = 1.0) = SUBJECTS.getValue(subject).let { s ->
    SchoolGrade(
        id = "${DEMO_ID_PREFIX}grade-$id",
        course = "${s.code}-K26A",
        courseId = "${DEMO_ID_PREFIX}${s.code}",
        subject = s.name,
        title = title,
        date = date.toString(),
        mark = mark,
        weight = weight,
        confirmed = true,
        courseGrade = null,
        comment = "",
    )
}

/**
 * The demo snapshot for [today]: timetable two weeks back and ten weeks ahead (one cancelled lesson
 * and one substitution next week), upcoming and past exams, school appointments, marks across
 * subjects, absences with an open excuse deadline, a message and an account statement.
 */
fun demoSnapshot(today: LocalDate, now: ZonedDateTime = today.atTime(7, 0).atZone(SCHOOL_ZONE)): SchulnetzSnapshot {
    val monday = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
    val nextMonday = monday.plusWeeks(1)
    val stamp = now.toInstant().toString()
    val weeks = (-DEMO_WEEKS_BACK..DEMO_WEEKS_AHEAD).map { monday.plusWeeks(it) }
    val lessons = weeks.flatMap { week ->
        WEEK.flatMapIndexed { dayIndex, slots ->
            val day = week.plusDays(dayIndex.toLong())
            slots.mapIndexedNotNull { slot, name ->
                val subject = SUBJECTS.getValue(name ?: return@mapIndexedNotNull null)
                when {
                    week == nextMonday && dayIndex == 3 && slot == 4 -> lesson(day, slot, subject, status = "entfällt", comment = "Lektion fällt aus")
                    week == nextMonday && dayIndex == 4 && slot == 3 -> lesson(day, slot, subject, comment = "Vertretung", teacher = "Lehrperson Z")
                    else -> lesson(day, slot, subject)
                }
            }
        }
    }
    val exams = listOf(
        exam(weekday(today.minusDays(9)), 1, SUBJECTS.getValue("Englisch"), "Vocabulary Unit 4"),
        exam(weekday(today.plusDays(2)), 1, SUBJECTS.getValue("Mathematik"), "Funktionen"),
        exam(weekday(today.plusDays(8)), 0, SUBJECTS.getValue("Biologie"), "Zellbiologie"),
        exam(weekday(today.plusDays(15)), 2, SUBJECTS.getValue("Geschichte"), "Industrialisierung"),
        exam(weekday(today.plusDays(23)), 3, SUBJECTS.getValue("Französisch"), "Passé composé"),
    )
    val appointments = listOf(
        appointment(weekday(today.plusDays(5)), "sporttag", "Sporttag (Demo)", "Sportanlage"),
        appointment(weekday(today.plusDays(19)), "elternabend", "Elternabend (Demo)", "Aula", "19:00", "20:30"),
        appointment(weekday(today.plusDays(33)), "exkursion", "Exkursion Geografie (Demo)", "Treffpunkt Bahnhof"),
    )
    val grades = listOf(
        grade("m1", "Mathematik", "Prüfung Gleichungen", today.minusDays(52), 5.0),
        grade("m2", "Mathematik", "Prüfung Geometrie", today.minusDays(24), 4.5),
        grade("d1", "Deutsch", "Aufsatz", today.minusDays(40), 5.5),
        grade("d2", "Deutsch", "Lektüreprüfung", today.minusDays(12), 5.0, 0.5),
        grade("e1", "Englisch", "Vocabulary Unit 3", today.minusDays(31), 4.75),
        grade("f1", "Französisch", "Compréhension", today.minusDays(35), 4.0),
        grade("b1", "Biologie", "Ökologie", today.minusDays(28), 5.25),
        grade("c1", "Chemie", "Laborbericht", today.minusDays(20), 5.5, 0.5),
        grade("p1", "Physik", "Mechanik", today.minusDays(44), 3.75),
        grade("p2", "Physik", "Energie", today.minusDays(6), 4.5),
        grade("g1", "Geschichte", "Antike", today.minusDays(38), 5.0),
        grade("w1", "Wirtschaft und Recht", "Marktformen", today.minusDays(16), 4.5),
    )
    // A booked entry with its points and an open report of a double lesson (estimated 2 + 1 = 3).
    val reportDay = weekday(today.minusDays(3))
    val reportSubjects = WEEK[reportDay.dayOfWeek.value - 1]
    val absences = listOf(
        SchoolAbsence("${DEMO_ID_PREFIX}absence-1", weekday(today.minusDays(18)).toString(), weekday(today.minusDays(18)).toString(), "", "",
            "", "Krankheit", excused = false, acknowledged = true, status = "gebucht", points = 5.0),
        SchoolAbsence("${DEMO_ID_PREFIX}absence-2", reportDay.toString(), reportDay.toString(), SLOTS[0].first, SLOTS[0].second,
            reportSubjects[0] ?: "Lektion", "", excused = false, acknowledged = false, status = "offen", excuseUntil = weekday(today.plusDays(4)).toString(), pending = true),
        SchoolAbsence("${DEMO_ID_PREFIX}absence-3", reportDay.toString(), reportDay.toString(), SLOTS[1].first, SLOTS[1].second,
            reportSubjects[1] ?: "Lektion", "", excused = false, acknowledged = false, status = "offen", pending = true),
    )
    val messages = listOf(
        SchoolMessage("${DEMO_ID_PREFIX}message-1", "Willkommen im Demo-Modus",
            "Alle Angaben in diesem Modus sind erfunden. Kanti+ liest im Demo-Modus nichts aus Schulnetz und sendet nichts an einen Server.", stamp),
    )
    val konto = listOf(
        KontoLine(today.minusDays(40).toString(), "Kopierkosten (Demo)", "-12.50", "37.50"),
        KontoLine(today.minusDays(60).toString(), "Einzahlung (Demo)", "50.00", "50.00"),
    )
    val read = weeks.associate { it.toString() to stamp }
    return SchulnetzSnapshot(
        revision = 1,
        fetchedAt = stamp,
        profile = SchoolProfile(id = "${DEMO_ID_PREFIX}profile", firstName = "Demo", lastName = "Schüler:in", className = "K26A", email = ""),
        grades = grades,
        events = lessons + appointments,
        exams = exams,
        absences = absences,
        absenceQuota = 30.0,
        absenceRemaining = 25.0,
        absenceParser = ABSENCE_PARSER_VERSION,
        messages = messages,
        konto = konto,
        weekFetched = read,
        weekRead = read,
        examWeekFetched = read,
        weekSpanStart = weeks.first().toString(),
        weekSpanEnd = weeks.last().plusDays(4).toString(),
    )
}
