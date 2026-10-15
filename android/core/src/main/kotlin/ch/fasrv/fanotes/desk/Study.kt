package ch.fasrv.fanotes.desk

data class StudySubject(val subject: String, val notes: Int, val dwellMs: Long, val typingMs: Long, val inkMs: Long, val inkMm: Double)

data class StudyPicture(
    val notes: Int,
    val dwellMs: Long,
    val typingMs: Long,
    val inkMs: Long,
    val inkMm: Double,
    val dwellByWeekday: List<Long>,
    val subjects: List<StudySubject>,
)

/** Local study picture from quiet per-note statistics. Nothing is uploaded. */
fun aggregateStudy(notes: List<Pair<String, PageStats>>): StudyPicture {
    val week = MutableList(7) { 0L }
    val subjects = linkedMapOf<String, StudySubject>()
    var dwell = 0L
    var typing = 0L
    var ink = 0L
    var length = 0.0
    for ((path, stats) in notes) {
        val noteDwell = stats.dwellMs.coerceAtLeast(0)
        val noteTyping = stats.typingMs.coerceAtLeast(0)
        val noteInk = if (stats.inkMs > 0) stats.inkMs else stats.inkPenDownMs.coerceAtLeast(0)
        val noteLength = stats.inkLengthMm.coerceAtLeast(0.0)
        dwell += noteDwell
        typing += noteTyping
        ink += noteInk
        length += noteLength
        stats.dwellByWeekday.forEachIndexed { day, value -> if (day < 7) week[day] += value.coerceAtLeast(0) }
        val name = subjectOf(path)
        val row = subjects[name]
        subjects[name] = StudySubject(
            name,
            (row?.notes ?: 0) + 1,
            (row?.dwellMs ?: 0) + noteDwell,
            (row?.typingMs ?: 0) + noteTyping,
            (row?.inkMs ?: 0) + noteInk,
            (row?.inkMm ?: 0.0) + noteLength,
        )
    }
    return StudyPicture(
        notes = notes.size,
        dwellMs = dwell,
        typingMs = typing,
        inkMs = ink,
        inkMm = length,
        dwellByWeekday = week,
        subjects = subjects.values.sortedWith(compareByDescending<StudySubject> { it.dwellMs }.thenBy { it.subject }),
    )
}

/** Fach row: page count, time on the page, typing, and pen time. */
fun studySubjectSummary(row: StudySubject): String {
    val pages = if (row.notes == 1) "1 Seite" else "${row.notes} Seiten"
    return "${row.subject} · $pages · ${formatStudyDuration(row.dwellMs)} · ${formatStudyDuration(row.typingMs)} Tippen · ${formatStudyDuration(row.inkMs)} Stift"
}

fun formatStudyDuration(ms: Long): String {
    val minutes = kotlin.math.round(ms.coerceAtLeast(0) / 60_000.0).toInt()
    if (minutes < 60) return "$minutes min"
    val hours = minutes / 60
    val rest = minutes % 60
    return if (rest == 0) "$hours h" else "$hours h $rest min"
}

private fun subjectOf(path: String): String {
    val slash = path.indexOf('/')
    return if (slash > 0) path.substring(0, slash) else "Eingang"
}
