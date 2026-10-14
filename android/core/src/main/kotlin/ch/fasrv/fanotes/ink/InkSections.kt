package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import java.util.UUID

/** Header band height on the 900-wide sheet. Matches `SECTION_HEADER_PX`. */
const val SECTION_HEADER_PX = 72.0
const val SECTION_BODY_MARGIN_PX = 108.0

data class HiddenSectionInk(
    val widthPx: Double,
    val heightPx: Double,
    val strokes: List<InkStroke>,
)

data class InkSection(
    val id: String,
    val top: Double,
    val bodyTop: Double,
    val collapsed: Boolean = false,
    val hidden: HiddenSectionInk? = null,
)

fun sectionsOf(document: InkDocument): List<InkSection> {
    val raw = document.extras["sections"] ?: return emptyList()
    return parseSections(raw)
}

fun withSections(document: InkDocument, sections: List<InkSection>): InkDocument {
    val extras = document.extras.deepCopy() as JsonValue.Obj
    if (sections.isEmpty()) extras.fields.remove("sections")
    else extras.put("sections", JsonValue.Arr(sections.map { it.toJson() }.toMutableList()))
    return document.copy(extras = extras)
}

fun insertSection(document: InkDocument, y: Double): InkDocument {
    val sections = sectionsOf(document).toMutableList()
    if (sections.any { y >= it.top && y < it.bodyTop }) return document
    val header = SECTION_HEADER_PX / document.sourceHeight
    val section = InkSection(id = "section-${UUID.randomUUID().toString().take(8)}", top = y.coerceIn(0.0, 0.9), bodyTop = (y + header).coerceAtMost(1.2))
    val grown = document.copy(sourceHeight = document.sourceHeight + SECTION_HEADER_PX)
    val scale = document.sourceHeight / grown.sourceHeight
    val shifted = grown.copy(
        strokes = grown.strokes.map { stroke ->
            if (strokeTop(stroke) < y) stroke
            else stroke.copy(points = stroke.points.map { it.copy(y = y + (it.y - y) * scale + header * scale) })
        },
    )
    val moved = sections.map { existing ->
        if (existing.top < y) existing
        else existing.copy(top = y + (existing.top - y) * scale + header * scale, bodyTop = y + (existing.bodyTop - y) * scale + header * scale)
    }
    return withSections(shifted, moved + section.copy(top = y * scale, bodyTop = (y + header) * scale))
}

fun toggleSection(document: InkDocument, id: String): InkDocument {
    val sections = sectionsOf(document)
    val section = sections.find { it.id == id } ?: return document
    return if (section.collapsed) expand(document, section) else collapse(document, section)
}

private fun collapse(document: InkDocument, section: InkSection): InkDocument {
    val sections = sectionsOf(document)
    val nextTop = sections.filter { it.top > section.bodyTop }.minOfOrNull { it.top }
    val lowest = document.strokes.filter { strokeTop(it) >= section.bodyTop && (nextTop == null || strokeTop(it) < nextTop) }
        .maxOfOrNull { strokeBottom(it) }
    val bodyEnd = nextTop ?: if (lowest == null || lowest <= section.bodyTop) section.bodyTop else lowest + SECTION_BODY_MARGIN_PX / document.sourceHeight
    val hiddenPx = ((bodyEnd - section.bodyTop) * document.sourceHeight).coerceAtLeast(0.0)
    if (hiddenPx <= 0.0) {
        return withSections(document, sections.map { if (it.id == section.id) it.copy(collapsed = true, hidden = null) else it })
    }
    val hiddenStrokes = document.strokes.filter { strokeTop(it) >= section.bodyTop && strokeTop(it) < bodyEnd }
    val normalized = hiddenStrokes.map { stroke ->
        stroke.copy(points = stroke.points.map { point ->
            point.copy(y = ((point.y - section.bodyTop) * document.sourceHeight / hiddenPx).coerceIn(0.0, 1.0))
        })
    }
    val delta = hiddenPx / document.sourceHeight
    val kept = document.strokes.filter { it !in hiddenStrokes }.map { shiftStroke(it, bodyEnd, -delta) }
    val shiftedSections = sections.map { current ->
        val top = if (current.top >= bodyEnd) current.top - delta else current.top
        val body = if (current.id == section.id) current.bodyTop else if (current.bodyTop >= bodyEnd) current.bodyTop - delta else current.bodyTop
        if (current.id == section.id) {
            current.copy(collapsed = true, top = top, bodyTop = body, hidden = HiddenSectionInk(document.sourceWidth, hiddenPx, normalized))
        } else {
            current.copy(top = top, bodyTop = body)
        }
    }
    val shrunkHeight = (document.sourceHeight - hiddenPx).coerceAtLeast(64.0)
    val scale = document.sourceHeight / shrunkHeight
    return withSections(
        document.copy(
            sourceHeight = shrunkHeight,
            strokes = kept.map { stroke -> stroke.copy(points = stroke.points.map { it.copy(y = it.y * scale) }) },
        ),
        shiftedSections.map { it.copy(top = it.top * scale, bodyTop = it.bodyTop * scale) },
    )
}

private fun expand(document: InkDocument, section: InkSection): InkDocument {
    val hidden = section.hidden
    val hiddenPx = hidden?.heightPx ?: 0.0
    val grownHeight = document.sourceHeight + hiddenPx
    val scale = document.sourceHeight / grownHeight
    val delta = if (grownHeight == 0.0) 0.0 else hiddenPx / grownHeight
    val boundary = section.bodyTop * scale
    val moved = document.strokes.map { stroke ->
        val scaled = stroke.copy(points = stroke.points.map { it.copy(y = it.y * scale) })
        if (strokeTop(scaled) < boundary) scaled else shiftStroke(scaled, boundary, delta)
    }
    val restored = hidden?.strokes.orEmpty().map { stroke ->
        stroke.copy(points = stroke.points.map { point ->
            point.copy(
                x = point.x * (hidden?.widthPx ?: document.sourceWidth) / document.sourceWidth,
                y = (section.bodyTop * document.sourceHeight + point.y * hiddenPx) / grownHeight,
            )
        })
    }
    val sections = sectionsOf(document).map { current ->
        val top = if (current.id == section.id) current.top * scale else if (current.top >= section.bodyTop) current.top * scale + delta else current.top * scale
        val body = if (current.id == section.id) current.bodyTop * scale else if (current.bodyTop >= section.bodyTop) current.bodyTop * scale + delta else current.bodyTop * scale
        if (current.id == section.id) current.copy(top = top, bodyTop = body, collapsed = false, hidden = null) else current.copy(top = top, bodyTop = body)
    }
    return withSections(document.copy(sourceHeight = grownHeight, strokes = moved + restored), sections)
}

private fun strokeTop(stroke: InkStroke) = stroke.points.minOf { it.y }
private fun strokeBottom(stroke: InkStroke) = stroke.points.maxOf { it.y }

private fun shiftStroke(stroke: InkStroke, boundary: Double, delta: Double): InkStroke {
    if (strokeTop(stroke) < boundary) return stroke
    return stroke.copy(points = stroke.points.map { it.copy(y = it.y + delta) })
}

private fun InkSection.toJson(): JsonValue.Obj = JsonValue.Obj().also { obj ->
    obj.put("id", jsonString(id))
    obj.put("top", jsonNumber(top))
    obj.put("bodyTop", jsonNumber(bodyTop))
    obj.put("collapsed", jsonBool(collapsed))
    obj.put("hidden", hidden?.toJson())
}

private fun HiddenSectionInk.toJson(): JsonValue.Obj = JsonValue.Obj().also { obj ->
    obj.put("widthPx", jsonNumber(widthPx))
    obj.put("heightPx", jsonNumber(heightPx))
    obj.put("strokes", JsonValue.Arr(strokes.map { it.toJson() }.toMutableList()))
}

private fun parseSections(value: JsonValue): List<InkSection> {
    val items = (value as? JsonValue.Arr)?.items ?: return emptyList()
    return items.mapNotNull { item ->
        val obj = item as? JsonValue.Obj ?: return@mapNotNull null
        val top = obj.double("top") ?: return@mapNotNull null
        val bodyTop = obj.double("bodyTop") ?: return@mapNotNull null
        if (bodyTop <= top) return@mapNotNull null
        val hiddenObj = obj.obj("hidden")
        val hidden = if (obj.bool("collapsed") == true && hiddenObj != null) {
            val width = hiddenObj.double("widthPx") ?: return@mapNotNull null
            val height = hiddenObj.double("heightPx") ?: return@mapNotNull null
            val strokes = hiddenObj.array("strokes")?.items.orEmpty().mapNotNull { (it as? JsonValue.Obj)?.let(::parseStroke) }
            HiddenSectionInk(width, height, strokes)
        } else {
            null
        }
        InkSection(obj.string("id") ?: "section", top, bodyTop, obj.bool("collapsed") == true, hidden)
    }.sortedBy { it.top }
}

fun pointInPolygon(x: Double, y: Double, polygon: List<StrokePoint>): Boolean {
    var inside = false
    var previous = polygon.lastOrNull() ?: return false
    for (point in polygon) {
        val intersect = (point.y > y) != (previous.y > y) &&
            x < (previous.x - point.x) * (y - point.y) / ((previous.y - point.y).takeIf { it != 0.0 } ?: 1e-9) + point.x
        if (intersect) inside = !inside
        previous = point
    }
    return inside
}

fun lassoHits(strokes: List<InkStroke>, polygon: List<StrokePoint>): Set<Int> {
    if (polygon.size < 3) return emptySet()
    return strokes.mapIndexedNotNull { index, stroke ->
        if (stroke.points.any { pointInPolygon(it.x, it.y, polygon) }) index else null
    }.toSet()
}
