package ch.fasrv.fanotes.schulnetz

import java.math.BigDecimal
import java.math.RoundingMode
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import java.time.Period

/**
 * Optional "guess the grade" mode. New marks stay hidden until the student
 * reveals them. Averages and Pluspunkte ignore unrevealed marks so the
 * previous course values stay on screen and do not leak the new mark.
 *
 * Celebrity age = mark × 10, rounded to a whole year with HALF_UP
 * (4.25 → 42.5 → 43). Age of a person is years completed on [today]
 * from the bundled birth date ([ageOn]). The guessing step shows only a
 * licensed portrait. The age and the mark stay hidden until an age is submitted.
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
    /** Wikimedia Commons file name. Empty when no free portrait is known. */
    val photoFile: String = "",
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
    return matches[stablePick(seed, matches.size)]
}

private val PORTRAIT_FILE = Regex("""^[^/\\?#]{1,180}\.(?:jpg|jpeg|png|webp)$""", RegexOption.IGNORE_CASE)

/** Commons FilePath for a stored portrait. Rejects anything that is not a bare file name. */
fun portraitUrl(file: String): String? {
    val trimmed = file.trim()
    if (trimmed.isEmpty() || trimmed.contains("..") || !PORTRAIT_FILE.matches(trimmed)) return null
    val encoded = URLEncoder.encode(trimmed, StandardCharsets.UTF_8).replace("+", "%20")
    return "https://commons.wikimedia.org/wiki/Special:FilePath/$encoded?width=640"
}

/** Same stable pick as [pickCelebrity], but only people with a usable portrait. */
fun pickCelebrityPhoto(age: Int, seed: String, today: LocalDate, catalog: List<Celebrity> = CELEBRITIES): Celebrity? {
    val matches = celebritiesAtAge(age, today, catalog).filter { portraitUrl(it.photoFile) != null }
    if (matches.isEmpty()) return null
    return matches[stablePick(seed, matches.size)]
}

/** What the age step may show before a guess: the portrait, and nothing about the mark. */
data class CelebrityAgePrompt(val imageUrl: String?)

fun celebrityAgePrompt(mark: Double, seed: String, today: LocalDate, catalog: List<Celebrity> = CELEBRITIES): CelebrityAgePrompt {
    if (!mark.isFinite()) return CelebrityAgePrompt(null)
    val person = pickCelebrityPhoto(celebrityAge(mark), seed, today, catalog) ?: return CelebrityAgePrompt(null)
    return CelebrityAgePrompt(portraitUrl(person.photoFile))
}

/**
 * Portrait for one hidden mark. Several marks, guess mode off, or no free
 * photo of that age return null. The notice text must not include this URL.
 */
fun hiddenGradePortraitUrl(
    guessGrades: Boolean,
    change: SchulnetzChange,
    mark: Double?,
    today: LocalDate,
    catalog: List<Celebrity> = CELEBRITIES,
): String? {
    if (!guessGrades || change.category != "grade") return null
    val ids = change.linkIds()
    if (ids.size != 1) return null
    val value = mark ?: return null
    return celebrityAgePrompt(value, ids.single(), today, catalog).imageUrl
}

/** Age and the ×10 link. Null until the count-up has settled after an age guess. */
data class AgeConnection(val age: Int, val guess: Int?)

fun ageConnection(mark: Double, settled: Boolean, fromAge: Boolean, ageGuess: Int): AgeConnection? {
    if (!settled || !fromAge || !mark.isFinite()) return null
    val age = celebrityAge(mark)
    if (age <= 0) return null
    return AgeConnection(age, ageGuess.takeIf { it in 1..120 })
}

fun parseAgeGuess(raw: String): Int? {
    val text = raw.trim()
    if (!Regex("""\d{1,3}""").matches(text)) return null
    val value = text.toIntOrNull() ?: return null
    if (value !in 1..120) return null
    return value
}

private fun stablePick(seed: String, size: Int): Int {
    var hash = 0
    for (char in seed) hash = hash * 31 + char.code
    return Math.floorMod(hash, size)
}

fun hiddenMarkHint(longPress: Boolean): String =
    if (longPress) "Hidden · hold to reveal" else "Hidden · tap to reveal"

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

/** One frame of the reveal count-up. [delayBeforeMs] is how long to wait after the previous frame. */
data class GradeRevealStep(val value: Double, val delayBeforeMs: Long)

private const val GRADE_REVEAL_MIN_MS = 2_000L
private const val GRADE_REVEAL_MAX_MS = 3_500L
private const val GRADE_REVEAL_SPAN = 5.0

/**
 * Count from 1.0 up to [mark] in steps of 0.1, then land on [mark] itself
 * (so 4.75 is not rounded to 4.8). Delays grow so the count eases out.
 * The waits add up to about 2s for a mark just above 1, and 3.5s for a 6.
 * A mark at or below 1.0 is a single frame with no wait.
 */
fun gradeRevealSteps(mark: Double): List<GradeRevealStep> {
    if (!mark.isFinite() || mark <= 1.0) return listOf(GradeRevealStep(if (mark.isFinite()) mark else 1.0, 0))
    val targetUnits = BigDecimal.valueOf(mark).setScale(3, RoundingMode.HALF_UP).movePointRight(3).intValueExact()
    val values = ArrayList<Double>()
    var units = 1_000
    values += 1.0
    while (units + 100 <= targetUnits) {
        units += 100
        values += units / 1_000.0
    }
    if (units != targetUnits) values += mark
    val gaps = values.size - 1
    if (gaps <= 0) return listOf(GradeRevealStep(values.first(), 0))
    val distance = (mark - 1.0).coerceAtMost(GRADE_REVEAL_SPAN)
    val total = GRADE_REVEAL_MIN_MS + Math.round((GRADE_REVEAL_MAX_MS - GRADE_REVEAL_MIN_MS) * (distance / GRADE_REVEAL_SPAN))
    val weightSum = gaps.toLong() * (gaps + 1) / 2
    val waits = LongArray(gaps) { index -> total * (index + 1) / weightSum }
    var leftover = total - waits.sum()
    var cursor = gaps - 1
    while (leftover > 0) {
        waits[cursor] += 1
        leftover -= 1
        cursor = if (cursor == 0) gaps - 1 else cursor - 1
    }
    return values.mapIndexed { index, value -> GradeRevealStep(value, if (index == 0) 0 else waits[index - 1]) }
}
