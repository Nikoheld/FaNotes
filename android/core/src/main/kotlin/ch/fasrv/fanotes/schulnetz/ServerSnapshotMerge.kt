package ch.fasrv.fanotes.schulnetz

import java.time.Instant

/*
 * The app takes the server's copy of its school data after a push, and when its own Schulnetz read
 * did not get through. That copy can be partial: fewer weeks than the app read, no appointments, a
 * week the server could not read, or a grade list from an older parser. Taking it wholesale used to
 * replace every stored lesson as soon as the copy held any event at all.
 */

/**
 * [phone] after it takes [server]. Lessons are merged week by week: a server week replaces the
 * phone's lessons only when it has lessons and the server read that week at least as recently. An
 * empty, missing or older server week keeps the phone's lessons. Grades come from the server only
 * when its parser reads every row ([GRADE_PARSER_VERSION]) and the read was complete.
 */
fun adoptServerSnapshot(phone: SchulnetzSnapshot, server: SchulnetzSnapshot): SchulnetzSnapshot {
    val phoneWeeks = phone.events.filter { it.isLesson() }.groupBy { weekMondayKey(it.start).orEmpty() }
    val serverWeeks = server.events.filter { it.isLesson() }.groupBy { weekMondayKey(it.start).orEmpty() }
    val lessons = (phoneWeeks.keys + serverWeeks.keys).flatMap { week ->
        val fromServer = serverWeeks[week].orEmpty()
        val fromPhone = phoneWeeks[week].orEmpty()
        when {
            fromServer.isEmpty() -> fromPhone
            fromPhone.isEmpty() -> fromServer
            notOlder(server.weekRead[week], phone.weekRead[week]) -> fromServer
            else -> fromPhone
        }
    }
    val appointments = server.events.filterNot { it.isLesson() }.ifEmpty { phone.events.filterNot { it.isLesson() } }
    val serverGrades = server.gradeParser >= GRADE_PARSER_VERSION && server.trustedGradeRead() && server.grades.isNotEmpty()
    return adoptAbsences(phone, server).copy(
        revision = phone.revision + 1,
        fetchedAt = later(server.fetchedAt, phone.fetchedAt),
        profile = server.profile ?: phone.profile,
        grades = if (serverGrades) keepGradeRead(phone.grades, server.grades, true) else phone.grades,
        gradesReadComplete = if (serverGrades) true else phone.gradesReadComplete,
        gradeParser = if (serverGrades) server.gradeParser else phone.gradeParser,
        events = lessons + appointments,
        exams = server.exams.ifEmpty { phone.exams },
        homework = server.homework.ifEmpty { phone.homework },
        messages = server.messages.ifEmpty { phone.messages },
        vacations = server.vacations.ifEmpty { phone.vacations },
        konto = server.konto.ifEmpty { phone.konto },
        startMessages = server.startMessages.ifEmpty { phone.startMessages },
        weekFetched = newestStamps(phone.weekFetched, server.weekFetched),
        weekRead = newestStamps(phone.weekRead, server.weekRead),
        examWeekFetched = newestStamps(phone.examWeekFetched, server.examWeekFetched),
        weekSpanStart = server.weekSpanStart.ifBlank { phone.weekSpanStart },
        weekSpanEnd = server.weekSpanEnd.ifBlank { phone.weekSpanEnd },
        icalFetchedAt = later(server.icalFetchedAt, phone.icalFetchedAt),
    )
}

private fun instantOf(stamp: String?): Instant? = stamp?.takeIf { it.isNotBlank() }?.let { runCatching { Instant.parse(it) }.getOrNull() }

/** True when [server] is a read at least as recent as [phone]. A server week without a read stamp is not. */
private fun notOlder(server: String?, phone: String?): Boolean {
    val serverAt = instantOf(server) ?: return false
    val phoneAt = instantOf(phone) ?: return true
    return !serverAt.isBefore(phoneAt)
}

private fun later(left: String, right: String): String {
    val a = instantOf(left) ?: return right.ifBlank { left }
    val b = instantOf(right) ?: return left
    return if (b.isAfter(a)) right else left
}

private fun newestStamps(phone: Map<String, String>, server: Map<String, String>): Map<String, String> {
    val out = phone.toMutableMap()
    for ((week, stamp) in server) {
        val mine = out[week]
        if (mine == null || notOlder(stamp, mine)) out[week] = stamp
    }
    return out
}
