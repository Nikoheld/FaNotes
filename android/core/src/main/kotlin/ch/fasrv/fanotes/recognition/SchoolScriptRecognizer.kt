package ch.fasrv.fanotes.recognition

import ch.fasrv.fanotes.ink.InkStroke
import ch.fasrv.fanotes.ink.PAGE_START_HEIGHT
import ch.fasrv.fanotes.ink.PAGE_START_WIDTH
import ch.fasrv.fanotes.ink.schoolScript
import ch.fasrv.fanotes.ink.snapStrokeToShape
import kotlin.math.hypot

/**
 * Reads phrases this client placed with its built-in school script.
 * The source string is not an input: strokes are matched back to the glyphs
 * that produced them. Connectors and umlaut dots are skipped. A straight line
 * or a snapped figure yields no words.
 */
fun recognizeSchoolScript(strokes: List<InkStroke>): String {
    if (strokes.isEmpty()) return ""
    if (strokes.any { stroke -> stroke.points.any { point -> !point.x.isFinite() || !point.y.isFinite() } }) return ""
    if (isNonTextFigure(strokes)) return ""
    val lines = splitWritingLines(strokes)
    val parts = ArrayList<String>(lines.size)
    for (line in lines) {
        val text = recognizeLine(line) ?: return ""
        if (text.isNotEmpty()) parts += text
    }
    val text = parts.joinToString("\n")
    if (text.none { it.isLetterOrDigit() }) return ""
    return text
}

object SchoolScriptHandwritingRecognizer : HandwritingRecognizer {
    override val available = true
    override suspend fun recognize(strokes: List<InkStroke>): String = recognizeSchoolScript(strokes)
}

private const val SAMPLES = 24
private const val MAX_DISTANCE = 0.14
private const val DISTANCE_SLACK = 0.045
private const val WORD_GAP_RATIO = 0.25
private const val CONNECTOR_POINTS = 13

private class GlyphTemplate(
    val label: String,
    val counts: IntArray,
    val samples: List<List<Pair<Double, Double>>>,
)

private class Hit(
    val label: String,
    val length: Int,
    val minX: Double,
    val maxX: Double,
)

private class WritingBox(val minX: Double, val minY: Double, val maxX: Double, val maxY: Double)

private val templates: List<GlyphTemplate> by lazy {
    schoolScript().mapNotNull { sample ->
        val raw = sample.strokes.map { stroke -> stroke.points.map { it.x to it.y } }
        val normalized = normalize(raw) ?: return@mapNotNull null
        GlyphTemplate(
            label = sample.label,
            counts = IntArray(sample.strokes.size) { index -> sample.strokes[index].points.size },
            samples = normalized.map { resample(it, SAMPLES) },
        )
    }
}

private val templatesByFirstCount: Map<Int, List<GlyphTemplate>> by lazy {
    templates.groupBy { it.counts.first() }
}

private fun isNonTextFigure(strokes: List<InkStroke>): Boolean {
    if (strokes.size != 1) return false
    val points = strokes[0].points
    if (points.size < 2) return true
    if (isCollinear(points)) return true
    return snapStrokeToShape(points, PAGE_START_WIDTH, PAGE_START_HEIGHT) != null
}

private fun isCollinear(points: List<ch.fasrv.fanotes.ink.StrokePoint>): Boolean {
    if (points.size < 3) return true
    val first = points.first()
    val last = points.last()
    val chord = hypot(last.x - first.x, last.y - first.y)
    if (chord < 1e-8) return true
    var maxDeviation = 0.0
    for (point in points) {
        val deviation = distanceToSegment(point.x, point.y, first.x, first.y, last.x, last.y)
        if (deviation > maxDeviation) maxDeviation = deviation
    }
    return maxDeviation / chord < 0.08
}

private fun distanceToSegment(px: Double, py: Double, ax: Double, ay: Double, bx: Double, by: Double): Double {
    val dx = bx - ax
    val dy = by - ay
    val length2 = dx * dx + dy * dy
    if (length2 < 1e-12) return hypot(px - ax, py - ay)
    val t = ((px - ax) * dx + (py - ay) * dy) / length2
    val clamped = t.coerceIn(0.0, 1.0)
    return hypot(px - (ax + dx * clamped), py - (ay + dy * clamped))
}

private fun recognizeLine(strokes: List<InkStroke>): String? {
    val hits = ArrayList<Hit>()
    var index = 0
    while (index < strokes.size) {
        val hit = bestHit(strokes, index)
        if (hit == null) {
            if (!isSkippable(strokes[index])) return null
            index += 1
            continue
        }
        hits += hit
        index += hit.length
    }
    if (hits.isEmpty()) return ""
    return joinHits(hits)
}

private fun isSkippable(stroke: InkStroke): Boolean {
    val count = stroke.points.size
    if (count <= 1) return true
    return count == CONNECTOR_POINTS && templates.none { it.counts.first() == CONNECTOR_POINTS }
}

private fun bestHit(strokes: List<InkStroke>, start: Int): Hit? {
    val firstCount = strokes[start].points.size
    val candidates = templatesByFirstCount[firstCount] ?: return null
    var bestDistance = Double.POSITIVE_INFINITY
    val matched = ArrayList<Pair<GlyphTemplate, Double>>()
    for (template in candidates) {
        val length = template.counts.size
        if (start + length > strokes.size) continue
        var countsMatch = true
        for (offset in 1 until length) {
            if (strokes[start + offset].points.size != template.counts[offset]) {
                countsMatch = false
                break
            }
        }
        if (!countsMatch) continue
        val distance = distanceTo(strokes.subList(start, start + length), template)
        if (distance > MAX_DISTANCE) continue
        matched += template to distance
        if (distance < bestDistance) bestDistance = distance
    }
    if (matched.isEmpty()) return null
    val chosen = matched
        .filter { it.second <= bestDistance + DISTANCE_SLACK }
        .maxWith(compareBy<Pair<GlyphTemplate, Double>> { it.first.counts.size }.thenBy { -it.second })
    val slice = strokes.subList(start, start + chosen.first.counts.size)
    var minX = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    for (stroke in slice) {
        for (point in stroke.points) {
            if (point.x < minX) minX = point.x
            if (point.x > maxX) maxX = point.x
        }
    }
    return Hit(chosen.first.label, chosen.first.counts.size, minX, maxX)
}

private fun distanceTo(strokes: List<InkStroke>, template: GlyphTemplate): Double {
    val normalized = normalize(strokes.map { stroke -> stroke.points.map { it.x to it.y } }) ?: return Double.POSITIVE_INFINITY
    var sum = 0.0
    var count = 0
    for (index in template.samples.indices) {
        val candidate = resample(normalized[index], SAMPLES)
        val expected = template.samples[index]
        for (sample in candidate.indices) {
            sum += hypot(candidate[sample].first - expected[sample].first, candidate[sample].second - expected[sample].second)
            count += 1
        }
    }
    return if (count == 0) Double.POSITIVE_INFINITY else sum / count
}

private fun joinHits(hits: List<Hit>): String {
    if (hits.size == 1) return hits[0].label
    val widths = hits.map { (it.maxX - it.minX).coerceAtLeast(1e-6) }.sorted()
    val median = widths[widths.size / 2]
    val text = StringBuilder(hits[0].label)
    for (index in 1 until hits.size) {
        val gap = hits[index].minX - hits[index - 1].maxX
        if (gap > median * WORD_GAP_RATIO) text.append(' ')
        text.append(hits[index].label)
    }
    return text.toString()
}

private fun splitWritingLines(strokes: List<InkStroke>): List<List<InkStroke>> {
    if (strokes.isEmpty()) return emptyList()
    val boxes = strokes.map { stroke ->
        var minX = Double.POSITIVE_INFINITY
        var minY = Double.POSITIVE_INFINITY
        var maxX = Double.NEGATIVE_INFINITY
        var maxY = Double.NEGATIVE_INFINITY
        for (point in stroke.points) {
            if (point.x < minX) minX = point.x
            if (point.y < minY) minY = point.y
            if (point.x > maxX) maxX = point.x
            if (point.y > maxY) maxY = point.y
        }
        if (stroke.points.isEmpty()) WritingBox(0.0, 0.0, 0.0, 0.0) else WritingBox(minX, minY, maxX, maxY)
    }
    val heights = boxes.map { (it.maxY - it.minY).coerceAtLeast(0.0) }.filter { it > 1e-6 }.sorted()
    val medianHeight = if (heights.isEmpty()) 0.0 else heights[heights.size / 2]
    val slack = medianHeight * 0.2
    val parent = IntArray(strokes.size) { it }
    fun find(index: Int): Int {
        var cursor = index
        while (parent[cursor] != cursor) cursor = parent[cursor]
        var again = index
        while (parent[again] != cursor) {
            val next = parent[again]
            parent[again] = cursor
            again = next
        }
        return cursor
    }
    fun union(left: Int, right: Int) {
        val a = find(left)
        val b = find(right)
        if (a != b) parent[b] = a
    }
    for (left in strokes.indices) {
        for (right in left + 1 until strokes.size) {
            val a = boxes[left]
            val b = boxes[right]
            if (a.minY <= b.maxY + slack && b.minY <= a.maxY + slack) union(left, right)
        }
    }
    val groups = LinkedHashMap<Int, MutableList<Int>>()
    for (index in strokes.indices) groups.getOrPut(find(index)) { ArrayList() }.add(index)
    return groups.values
        .sortedBy { indexes -> indexes.minOf { boxes[it].minY } }
        .map { indexes -> indexes.sorted().map { strokes[it] } }
}

private fun normalize(strokes: List<List<Pair<Double, Double>>>): List<List<Pair<Double, Double>>>? {
    var minX = Double.POSITIVE_INFINITY
    var minY = Double.POSITIVE_INFINITY
    var maxX = Double.NEGATIVE_INFINITY
    var maxY = Double.NEGATIVE_INFINITY
    var any = false
    for (stroke in strokes) {
        for ((x, y) in stroke) {
            any = true
            if (x < minX) minX = x
            if (y < minY) minY = y
            if (x > maxX) maxX = x
            if (y > maxY) maxY = y
        }
    }
    if (!any) return null
    val width = maxX - minX
    val height = maxY - minY
    if (width < 1e-8 || height < 1e-8) return null
    return strokes.map { stroke -> stroke.map { (x, y) -> (x - minX) / width to (y - minY) / height } }
}

private fun resample(points: List<Pair<Double, Double>>, count: Int): List<Pair<Double, Double>> {
    if (points.isEmpty()) return List(count) { 0.0 to 0.0 }
    if (points.size == 1 || count <= 1) return List(count) { points.first() }
    val lengths = DoubleArray(points.size)
    var total = 0.0
    for (index in 1 until points.size) {
        total += hypot(points[index].first - points[index - 1].first, points[index].second - points[index - 1].second)
        lengths[index] = total
    }
    if (total < 1e-12) return List(count) { points.first() }
    return List(count) { index ->
        val target = total * index / (count - 1)
        var cursor = 1
        while (cursor < lengths.size && lengths[cursor] < target) cursor += 1
        if (cursor >= lengths.size) points.last()
        else {
            val span = (lengths[cursor] - lengths[cursor - 1]).coerceAtLeast(1e-12)
            val t = ((target - lengths[cursor - 1]) / span).coerceIn(0.0, 1.0)
            val start = points[cursor - 1]
            val end = points[cursor]
            (start.first + (end.first - start.first) * t) to (start.second + (end.second - start.second) * t)
        }
    }
}
