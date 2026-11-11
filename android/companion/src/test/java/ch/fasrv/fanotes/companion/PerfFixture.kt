package ch.fasrv.fanotes.companion

import ch.fasrv.fanotes.schulnetz.AgendaEvent
import ch.fasrv.fanotes.schulnetz.SchoolAbsence
import ch.fasrv.fanotes.schulnetz.SchoolGrade
import ch.fasrv.fanotes.schulnetz.SchoolHomework
import ch.fasrv.fanotes.schulnetz.SchoolMessage
import ch.fasrv.fanotes.schulnetz.SchoolProfile
import ch.fasrv.fanotes.schulnetz.SchoolVacation
import ch.fasrv.fanotes.schulnetz.SchulnetzSnapshot
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.TemporalAdjusters
import java.util.Random

/** Synthetic school year (20 weeks, about 820 lessons) shared by the UI performance harness and the UI regression guard. */
object PerfFixture {
    class Course(val label: String, val title: String, val room: String, val teacher: String)

    val courses = listOf(
        Course("D", "Deutsch", "D101", "Lehrperson A"), Course("Ma", "Mathematik", "M204", "Lehrperson B"),
        Course("En", "Englisch", "E112", "Lehrperson C"), Course("Fr", "Französisch", "F108", "Lehrperson D"),
        Course("Bio", "Biologie", "N301", "Lehrperson E"), Course("Ch", "Chemie", "N305", "Lehrperson F"),
        Course("Ph", "Physik", "N310", "Lehrperson G"), Course("Ge", "Geschichte", "G020", "Lehrperson H"),
        Course("Gg", "Geografie", "G024", "Lehrperson I"), Course("WR", "Wirtschaft und Recht", "W015", "Lehrperson J"),
        Course("BG", "Bildnerisches Gestalten", "A001", "Lehrperson K"), Course("Mu", "Musik", "A010", "Lehrperson L"),
        Course("spf", "Sport", "Halle 1", "Lehrperson M"), Course("spm", "Sport", "Halle 2", "Lehrperson N"),
        Course("X-Sem1", "Ergänzungsfach Informatik", "I001", "Lehrperson O"), Course("X-Sem2", "Ergänzungsfach Recht", "I002", "Lehrperson P"),
        Course("Amos 1.1", "Anwendungen der Mathematik", "M210", "Lehrperson B"), Course("Amos 1.2", "Anwendungen der Mathematik", "M211", "Lehrperson Q"),
    ).associateBy { it.label }

    val slots = listOf(
        "07:45" to "08:30", "08:35" to "09:20", "09:40" to "10:25", "10:30" to "11:15", "11:25" to "12:10",
        "12:15" to "13:00", "13:15" to "14:00", "14:05" to "14:50", "15:00" to "15:45", "15:50" to "16:35",
    )

    /** Pseudo keys: SPORT alternates spf/spm by week, X switches Sem1 to Sem2 mid-year, AMOS alternates 1.1/1.2. */
    val template: List<List<Pair<Int, String>>> = listOf(
        listOf(0 to "D", 1 to "Ma", 2 to "En", 3 to "En", 4 to "Bio", 6 to "SPORT", 7 to "SPORT", 8 to "X"),
        listOf(0 to "Ma", 1 to "Fr", 2 to "Ge", 3 to "Ch", 4 to "Ch", 6 to "AMOS", 7 to "Ph", 8 to "D"),
        listOf(0 to "Ph", 1 to "D", 2 to "Ma", 3 to "BG", 4 to "BG", 6 to "WR", 7 to "X", 8 to "Gg"),
        listOf(0 to "En", 1 to "Gg", 2 to "D", 3 to "Fr", 4 to "Mu", 5 to "Ma", 6 to "SPORT", 7 to "SPORT", 8 to "AMOS"),
        listOf(0 to "Bio", 1 to "Ma", 2 to "WR", 3 to "Ph", 4 to "Ge", 6 to "Fr", 7 to "En", 8 to "Mu"),
    )

    fun lesson(day: LocalDate, slot: Int, course: Course, status: String = "", comment: String = "", teacher: String = course.teacher) = AgendaEvent(
        id = "perf-lesson-$day-$slot", start = "${day}T${slots[slot].first}:00", end = "${day}T${slots[slot].second}:00",
        text = course.title, comment = comment, room = course.room, teachers = listOf(teacher),
        courseId = "perf-${course.label}", courseName = course.label, status = status, eventType = "0_stp", color = "", timetableText = course.title,
    )

    fun exam(day: LocalDate, from: Int, to: Int, course: Course, topic: String) = AgendaEvent(
        id = "perf-exam-$day-${course.label}", start = "${day}T${slots[from].first}:00", end = "${day}T${slots[to].second}:00",
        text = "${course.title}: $topic", comment = topic, room = course.room, teachers = listOf(course.teacher),
        courseId = "perf-${course.label}", courseName = course.label, status = "", eventType = "exam", color = "", timetableText = "Prüfung ${course.title}",
    )

    fun buildSnapshot(today: LocalDate): SchulnetzSnapshot {
        val random = Random(42)
        val monday = today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        val weeks = (-9L..10L).map { monday.plusWeeks(it) }
        val stamp = java.time.Instant.now().toString()
        val lessons = mutableListOf<AgendaEvent>()
        weeks.forEachIndexed { weekIndex, week ->
            template.forEachIndexed { dayIndex, entries ->
                val day = week.plusDays(dayIndex.toLong())
                entries.forEach { (slot, key) ->
                    val label = when (key) {
                        "SPORT" -> if (weekIndex % 2 == 0) "spf" else "spm"
                        "AMOS" -> if (weekIndex % 2 == 0) "Amos 1.1" else "Amos 1.2"
                        "X" -> if (weekIndex < 10) "X-Sem1" else "X-Sem2"
                        else -> key
                    }
                    val course = courses.getValue(label)
                    val roll = random.nextInt(60)
                    lessons += when (roll) {
                        0 -> lesson(day, slot, course, status = "entfällt", comment = "Lektion fällt aus")
                        1 -> lesson(day, slot, course, comment = "Vertretung", teacher = "Lehrperson Z")
                        else -> lesson(day, slot, course)
                    }
                }
            }
        }
        val firstLessonOf = { label: String, after: LocalDate -> lessons.first { it.courseName == label && LocalDate.parse(it.start.take(10)) >= after } }
        // 15 exams: some exactly on one lesson slot, some across two; four of them soon.
        val examSpecs = listOf(-60 to "Ma", -49 to "D", -40 to "En", -33 to "Bio", -25 to "Fr", -18 to "Ge", -11 to "Ch", -4 to "Ph",
            3 to "Ma", 6 to "En", 12 to "Bio", 20 to "D", 27 to "Fr", 38 to "WR", 52 to "Ge")
        val exams = examSpecs.mapIndexed { index, (offset, label) ->
            val base = firstLessonOf(label, today.plusDays(offset.toLong()))
            val day = LocalDate.parse(base.start.take(10))
            val slot = slots.indexOfFirst { base.start.endsWith("T${it.first}:00") }.coerceAtLeast(0)
            exam(day, slot, if (index % 3 == 0) (slot + 1).coerceAtMost(slots.lastIndex) else slot, courses.getValue(label), "Thema ${index + 1}")
        }
        val gradeCourses = listOf("D", "Ma", "En", "Fr", "Bio", "Ch", "Ph", "Ge", "Gg", "WR", "BG", "Mu", "X-Sem1", "Amos 1.1")
        val grades = (0 until 40).map { index ->
            val course = courses.getValue(gradeCourses[index % gradeCourses.size])
            SchoolGrade(
                id = "perf-grade-$index", course = "${course.label}-K26A", courseId = "perf-${course.label}", subject = course.title,
                title = "Prüfung ${index / gradeCourses.size + 1}", date = today.minusDays((5 + index * 2L)).toString(),
                mark = (3 + random.nextInt(13)) * 0.25 + 1.0, weight = if (index % 7 == 0) 0.5 else 1.0, confirmed = true, courseGrade = null, comment = "",
            )
        }
        val absences = (0 until 20).map { index ->
            val day = today.minusDays(3L + index * 5)
            val open = index < 3
            SchoolAbsence(
                id = "perf-absence-$index", dateFrom = day.toString(), dateTo = day.toString(), hourFrom = slots[index % 4].first, hourTo = slots[index % 4].second,
                subject = courses.values.toList()[index % 12].title, reason = if (open) "" else "Krankheit", excused = !open && index % 2 == 0, acknowledged = !open,
                status = if (open) "offen" else "gebucht", excuseUntil = if (open) today.plusDays(4L + index).toString() else "",
                points = if (open) null else 1.0 + index % 3, pending = open,
            )
        }
        val homework = (0 until 12).map { index ->
            val course = courses.values.toList()[index % 12]
            SchoolHomework("perf-hw-$index", "Aufgabe ${index + 1}", "Seiten ${10 + index} bis ${14 + index}", today.plusDays(index * 2L - 3).toString(), "perf-${course.label}", course.title)
        }
        return SchulnetzSnapshot(
            revision = 7, fetchedAt = stamp, profile = SchoolProfile("perf-profile", "Test", "Schüler:in", "K26A", ""),
            grades = grades, events = lessons, exams = exams, absences = absences, homework = homework,
            messages = (0 until 6).map { SchoolMessage("perf-msg-$it", "Mitteilung ${it + 1}", "Text der Mitteilung ${it + 1}", stamp) },
            vacations = listOf(SchoolVacation("perf-vac-1", "Herbstferien", monday.plusWeeks(6).toString(), monday.plusWeeks(7).plusDays(4).toString())),
            weekFetched = weeks.associate { it.toString() to stamp }, weekRead = weeks.associate { it.toString() to stamp },
            examWeekFetched = weeks.associate { it.toString() to stamp },
            weekSpanStart = weeks.first().toString(), weekSpanEnd = weeks.last().plusDays(4).toString(),
            absenceQuota = 30.0, absenceRemaining = 21.0, absenceParser = ch.fasrv.fanotes.schulnetz.ABSENCE_PARSER_VERSION,
        )
    }

    fun mensaJson(today: LocalDate): String {
        val days = (0 until 14).map { today.plusDays(it - 3L) }.filter { it.dayOfWeek.value < 6 }.joinToString(",") { day ->
            """{"date":"$day","closed":false,"note":"","menus":[
              {"name":"Gemüsecurry","description":"Reis, Kokosmilch, Saisongemüse","label":"Vegi","price":13.5,"studentPrice":10.5},
              {"name":"Pouletgeschnetzeltes","description":"Rahmsauce, Nudeln, Salat","label":"Fleisch","price":15.0,"studentPrice":11.5}]}"""
        }
        return """{"fetchedAt":"${java.time.Instant.now()}","stale":false,"days":[$days]}"""
    }
}
