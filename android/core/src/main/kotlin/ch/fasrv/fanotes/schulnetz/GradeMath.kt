package ch.fasrv.fanotes.schulnetz

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.ceil

/**
 * Swiss upper-secondary marks are 1 to 6. 4 is the pass line.
 * Pluspunkte are the weighted distance from that line: Σ (Note − 4) × Gewicht.
 * A Wunschnote is the mark still needed on a future exam to land on a target average.
 */
data class WeightedMark(val mark: Double, val weight: Double, val label: String = "")

data class HypotheticalGrade(
    val id: String,
    val courseId: String,
    val title: String,
    val mark: Double,
    val weight: Double,
)

data class CourseSummary(
    val courseId: String,
    val label: String,
    val average: Double?,
    val pluspunkte: Double,
    val weight: Double,
    val marks: List<WeightedMark>,
)

data class WishResult(
    val needed: Double?,
    val neededHalf: Double?,
    val achievable: Boolean,
    val alreadyMet: Boolean,
    val reason: String,
)

private const val PASS_MARK = 4.0
private const val MIN_MARK = 1.0
private const val MAX_MARK = 6.0

fun weightedAverage(marks: List<WeightedMark>): Double? {
    val usable = marks.filter { it.weight > 0.0 && it.mark.isFinite() }
    val weight = usable.sumOf { it.weight }
    if (weight <= 0.0) return null
    return usable.sumOf { it.mark * it.weight } / weight
}

fun pluspunkte(marks: List<WeightedMark>): Double =
    marks.filter { it.weight > 0.0 && it.mark.isFinite() }.sumOf { (it.mark - PASS_MARK) * it.weight }

fun courseSummaries(grades: List<SchoolGrade>, hypothetical: List<HypotheticalGrade> = emptyList()): List<CourseSummary> {
    val groups = linkedMapOf<String, MutableList<WeightedMark>>()
    val labels = linkedMapOf<String, String>()
    for (grade in grades) {
        val mark = grade.mark ?: continue
        val key = grade.courseKey
        if (key.isBlank()) continue
        labels.putIfAbsent(key, grade.courseLabel)
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(mark, grade.weight, grade.title)
    }
    for (extra in hypothetical) {
        if (!extra.mark.isFinite() || extra.weight <= 0.0) continue
        val key = extra.courseId
        if (key.isBlank()) continue
        labels.putIfAbsent(key, key)
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(extra.mark, extra.weight, extra.title.ifBlank { "Hypothetisch" })
    }
    return groups.map { (key, marks) ->
        CourseSummary(
            courseId = key,
            label = labels[key] ?: key,
            average = weightedAverage(marks),
            pluspunkte = pluspunkte(marks),
            weight = marks.sumOf { it.weight },
            marks = marks,
        )
    }.sortedBy { it.label.lowercase() }
}

fun overallPluspunkte(courses: List<CourseSummary>): Double = courses.sumOf { it.pluspunkte }

fun overallAverage(courses: List<CourseSummary>): Double? {
    val marks = courses.flatMap { it.marks }
    return weightedAverage(marks)
}

/**
 * Mark required on the next exam so the weighted average becomes [target].
 * Weights of existing marks stay as they are. A result above 6 cannot be reached.
 * A result of 1 or below is already secured by any legal mark.
 */
fun wunschnote(current: List<WeightedMark>, target: Double, nextWeight: Double): WishResult {
    if (!target.isFinite() || target < MIN_MARK || target > MAX_MARK) {
        return WishResult(null, null, achievable = false, alreadyMet = false, reason = "Die Zielnote liegt ausserhalb von 1 bis 6.")
    }
    if (!nextWeight.isFinite() || nextWeight <= 0.0) {
        return WishResult(null, null, achievable = false, alreadyMet = false, reason = "Das Gewicht der nächsten Prüfung muss grösser als 0 sein.")
    }
    val usable = current.filter { it.weight > 0.0 && it.mark.isFinite() }
    val weight = usable.sumOf { it.weight }
    val sum = usable.sumOf { it.mark * it.weight }
    val needed = (target * (weight + nextWeight) - sum) / nextWeight
    if (!needed.isFinite()) {
        return WishResult(null, null, achievable = false, alreadyMet = false, reason = "Die Wunschnote lässt sich daraus nicht rechnen.")
    }
    if (needed > MAX_MARK) {
        return WishResult(needed, null, achievable = false, alreadyMet = false, reason = "Auch eine 6 reicht für diesen Schnitt nicht.")
    }
    if (needed <= MIN_MARK) {
        return WishResult(MIN_MARK, MIN_MARK, achievable = true, alreadyMet = true, reason = "Der Schnitt ist schon gesichert. Eine 1 genügt.")
    }
    val half = ceil(needed * 2.0 - 1e-9) / 2.0
    return WishResult(needed, half.coerceIn(MIN_MARK, MAX_MARK), achievable = true, alreadyMet = false, reason = "")
}

fun formatMark(value: Double?): String {
    if (value == null || !value.isFinite()) return "–"
    return BigDecimal.valueOf(value).setScale(2, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString().replace('.', ',')
}

fun formatPluspunkte(value: Double): String {
    val text = formatMark(kotlin.math.abs(value))
    return when {
        value > 0.0005 -> "+$text"
        value < -0.0005 -> "−$text"
        else -> "0"
    }
}
