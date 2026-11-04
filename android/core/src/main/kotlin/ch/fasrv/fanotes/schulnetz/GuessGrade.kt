package ch.fasrv.fanotes.schulnetz

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.LocalDate
import java.time.Period

/**
 * Optional "guess the grade" mode. New marks stay hidden until the student
 * reveals them. Averages and Pluspunkte ignore unrevealed marks so the
 * previous course values stay on screen and do not leak the new mark.
 *
 * Celebrity age = mark × 10, rounded to a whole year with HALF_UP
 * (4.25 → 42.5 → 43). Age of a person is years completed on [today]
 * from the bundled birth date ([ageOn]).
 */
enum class GuessComparison {
    /** Guess matches the mark after rounding both to the mark's own precision. */
    CORRECT,
    /** The real Swiss mark is higher (better) than the guess. */
    ACTUAL_HIGHER,
    /** The real Swiss mark is lower (worse) than the guess. */
    ACTUAL_LOWER,
}

data class Celebrity(
    val name: String,
    val born: LocalDate,
    val line: String,
)

fun markDecimals(mark: Double): Int {
    if (!mark.isFinite()) return 0
    return BigDecimal.valueOf(mark)
        .setScale(3, RoundingMode.HALF_UP)
        .stripTrailingZeros()
        .scale()
        .coerceAtLeast(0)
}

fun roundMark(value: Double, decimals: Int): Double {
    if (!value.isFinite()) return value
    return BigDecimal.valueOf(value).setScale(decimals.coerceIn(0, 3), RoundingMode.HALF_UP).toDouble()
}

fun parseGuessMark(raw: String): Double? {
    val text = raw.trim().replace(',', '.')
    if (text.isEmpty()) return null
    val value = text.toDoubleOrNull() ?: return null
    if (!value.isFinite() || value < 1.0 || value > 6.0) return null
    return value
}

fun compareGuess(guess: Double, actual: Double): GuessComparison {
    if (!guess.isFinite() || !actual.isFinite()) return GuessComparison.ACTUAL_LOWER
    val scale = markDecimals(actual)
    val roundedGuess = BigDecimal.valueOf(guess).setScale(scale, RoundingMode.HALF_UP)
    val roundedActual = BigDecimal.valueOf(actual).setScale(scale, RoundingMode.HALF_UP)
    val sign = roundedActual.compareTo(roundedGuess)
    return when {
        sign == 0 -> GuessComparison.CORRECT
        sign > 0 -> GuessComparison.ACTUAL_HIGHER
        else -> GuessComparison.ACTUAL_LOWER
    }
}

/** Mark × 10 as a whole year. 4.3 → 43, 4.25 → 43 (HALF_UP). */
fun celebrityAge(mark: Double): Int {
    if (!mark.isFinite()) return 0
    return BigDecimal.valueOf(mark)
        .multiply(BigDecimal.TEN)
        .setScale(0, RoundingMode.HALF_UP)
        .toInt()
}

fun ageOn(born: LocalDate, today: LocalDate): Int {
    if (today.isBefore(born)) return 0
    return Period.between(born, today).years
}

fun celebritiesAtAge(age: Int, today: LocalDate, catalog: List<Celebrity> = CELEBRITIES): List<Celebrity> =
    catalog.filter { ageOn(it.born, today) == age }

fun pickCelebrity(age: Int, seed: String, today: LocalDate, catalog: List<Celebrity> = CELEBRITIES): Celebrity? {
    val matches = celebritiesAtAge(age, today, catalog)
    if (matches.isEmpty()) return null
    var hash = 0
    for (char in seed) hash = hash * 31 + char.code
    return matches[Math.floorMod(hash, matches.size)]
}

fun hiddenGradeTitle(change: SchulnetzChange, course: String): String {
    val subject = course.ifBlank { "einem Fach" }
    val kind = if (change.title.contains("änderung", ignoreCase = true) || change.title.contains("aenderung", ignoreCase = true)) {
        "Notenänderung"
    } else {
        "Neue Note"
    }
    return "$kind in $subject – tippen zum Aufdecken"
}

fun hiddenGradeBody(examTitle: String): String = examTitle.ifBlank { "Tippen zum Aufdecken" }

fun publicGradeChangeId(id: String): String {
    if (!id.startsWith("grade:")) return id
    val entity = id.split(':').getOrNull(1)?.takeIf { it.isNotBlank() } ?: return "grade:hidden"
    return "grade:$entity:hidden"
}

fun redactGradeChange(change: SchulnetzChange, snapshot: SchulnetzSnapshot): SchulnetzChange {
    if (change.category != "grade") return change
    if (change.title.contains("Aufdecken")) return change.copy(id = publicGradeChangeId(change.id))
    val ids = change.linkIds()
    val grade = snapshot.grades.firstOrNull { gradeTargetId(it) in ids || it.id in ids }
    val course = grade?.courseLabel?.ifBlank { change.courseId }.orEmpty().ifBlank {
        change.body.substringBefore(" · ").ifBlank { "einem Fach" }
    }
    val exam = grade?.title?.ifBlank { "Note" } ?: change.body.split(" · ").getOrNull(1)?.trim().orEmpty()
    return change.copy(
        id = publicGradeChangeId(change.id),
        title = hiddenGradeTitle(change, course),
        body = hiddenGradeBody(exam),
    )
}

fun prepareGradeNotifications(
    changes: List<SchulnetzChange>,
    guessGrades: Boolean,
    snapshot: SchulnetzSnapshot,
): List<SchulnetzChange> {
    if (!guessGrades) return groupGradeChanges(changes)
    return changes.map { redactGradeChange(it, snapshot) }
}

fun newGradeTargetIds(changes: List<SchulnetzChange>): List<String> =
    changes.filter { it.category == "grade" }.flatMap { it.linkIds() }.filter { it.isNotBlank() }.distinct()

fun gradesForAverages(grades: List<SchoolGrade>, hiddenTargetIds: Set<String>, guessGrades: Boolean): List<SchoolGrade> {
    if (!guessGrades || hiddenTargetIds.isEmpty()) return grades
    return grades.filter { gradeTargetId(it) !in hiddenTargetIds }
}

fun highestVisibleMark(grades: List<SchoolGrade>, hiddenTargetIds: Set<String>, guessGrades: Boolean): Double? =
    gradesForAverages(grades, hiddenTargetIds, guessGrades).mapNotNull { it.mark }.maxOrNull()
