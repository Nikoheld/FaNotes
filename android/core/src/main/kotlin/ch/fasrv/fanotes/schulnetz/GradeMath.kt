package ch.fasrv.fanotes.schulnetz

import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.ceil

/**
 * Swiss upper-secondary marks are 1 to 6. 4 is the pass line.
 * Pluspunkte follow the Aargau gymnasium promotion: round the course average
 * to a half mark, then Note − 4, or twice that below 4. Sport does not count.
 * A Wunschnote is the mark still needed on a future exam to land on a target average.
 */
data class WeightedMark(
    val mark: Double,
    val weight: Double,
    val label: String = "",
    val own: Boolean = false,
    val targetId: String = "",
    /** False for a hidden guess-the-grade mark or a mark the student excluded. */
    val counted: Boolean = true,
    /** School value, kept when [mark] is the student's override. */
    val displayMark: Double = mark,
    val displayWeight: Double = weight,
    val adjusted: Boolean = false,
    val excluded: Boolean = false,
    val collective: Boolean = false,
    val sourceId: String = "",
    val date: String = "",
)

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
    val zeugnis: Double?,
    val pluspunkte: Double,
    val promotion: Boolean,
    val weight: Double,
    val marks: List<WeightedMark>,
    val archived: Boolean = false,
)

data class WishResult(
    val needed: Double?,
    val neededHalf: Double?,
    val achievable: Boolean,
    val alreadyMet: Boolean,
    val reason: String,
    val pluspunkteBefore: Double? = null,
    val pluspunkteAfter: Double? = null,
)

data class PromotionTotals(val plus: Double, val minus: Double, val total: Double)

private const val PASS_MARK = 4.0
private const val MIN_MARK = 1.0
private const val MAX_MARK = 6.0

fun weightedAverage(marks: List<WeightedMark>): Double? {
    val usable = marks.filter { it.weight > 0.0 && it.mark.isFinite() }
    val weight = usable.sumOf { it.weight }
    if (weight <= 0.0) return null
    return usable.sumOf { it.mark * it.weight } / weight
}

/**
 * Kanton Aargau, gymnasiale Promotion: Zeugnisnote auf 0.5 (HALF_UP).
 * 4.74 → 4.5, 4.75 → 5.0. Note ≥ 4: Pluspunkte = Note − 4. Note < 4: Minus doppelt.
 */
fun roundToHalf(value: Double): Double {
    if (!value.isFinite()) return value
    return BigDecimal.valueOf(value)
        .multiply(BigDecimal.valueOf(2.0))
        .setScale(0, RoundingMode.HALF_UP)
        .divide(BigDecimal.valueOf(2.0))
        .toDouble()
}

fun isSportCourse(name: String): Boolean {
    val blob = name.trim().lowercase()
    if (blob.contains("turnen")) return true
    return blob.split(Regex("""[\s_/()+\-]+""")).any { it == "sport" || it.startsWith("sport") }
}

fun promotionPoints(zeugnis: Double?): Double? {
    if (zeugnis == null || !zeugnis.isFinite()) return null
    return if (zeugnis + 1e-9 >= PASS_MARK) zeugnis - PASS_MARK else -2.0 * (PASS_MARK - zeugnis)
}

fun coursePromotion(label: String, average: Double?): Pair<Double?, Double> {
    if (average == null || !average.isFinite() || isSportCourse(label)) return null to 0.0
    val zeugnis = roundToHalf(average)
    return zeugnis to (promotionPoints(zeugnis) ?: 0.0)
}

fun countingMarks(marks: List<WeightedMark>): List<WeightedMark> =
    marks.filter { it.counted && it.weight > 0.0 && it.mark.isFinite() }

/** Weighted average of the partial tests. Parts themselves are not separate subject marks. */
fun collectiveValue(parts: List<CollectivePart>): Double? {
    if (parts.size < 2) return null
    return weightedAverage(parts.map { WeightedMark(it.mark, it.weight, it.title, own = true) })
}

fun activeCourses(courses: List<CourseSummary>): List<CourseSummary> = courses.filterNot { it.archived }

fun courseSummaries(
    grades: List<SchoolGrade>,
    hypothetical: List<HypotheticalGrade> = emptyList(),
    hiddenTargetIds: Set<String> = emptySet(),
    book: GradeBook = GradeBook(),
): List<CourseSummary> {
    val stored = book.normalized()
    val adjustments = stored.adjustments.associateBy { it.targetId }
    val archived = stored.archivedCourseIds.toSet()
    val groups = linkedMapOf<String, MutableList<WeightedMark>>()
    val labels = linkedMapOf<String, String>()
    for (grade in grades) {
        if (grade.isSummaryGrade()) continue
        val mark = grade.mark ?: continue
        val key = grade.courseKey
        if (key.isBlank()) continue
        labels.putIfAbsent(key, grade.displayCourseLabel())
        val target = gradeTargetId(grade)
        val adjustment = adjustments[target]
        val hidden = target.isNotBlank() && target in hiddenTargetIds
        val excluded = adjustment?.excluded == true
        val overrideMark = adjustment?.mark
        val overrideWeight = adjustment?.weight
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(
            mark = overrideMark ?: mark,
            weight = overrideWeight ?: grade.weight,
            label = grade.title,
            targetId = target,
            counted = !hidden && !excluded,
            displayMark = mark,
            displayWeight = grade.weight,
            adjusted = !excluded && (overrideMark != null || overrideWeight != null),
            excluded = excluded,
            date = grade.date,
        )
    }
    for (extra in hypothetical) {
        if (!extra.mark.isFinite() || extra.weight <= 0.0) continue
        val key = extra.courseId
        if (key.isBlank()) continue
        labels.putIfAbsent(key, key)
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(extra.mark, extra.weight, extra.title.ifBlank { "Eigene Note" }, own = true, sourceId = extra.id)
    }
    for (extra in stored.own) {
        val key = extra.courseId
        labels.putIfAbsent(key, key)
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(
            extra.mark,
            extra.weight,
            extra.title.ifBlank { "Own mark" },
            own = true,
            sourceId = extra.id,
            date = extra.date,
        )
    }
    for (extra in stored.collective) {
        val value = collectiveValue(extra.parts) ?: continue
        val key = extra.courseId
        labels.putIfAbsent(key, key)
        groups.getOrPut(key) { mutableListOf() } += WeightedMark(
            mark = value,
            weight = extra.weight,
            label = extra.title.ifBlank { "Collective grade" },
            own = true,
            collective = true,
            sourceId = extra.id,
            date = extra.date,
        )
    }
    return groups.map { (key, marks) ->
        val label = labels[key] ?: key
        val counted = countingMarks(marks).filter { it.own || it.targetId.isBlank() || it.targetId !in hiddenTargetIds }
        val average = weightedAverage(counted)
        val sport = isSportCourse(label)
        val zeugnis = average?.let(::roundToHalf)
        val counts = zeugnis != null && !sport
        CourseSummary(
            courseId = key,
            label = label,
            average = average,
            zeugnis = zeugnis,
            pluspunkte = if (counts) promotionPoints(zeugnis) ?: 0.0 else 0.0,
            promotion = counts,
            weight = counted.sumOf { it.weight },
            marks = marks,
            archived = key in archived,
        )
    }.sortedBy { it.label.lowercase() }
}

fun overallPluspunkte(courses: List<CourseSummary>): Double = courses.filter { it.promotion }.sumOf { it.pluspunkte }

fun promotionTotals(courses: List<CourseSummary>): PromotionTotals {
    val counted = courses.filter { it.promotion }
    val plus = counted.sumOf { it.pluspunkte.coerceAtLeast(0.0) }
    val minus = counted.sumOf { it.pluspunkte.coerceAtMost(0.0) }
    return PromotionTotals(plus, minus, plus + minus)
}

fun overallAverage(courses: List<CourseSummary>): Double? =
    weightedAverage(courses.flatMap { countingMarks(it.marks) })

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
    val before = promotionPoints(weightedAverage(usable)?.let(::roundToHalf))
    fun withMark(mark: Double): Double? {
        val next = usable + WeightedMark(mark, nextWeight, "Wunschnote")
        return promotionPoints(weightedAverage(next)?.let(::roundToHalf))
    }
    if (needed > MAX_MARK) {
        return WishResult(needed, null, achievable = false, alreadyMet = false, reason = "Auch eine 6 reicht für diesen Schnitt nicht.", pluspunkteBefore = before, pluspunkteAfter = withMark(MAX_MARK))
    }
    if (needed <= MIN_MARK) {
        return WishResult(MIN_MARK, MIN_MARK, achievable = true, alreadyMet = true, reason = "Der Schnitt ist schon gesichert. Eine 1 genügt.", pluspunkteBefore = before, pluspunkteAfter = withMark(MIN_MARK))
    }
    val half = ceil(needed * 2.0 - 1e-9) / 2.0
    val shown = half.coerceIn(MIN_MARK, MAX_MARK)
    return WishResult(needed, shown, achievable = true, alreadyMet = false, reason = "", pluspunkteBefore = before, pluspunkteAfter = withMark(shown))
}

fun formatMark(value: Double?, decimals: Int = 2): String {
    if (value == null || !value.isFinite()) return "–"
    val places = decimals.coerceIn(0, 3)
    return BigDecimal.valueOf(value).setScale(places, RoundingMode.HALF_UP).stripTrailingZeros().toPlainString().replace('.', ',')
}

fun formatPluspunkte(value: Double): String {
    val text = formatMark(kotlin.math.abs(value))
    return when {
        value > 0.0005 -> "+$text"
        value < -0.0005 -> "−$text"
        else -> "0"
    }
}
