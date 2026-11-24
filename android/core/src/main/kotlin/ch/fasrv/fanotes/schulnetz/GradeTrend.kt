package ch.fasrv.fanotes.schulnetz

/**
 * Pure numbers behind the grade trend chart and the grades overview highlights
 * (mirrors kanti-web lib/charts.ts trendPoints/trendDomain and the Grades stats).
 */
data class TrendPoint(
    val label: String,
    /** ISO date (yyyy-MM-dd) or empty when the mark has no usable date. */
    val date: String,
    val mark: Double,
    val weight: Double,
    /** Weighted average of this and every earlier counted mark. */
    val running: Double,
)

/**
 * The marks a course chart may show, oldest first. Marks that do not count
 * (unrevealed guess-the-grade marks, excluded marks) never appear, so the chart
 * cannot reveal what the list keeps covered. Ties on the same date keep the
 * reverse list order, like the web (lists are newest first).
 */
fun trendPoints(marks: List<WeightedMark>): List<TrendPoint> {
    val shown = marks.withIndex()
        .filter { (_, m) -> m.counted && m.mark.isFinite() }
        .sortedWith(
            compareBy<IndexedValue<WeightedMark>> { parseGradeDate(it.value.date).orEmpty() }
                .thenByDescending { it.index },
        )
    var weight = 0.0
    var sum = 0.0
    var running: Double? = null
    return shown.map { (_, m) ->
        if (m.weight > 0.0) {
            weight += m.weight
            sum += m.mark * m.weight
            running = sum / weight
        }
        TrendPoint(m.label, parseGradeDate(m.date).orEmpty(), m.mark, m.weight, running ?: m.mark)
    }
}

/** Visible mark range of the chart: always contains 3..5, within 1..6, whole numbers. */
fun trendDomain(points: List<TrendPoint>): Pair<Int, Int> {
    val values = points.flatMap { listOf(it.mark, it.running) }
    val lowest = values.minOrNull() ?: 4.0
    val highest = values.maxOrNull() ?: 4.0
    val low = minOf(3, kotlin.math.floor(lowest).toInt()).coerceIn(1, 3)
    val high = maxOf(5, kotlin.math.ceil(highest).toInt()).coerceIn(5, 6)
    return low to high
}

/** Subjects below 4 and the best subject among courses that have an average. */
data class GradeHighlights(
    val belowFour: Int,
    val averaged: Int,
    val best: CourseSummary?,
)

fun gradeHighlights(courses: List<CourseSummary>): GradeHighlights {
    val averaged = courses.filter { it.average != null }
    val below = averaged.count { (it.average ?: 4.0) < 4.0 }
    var best: CourseSummary? = null
    for (course in averaged) {
        if (best == null || (course.average ?: 0.0) > (best.average ?: 0.0)) best = course
    }
    return GradeHighlights(below, averaged.size, best)
}
