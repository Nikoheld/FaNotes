package ch.fasrv.fanotes.study

import ch.fasrv.fanotes.json.jsNumber
import java.math.BigDecimal
import java.math.RoundingMode
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Measure maths and list helpers, ported 1:1 from `noteAnnotation.mjs`. */
const val A4_WIDTH_CM = 21.0
const val A4_RATIO = 1.414

data class PageSizeCm(val width: Double, val height: Double)

/** Interior angle at [vertex] between the rays to [a] and [b], in degrees (0-180). */
fun angleAt(vertex: SPoint, a: SPoint, b: SPoint): Double {
    val ux = a.x - vertex.x
    val uy = a.y - vertex.y
    val vx = b.x - vertex.x
    val vy = b.y - vertex.y
    val lu = hypot(ux, uy)
    val lv = hypot(vx, vy)
    if (lu < 1e-9 || lv < 1e-9) return 0.0
    val cos = min(1.0, max(-1.0, (ux * vx + uy * vy) / (lu * lv)))
    return acos(cos) * 180.0 / PI
}

/** Angle between two infinite lines (a1-a2) and (b1-b2), 0-90 degrees. */
fun angleBetweenLines(a1: SPoint, a2: SPoint, b1: SPoint, b2: SPoint): Double {
    val da = atan2(a2.y - a1.y, a2.x - a1.x)
    val db = atan2(b2.y - b1.y, b2.x - b1.x)
    var diff = abs((da - db) * 180.0 / PI) % 180.0
    if (diff > 90.0) diff = 180.0 - diff
    return diff
}

fun distanceOf(a: SPoint, b: SPoint, size: PageSizeCm): Double = hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height)

/** Page fractions are not isotropic, so points are scaled to centimetres before measuring. */
fun measureValue(item: StudyMeasure, size: PageSizeCm): Double {
    val real = item.pts.map { SPoint(it.x * size.width, it.y * size.height) }
    if (item.mode == MEASURE_DISTANCE) return hypot(real[0].x - real[1].x, real[0].y - real[1].y)
    if (real.size >= 4) return angleBetweenLines(real[0], real[1], real[2], real[3])
    return angleAt(real[1], real[0], real[2])
}

/** `35°` / `35,5°` / `10,5 cm`, the desktop text including the decimal comma. */
fun formatMeasure(item: StudyMeasure, value: Double): String =
    if (item.mode == MEASURE_DISTANCE) {
        BigDecimal(value).setScale(1, RoundingMode.HALF_UP).toPlainString().replace('.', ',') + " cm"
    } else {
        jsNumber(Math.floor(value * 10.0 + 0.5) / 10.0).replace('.', ',') + "°"
    }

fun nextCalloutNumber(list: List<StudyAnnotation>): Int =
    (list.filterIsInstance<StudyCallout>().maxOfOrNull { it.num ?: 0 } ?: 0) + 1

/** Renumber callouts 1..n in reading order (page, then top to bottom, left to right). */
fun renumberCallouts(list: List<StudyAnnotation>): List<StudyAnnotation> {
    val order = list.filterIsInstance<StudyCallout>().filter { it.num != null }
        .sortedWith(compareBy<StudyCallout>({ it.page }, { it.ly }, { it.lx }))
    val map = order.withIndex().associate { (index, item) -> item.id to index + 1 }
    return list.map { if (it is StudyCallout && map.containsKey(it.id)) it.copy(num = map[it.id]) else it }
}

data class LegendRow(val key: String, val glyph: String, val color: String, val label: String, val stamp: Boolean)

/** Legend rows: used stamps with their (possibly renamed) meaning, then numbered labels. */
fun legendRows(list: List<StudyAnnotation>, names: Map<String, String> = emptyMap()): List<LegendRow> {
    val rows = ArrayList<LegendRow>()
    val seen = HashSet<String>()
    for (item in list) {
        if (item !is StudyStamp || !seen.add(item.stamp)) continue
        val def = stampById(item.stamp) ?: continue
        rows += LegendRow(item.stamp, def.glyph, def.color, names[item.stamp]?.takeIf { it.isNotEmpty() } ?: def.label, true)
    }
    for (item in list.filterIsInstance<StudyCallout>().filter { it.num != null }.sortedBy { it.num }) {
        rows += LegendRow(item.id, item.num.toString(), item.color, item.text, false)
    }
    return rows
}

/** Split pasted text into word-bank terms. */
fun termsFromText(raw: String): List<String> {
    val out = ArrayList<String>()
    for (part in raw.split(Regex("[\\n\\r;,•·]+"))) {
        val term = part.replace(Regex("\\s+"), " ").trim().replace(Regex("^[-–—:.\\d)]+\\s*"), "").take(60)
        if (term.length >= 2 && term !in out) out += term
    }
    return out.take(ANNOTATION_TERMS_MAX)
}

fun pageSizeCm(widthPx: Double, heightPx: Double): PageSizeCm {
    val ratio = if (widthPx > 0.0) heightPx / widthPx else A4_RATIO
    return PageSizeCm(A4_WIDTH_CM, A4_WIDTH_CM * ratio)
}

// ---- undo / redo ----------------------------------------------------------------------------

/**
 * Snapshot history for annotation edits. Android keeps it apart from the ink undo (strokes are
 * undone by `InkSession`); the Lernen menu drives this stack, like the desktop panel does.
 */
data class AnnotationHistory(
    val past: List<List<StudyAnnotation>> = emptyList(),
    val future: List<List<StudyAnnotation>> = emptyList(),
    val limit: Int = 100,
) {
    val canUndo get() = past.isNotEmpty()
    val canRedo get() = future.isNotEmpty()

    fun push(snapshot: List<StudyAnnotation>) = copy(past = (past + listOf(snapshot)).takeLast(limit), future = emptyList())

    fun undo(current: List<StudyAnnotation>): Pair<AnnotationHistory, List<StudyAnnotation>>? =
        if (past.isEmpty()) null else copy(past = past.dropLast(1), future = future + listOf(current)) to past.last()

    fun redo(current: List<StudyAnnotation>): Pair<AnnotationHistory, List<StudyAnnotation>>? =
        if (future.isEmpty()) null else copy(past = past + listOf(current), future = future.dropLast(1)) to future.last()
}
