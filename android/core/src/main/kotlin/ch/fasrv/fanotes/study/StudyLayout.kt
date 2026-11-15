package ch.fasrv.fanotes.study

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Where each annotation sits on screen and what a pointer hits. Sizes follow the desktop CSS
 * (`.study-label`, `.study-legend`, stamps, measure tags) at a reference page width of 800 px
 * and scale with the page width, so the look is the same at every zoom.
 */
const val REF_PAGE_WIDTH = 800.0

/** A page on screen: top-left corner and size in pixels. */
data class PageBox(val left: Double, val top: Double, val width: Double, val height: Double) {
    val k: Double get() = if (width > 0.0) width / REF_PAGE_WIDTH else 1.0
    fun px(fx: Double) = left + fx * width
    fun py(fy: Double) = top + fy * height
    fun fx(x: Double) = if (width > 0.0) ((x - left) / width).coerceIn(0.0, 1.0) else 0.0
    fun fy(y: Double) = if (height > 0.0) ((y - top) / height).coerceIn(0.0, 1.0) else 0.0
}

data class SRect(val l: Double, val t: Double, val r: Double, val b: Double) {
    val cx get() = (l + r) / 2.0
    val cy get() = (t + b) / 2.0
    val w get() = r - l
    val h get() = b - t
    fun contains(x: Double, y: Double, slop: Double = 0.0) = x >= l - slop && x <= r + slop && y >= t - slop && y <= b + slop
}

/** Text width in pixels; the Android side backs this with a `Paint`. */
fun interface TextMeasurer {
    fun width(text: String, fontPx: Double, bold: Boolean): Double
}

object StudyMetrics {
    const val LABEL_FONT = 14.0
    const val LABEL_PAD_X = 6.0
    const val LABEL_PAD_Y = 2.0
    const val LABEL_BORDER = 1.5
    const val LABEL_RADIUS = 8.0
    const val BADGE = 20.0
    const val BADGE_GAP = 4.0
    const val ANCHOR_R = 4.0
    const val ANCHOR_R_SELECTED = 6.0
    const val LEADER_MIN = 14.0
    const val LEADER_WIDTH = 2.0
    const val LEGEND_MIN_W = 150.0
    const val LEGEND_PAD_X = 10.0
    const val LEGEND_PAD_Y = 8.0
    const val LEGEND_FONT = 13.0
    const val LEGEND_TITLE_H = 17.0
    const val LEGEND_ROW_H = 24.0
    const val LEGEND_ROW_GAP = 8.0
    const val LEGEND_GLYPH_W = 16.0
    const val MEASURE_FONT = 13.0
    const val MEASURE_POINT_R = 5.0
    const val STAMP_REF = 800.0
    const val STROKE_REF = 1000.0
    const val RESIZE_HANDLE = 14.0
}

const val LABEL_PLACEHOLDER = "Beschriftung"
const val LABEL_PLACEHOLDER_NUMBERED = "Bedeutung"
const val LEGEND_TITLE = "Legende"
const val LEGEND_EMPTY = "Noch keine Zeichen gesetzt."

/** Text shown inside a callout label: numbered labels show only the badge until selected. */
fun calloutShowsText(c: StudyCallout, selected: Boolean) = c.num == null || selected

fun calloutLabelRect(c: StudyCallout, box: PageBox, selected: Boolean, m: TextMeasurer): SRect {
    val k = box.k
    val cx = box.px(c.lx)
    val cy = box.py(c.ly)
    var inner = 0.0
    var innerH = 0.0
    if (c.num != null) {
        inner += StudyMetrics.BADGE
        innerH = StudyMetrics.BADGE
    }
    if (calloutShowsText(c, selected)) {
        val shown = c.text.ifEmpty { if (c.num != null) LABEL_PLACEHOLDER_NUMBERED else LABEL_PLACEHOLDER }
        if (c.num != null) inner += StudyMetrics.BADGE_GAP
        inner += max(3 * StudyMetrics.LABEL_FONT * 0.6, m.width(shown, StudyMetrics.LABEL_FONT * k, true) / k)
        innerH = max(innerH, StudyMetrics.LABEL_FONT * 1.3 + 4.0)
    }
    val w = (inner + 2 * StudyMetrics.LABEL_PAD_X + 2 * StudyMetrics.LABEL_BORDER) * k
    val h = (innerH + 2 * StudyMetrics.LABEL_PAD_Y + 2 * StudyMetrics.LABEL_BORDER) * k
    return SRect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
}

data class LegendLayout(val rect: SRect, val rows: List<LegendRow>, val rowRects: List<SRect>, val empty: Boolean)

fun legendLayout(legend: StudyLegend, all: List<StudyAnnotation>, box: PageBox, m: TextMeasurer): LegendLayout {
    val k = box.k
    val rows = legendRows(all, legend.names)
    var textW = 0.0
    for (row in rows) {
        textW = max(textW, StudyMetrics.LEGEND_GLYPH_W + StudyMetrics.LEGEND_ROW_GAP + m.width(row.label.ifEmpty { "..." }, StudyMetrics.LEGEND_FONT * k, false) / k)
    }
    val width = max(StudyMetrics.LEGEND_MIN_W, textW + 2 * StudyMetrics.LEGEND_PAD_X) * k
    val head = StudyMetrics.LEGEND_PAD_Y + StudyMetrics.LEGEND_TITLE_H
    val height = (head + (if (rows.isEmpty()) 20.0 else rows.size * StudyMetrics.LEGEND_ROW_H) + StudyMetrics.LEGEND_PAD_Y) * k
    val left = box.px(legend.x)
    val top = box.py(legend.y)
    val rowRects = rows.indices.map { i ->
        val t = top + (head + i * StudyMetrics.LEGEND_ROW_H) * k
        SRect(left, t, left + width, t + StudyMetrics.LEGEND_ROW_H * k)
    }
    return LegendLayout(SRect(left, top, left + width, top + height), rows, rowRects, rows.isEmpty())
}

fun stampFontPx(s: StudyStamp, box: PageBox) = max(10.0, s.size * box.width / StudyMetrics.STAMP_REF)

fun strokeWidthPx(s: StudyStroke, box: PageBox) = max(2.0, s.width * box.width / StudyMetrics.STROKE_REF)

fun imageRect(i: StudyImage, box: PageBox): SRect {
    val w = box.width * i.w
    val l = box.px(i.x)
    val t = box.py(i.y)
    return SRect(l, t, l + w, t + w / i.aspect)
}

/** Screen position of every measure point (3 or 4 for an angle, 2 for a distance). */
fun measureScreenPoints(item: StudyMeasure, box: PageBox) = item.pts.map { SPoint(box.px(it.x), box.py(it.y)) }

fun measureCentre(item: StudyMeasure, real: List<SPoint>): SPoint = when {
    item.mode == MEASURE_DISTANCE -> SPoint((real[0].x + real[1].x) / 2, (real[0].y + real[1].y) / 2)
    real.size == 3 -> real[1]
    else -> SPoint(real.sumOf { it.x } / real.size, real.sumOf { it.y } / real.size)
}

/** Line segments a measure draws, as index pairs into its points. */
fun measureSegments(item: StudyMeasure): List<Pair<Int, Int>> = when {
    item.mode == MEASURE_DISTANCE -> listOf(0 to 1)
    item.pts.size == 4 -> listOf(0 to 1, 2 to 3)
    else -> listOf(1 to 0, 1 to 2)
}

fun measureLabelRect(item: StudyMeasure, box: PageBox, text: String): SRect {
    val real = measureScreenPoints(item, box)
    val c = measureCentre(item, real)
    val k = box.k
    val w = max(40.0, text.length * 8.0 + 8.0) * k
    val l = c.x + (10.0 - 4.0) * k
    val t = c.y + (-12.0 - 14.0) * k
    return SRect(l, t, l + w, t + 20 * k)
}

// ---- hit testing ----------------------------------------------------------------------------

enum class StudyPart { ANCHOR, LABEL, BODY, POINT, RESIZE, LEGEND_ROW, STROKE, MEASURE_LABEL }

data class StudyHit(val id: String, val part: StudyPart, val index: Int = -1, val rowKey: String? = null)

private fun near(x: Double, y: Double, px: Double, py: Double, r: Double) = hypot(x - px, y - py) <= r

private fun distToSegment(px: Double, py: Double, a: SPoint, b: SPoint): Double {
    val dx = b.x - a.x
    val dy = b.y - a.y
    val len2 = dx * dx + dy * dy
    val t = if (len2 < 1e-12) 0.0 else (((px - a.x) * dx + (py - a.y) * dy) / len2).coerceIn(0.0, 1.0)
    return hypot(px - (a.x + t * dx), py - (a.y + t * dy))
}

/**
 * Topmost annotation at a screen point. Order is the paint order reversed: stamps, labels and
 * legends (HTML layer on desktop), then leader anchors, strokes and measures, then images.
 * [slop] is the finger/pen tolerance in pixels.
 */
fun hitTest(
    items: List<StudyAnnotation>,
    boxFor: (Int) -> PageBox?,
    x: Double,
    y: Double,
    selectedId: String?,
    slop: Double,
    m: TextMeasurer,
    pageCm: (PageBox) -> PageSizeCm = { pageSizeCm(it.width, it.height) },
): StudyHit? {
    for (item in items.asReversed()) {
        val box = boxFor(item.pageOrNull() ?: continue) ?: continue
        when (item) {
            is StudyStamp -> {
                val r = max(stampFontPx(item, box) * 0.7, slop)
                if (near(x, y, box.px(item.x), box.py(item.y), r)) return StudyHit(item.id, StudyPart.BODY)
            }
            is StudyCallout -> if (calloutLabelRect(item, box, item.id == selectedId, m).contains(x, y, slop / 2)) {
                return StudyHit(item.id, StudyPart.LABEL)
            }
            is StudyLegend -> {
                val layout = legendLayout(item, items, box, m)
                if (layout.rect.contains(x, y)) {
                    val row = layout.rowRects.indexOfFirst { it.contains(x, y) }
                    return if (row >= 0 && layout.rows[row].stamp) StudyHit(item.id, StudyPart.LEGEND_ROW, row, layout.rows[row].key) else StudyHit(item.id, StudyPart.BODY)
                }
            }
            else -> Unit
        }
    }
    for (item in items.asReversed()) {
        val box = boxFor(item.pageOrNull() ?: continue) ?: continue
        when (item) {
            is StudyCallout -> {
                val r = max(if (item.id == selectedId) StudyMetrics.ANCHOR_R_SELECTED else StudyMetrics.ANCHOR_R, slop)
                if (near(x, y, box.px(item.ax), box.py(item.ay), r)) return StudyHit(item.id, StudyPart.ANCHOR)
            }
            is StudyMeasure -> {
                val real = measureScreenPoints(item, box)
                real.forEachIndexed { index, p -> if (near(x, y, p.x, p.y, max(StudyMetrics.MEASURE_POINT_R * box.k, slop))) return StudyHit(item.id, StudyPart.POINT, index) }
                val text = formatMeasure(item, measureValue(item, pageCm(box)))
                if (measureLabelRect(item, box, text).contains(x, y, slop / 2)) return StudyHit(item.id, StudyPart.MEASURE_LABEL)
            }
            is StudyStroke -> {
                val reach = max(strokeWidthPx(item, box) / 2, slop)
                val pts = item.pts.map { SPoint(box.px(it.x), box.py(it.y)) }
                for (i in 0 until pts.size - 1) if (distToSegment(x, y, pts[i], pts[i + 1]) <= reach) return StudyHit(item.id, StudyPart.STROKE)
            }
            else -> Unit
        }
    }
    for (item in items.asReversed()) {
        if (item !is StudyImage) continue
        val box = boxFor(item.page) ?: continue
        val rect = imageRect(item, box)
        if (!item.locked && item.id == selectedId && near(x, y, rect.r, rect.b, max(StudyMetrics.RESIZE_HANDLE, slop))) return StudyHit(item.id, StudyPart.RESIZE)
        if (rect.contains(x, y)) return StudyHit(item.id, StudyPart.BODY)
    }
    return null
}

// ---- editing --------------------------------------------------------------------------------

private fun f(v: Double) = min(1.0, max(0.0, v))

/** The annotation after a drag of [part] by (dx, dy) page fractions from its state at the start of the drag. */
fun dragged(item: StudyAnnotation, part: StudyPart, index: Int, dx: Double, dy: Double, absX: Double, absY: Double): StudyAnnotation = when (item) {
    is StudyCallout -> when (part) {
        StudyPart.ANCHOR -> item.copy(ax = f(item.ax + dx), ay = f(item.ay + dy))
        else -> item.copy(lx = f(item.lx + dx), ly = f(item.ly + dy))
    }
    is StudyStamp -> item.copy(x = f(item.x + dx), y = f(item.y + dy))
    is StudyLegend -> item.copy(x = f(item.x + dx), y = f(item.y + dy))
    is StudyImage -> if (part == StudyPart.RESIZE) item.copy(w = min(1.0, max(0.05, absX - item.x))) else if (item.locked) item else item.copy(x = f(item.x + dx), y = f(item.y + dy))
    is StudyMeasure -> if (part == StudyPart.POINT && index in item.pts.indices) {
        item.copy(pts = item.pts.mapIndexed { i, p -> if (i == index) SPoint(f(p.x + dx), f(p.y + dy)) else p })
    } else item
    else -> item
}

fun replaceItem(list: List<StudyAnnotation>, next: StudyAnnotation) = list.map { if (it.id == next.id && it::class == next::class) next else it }

fun removeItem(list: List<StudyAnnotation>, id: String) = list.filter { it.id != id }

/** Adds an item through the sanitiser, so a bad value can never enter the list. */
fun addItem(list: List<StudyAnnotation>, item: StudyAnnotation): List<StudyAnnotation> {
    val clean = sanitizeAnnotation(studyAnnotationJson(item)) ?: return list
    return if (list.any { it.id == clean.id }) list else parseStudyAnnotationList(list + clean)
}

fun withTerms(list: List<StudyAnnotation>, terms: List<String>): List<StudyAnnotation> {
    val rest = list.filter { it !is StudyTerms }
    return if (terms.isEmpty()) rest else rest + StudyTerms(terms.take(ANNOTATION_TERMS_MAX))
}

fun termsOf(list: List<StudyAnnotation>): List<String> = list.filterIsInstance<StudyTerms>().firstOrNull()?.list.orEmpty()

/** New callout the way the desktop tool makes it: a tap puts the label up and to the right, a drag puts it where the pen ended. */
fun newCallout(list: List<StudyAnnotation>, page: Int, startX: Double, startY: Double, endX: Double, endY: Double, color: String, numbered: Boolean, text: String = ""): StudyCallout {
    val dragged = hypot(endX - startX, endY - startY) > 0.015
    return StudyCallout(
        newAnnotationId(), page, startX, startY,
        if (dragged) endX else f(startX + 0.1), if (dragged) endY else f(startY - 0.05),
        text.take(120), color, if (numbered) nextCalloutNumber(list) else null,
    )
}

/** Branch highlight from pen samples, thinned like the desktop pen (min step 0.002) and capped. */
fun newBranchStroke(page: Int, samples: List<SPoint>, color: String, width: Double): StudyStroke {
    val kept = ArrayList<SPoint>()
    for (p in samples) if (kept.isEmpty() || hypot(p.x - kept.last().x, p.y - kept.last().y) >= 0.002) kept += p
    val pts = if (kept.size >= 2) kept.takeLast(ANNOTATION_STROKE_POINTS_MAX) else listOf(samples.first(), SPoint(min(1.0, samples.first().x + 0.004), samples.first().y))
    return StudyStroke(newAnnotationId(), page, pts, color, width, 0.4)
}

/** Points still needed before a measure can be created. */
fun measurePointsNeeded(mode: StudyTool): Int = when (mode) {
    StudyTool.ANGLE -> 3
    StudyTool.ANGLE_LINES -> 4
    StudyTool.DISTANCE -> 2
    else -> 0
}

fun newMeasure(tool: StudyTool, page: Int, pts: List<SPoint>): StudyMeasure =
    StudyMeasure(newAnnotationId(), page, if (tool == StudyTool.DISTANCE) MEASURE_DISTANCE else MEASURE_ANGLE, pts, "#dc2626")

enum class StudyTool { SELECT, CALLOUT, STAMP, LEGEND, BRANCH, ANGLE, ANGLE_LINES, DISTANCE }

/**
 * Screen box of annotation page [page]. PDF pages come from [frames] (same lookup as note text
 * fields: the page's frame, or the only frame); a note without frames is one page, the sheet.
 */
fun studyPageBox(
    page: Int,
    frames: List<ch.fasrv.fanotes.desk.PageFrame>,
    sheetLeft: Double,
    sheetTop: Double,
    scale: Double,
    sourceWidth: Double,
    sourceHeight: Double,
): PageBox? {
    if (frames.isEmpty()) {
        return if (page == 1) PageBox(sheetLeft, sheetTop, sourceWidth * scale, sourceHeight * scale) else null
    }
    val frame = frames.firstOrNull { it.page == page } ?: frames.singleOrNull() ?: return null
    if (frame.width <= 0.0 || frame.height <= 0.0) return null
    return PageBox(sheetLeft, sheetTop + frame.top * scale, frame.width * scale, frame.height * scale)
}

/** Keeps page-1 annotations of a frameless note on the same spot when the sheet grows (see `keepMarkOnPage`). */
fun studyAfterSheetGrow(
    list: List<StudyAnnotation>,
    prevWidth: Double,
    prevHeight: Double,
    nextWidth: Double,
    nextHeight: Double,
    padX: Double,
    padY: Double,
): List<StudyAnnotation> {
    fun mx(v: Double) = ch.fasrv.fanotes.ink.keepMarkOnPage(v, prevWidth, nextWidth, padX)
    fun my(v: Double) = ch.fasrv.fanotes.ink.keepMarkOnPage(v, prevHeight, nextHeight, padY)
    fun mp(p: SPoint) = SPoint(mx(p.x), my(p.y))
    val widthRatio = if (nextWidth > 0.0 && prevWidth > 0.0) prevWidth / nextWidth else 1.0
    val next = list.map {
        when (it) {
            is StudyCallout -> it.copy(ax = mx(it.ax), ay = my(it.ay), lx = mx(it.lx), ly = my(it.ly))
            is StudyStamp -> it.copy(x = mx(it.x), y = my(it.y))
            is StudyLegend -> it.copy(x = mx(it.x), y = my(it.y))
            is StudyImage -> it.copy(x = mx(it.x), y = my(it.y), w = (it.w * widthRatio).coerceIn(0.05, 1.0))
            is StudyStroke -> it.copy(pts = it.pts.map(::mp))
            is StudyMeasure -> it.copy(pts = it.pts.map(::mp))
            is StudyTerms -> it
        }
    }
    return if (next == list) list else next
}
