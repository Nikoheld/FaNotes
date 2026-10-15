package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.famd.isPaperStyle
import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.deepCopy
import ch.fasrv.fanotes.json.jsonBool
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString
import kotlin.math.max

/** Drawing document stored as `payload.ink` and as `.fanotes/assets/<id>.json`. */
const val INK_SCHEMA_VERSION = 1
const val PAGE_START_WIDTH = 900.0
const val PAGE_START_HEIGHT = 1273.0
const val WRITE_MARGIN_X = 108.0
const val WRITE_MARGIN_Y = 144.0
const val GROW_STEP_X = WRITE_MARGIN_X
const val GROW_STEP_Y = WRITE_MARGIN_Y
const val WRITE_CAP_WIDTH = PAGE_START_WIDTH * 20
const val WRITE_CAP_HEIGHT = PAGE_START_HEIGHT * 40
const val OVERLAY_QUALITY = 1.75
const val OVERLAY_QUALITY_ZOOM = 6.0
const val DEFAULT_PEN_COLOR = "#202333"
const val DEFAULT_PEN_WIDTH = 3.5
const val DEFAULT_PAPER = "dots"

/** Matches `pressureWidth` in `inkStrokePaint.ts`. */
fun pressureWidth(baseWidth: Double, pressure: Double, pressureEnabled: Boolean): Double {
    if (!pressureEnabled) return baseWidth
    return baseWidth * (0.4 + max(0.08, pressure) * 1.12)
}

data class StrokePoint(
    val x: Double,
    val y: Double,
    val t: Double,
    val pressure: Double,
    val tiltX: Double,
    val tiltY: Double,
    val pointerType: String,
)

data class InkStroke(
    val points: List<StrokePoint>,
    val baseWidth: Double,
    val pressureEnabled: Boolean,
    val color: String,
    val purpose: String? = "handwriting",
    val brush: String? = null,
    val opacity: Double? = null,
    val colorEffect: String? = null,
    val symbolId: String? = null,
    val symbolRotation: Double = 0.0,
    /** Fields this client does not edit, preserved on save. */
    val extras: JsonValue.Obj = JsonValue.Obj(),
)

data class InkDocument(
    val title: String,
    val paperStyle: String,
    val sourceWidth: Double,
    val sourceHeight: Double,
    val strokes: List<InkStroke>,
    val createdAt: String,
    val updatedAt: String,
    /** Paper already inserted on the left and top. Stored as `sourceOriginX` / `sourceOriginY`. */
    val originX: Double = 0.0,
    val originY: Double = 0.0,
    val extras: JsonValue.Obj = JsonValue.Obj(),
) {
    fun toJson(): JsonValue.Obj {
        val obj = extras.deepCopy() as JsonValue.Obj
        obj.put("schemaVersion", jsonNumber(INK_SCHEMA_VERSION.toDouble()))
        obj.put("title", jsonString(title))
        obj.put("paperStyle", jsonString(paperStyle))
        obj.put("sourceWidth", jsonNumber(sourceWidth))
        obj.put("sourceHeight", jsonNumber(sourceHeight))
        if (originX > 0.0) obj.put("sourceOriginX", jsonNumber(originX))
        if (originY > 0.0) obj.put("sourceOriginY", jsonNumber(originY))
        obj.put("createdAt", jsonString(createdAt))
        obj.put("updatedAt", jsonString(updatedAt))
        obj.put("overlayQuality", jsonNumber(OVERLAY_QUALITY))
        obj.put("overlayQualityZoom", jsonNumber(OVERLAY_QUALITY_ZOOM))
        obj.put("strokes", JsonValue.Arr(strokes.map { it.toJson() }.toMutableList()))
        return obj
    }
}

fun InkStroke.toJson(): JsonValue.Obj {
    val obj = extras.deepCopy() as JsonValue.Obj
    obj.put("points", JsonValue.Arr(points.map { it.toJson() }.toMutableList()))
    obj.put("baseWidth", jsonNumber(baseWidth))
    obj.put("pressureEnabled", jsonBool(pressureEnabled))
    obj.put("color", jsonString(color))
    if (purpose != null) obj.put("purpose", jsonString(purpose))
    if (brush != null) obj.put("brush", jsonString(brush))
    if (opacity != null) obj.put("opacity", jsonNumber(opacity))
    if (colorEffect != null) obj.put("colorEffect", jsonString(colorEffect))
    if (symbolId != null) {
        obj.put("symbolId", jsonString(symbolId))
        obj.put("symbolRotation", jsonNumber(symbolRotation))
    }
    return obj
}

fun StrokePoint.toJson(): JsonValue.Obj = JsonValue.Obj().also { obj ->
    obj.put("x", jsonNumber(x))
    obj.put("y", jsonNumber(y))
    obj.put("t", jsonNumber(t))
    obj.put("pressure", jsonNumber(pressure))
    obj.put("tiltX", jsonNumber(tiltX))
    obj.put("tiltY", jsonNumber(tiltY))
    obj.put("pointerType", jsonString(pointerType))
}

private val KNOWN_STROKE_KEYS = setOf(
    "points", "baseWidth", "pressureEnabled", "color", "purpose", "brush", "opacity", "colorEffect",
    "symbolId", "symbolRotation",
)

fun parseInkDocument(value: JsonValue.Obj?, title: String, paperStyle: String, now: String): InkDocument {
    if (value == null) return newInkDocument(title, paperStyle, now)
    val style = value.string("paperStyle")?.takeIf { isPaperStyle(it) } ?: paperStyle
    val strokes = (value.array("strokes")?.items ?: emptyList()).mapNotNull { item ->
        (item as? JsonValue.Obj)?.let(::parseStroke)
    }
    val extras = JsonValue.Obj()
    for ((key, item) in value.fields) {
        if (key !in DOCUMENT_KEYS) extras.fields[key] = item.deepCopy()
    }
    return InkDocument(
        title = value.string("title")?.takeIf { it.isNotBlank() } ?: title,
        paperStyle = style,
        sourceWidth = value.double("sourceWidth")?.takeIf { it >= 64 } ?: PAGE_START_WIDTH,
        sourceHeight = value.double("sourceHeight")?.takeIf { it >= 64 } ?: PAGE_START_HEIGHT,
        strokes = strokes,
        originX = value.double("sourceOriginX")?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0,
        originY = value.double("sourceOriginY")?.takeIf { it.isFinite() && it > 0.0 } ?: 0.0,
        createdAt = value.string("createdAt") ?: now,
        updatedAt = value.string("updatedAt") ?: now,
        extras = extras,
    )
}

private val DOCUMENT_KEYS = setOf(
    "schemaVersion", "title", "paperStyle", "sourceWidth", "sourceHeight",
    "sourceOriginX", "sourceOriginY",
    "createdAt", "updatedAt", "overlayQuality", "overlayQualityZoom", "strokes",
)

internal fun parseStroke(obj: JsonValue.Obj): InkStroke? {
    val points = obj.array("points")?.items?.mapNotNull { item ->
        val point = item as? JsonValue.Obj ?: return@mapNotNull null
        val x = point.double("x") ?: return@mapNotNull null
        val y = point.double("y") ?: return@mapNotNull null
        StrokePoint(
            x = x,
            y = y,
            t = point.double("t") ?: 0.0,
            pressure = (point.double("pressure") ?: 0.5).coerceIn(0.0, 1.0),
            tiltX = point.double("tiltX") ?: 0.0,
            tiltY = point.double("tiltY") ?: 0.0,
            pointerType = point.string("pointerType") ?: "pen",
        )
    }.orEmpty()
    if (points.isEmpty()) return null
    val extras = JsonValue.Obj()
    for ((key, item) in obj.fields) {
        if (key !in KNOWN_STROKE_KEYS) extras.fields[key] = item.deepCopy()
    }
    return InkStroke(
        points = points,
        baseWidth = obj.double("baseWidth")?.takeIf { it > 0 } ?: DEFAULT_PEN_WIDTH,
        pressureEnabled = obj.bool("pressureEnabled") ?: true,
        color = obj.string("color") ?: DEFAULT_PEN_COLOR,
        purpose = obj.string("purpose"),
        brush = obj.string("brush"),
        opacity = obj.double("opacity"),
        colorEffect = obj.string("colorEffect"),
        symbolId = obj.string("symbolId")?.takeIf { artSymbol(it) != null },
        symbolRotation = obj.double("symbolRotation")?.takeIf { it.isFinite() } ?: 0.0,
        extras = extras,
    )
}

fun newInkDocument(title: String, paperStyle: String, now: String) = InkDocument(
    title = title,
    paperStyle = if (isPaperStyle(paperStyle)) paperStyle else DEFAULT_PAPER,
    sourceWidth = PAGE_START_WIDTH,
    sourceHeight = PAGE_START_HEIGHT,
    strokes = emptyList(),
    createdAt = now,
    updatedAt = now,
)

/**
 * Grows the page around a sample in current page pixels. A mark inside the
 * left or top margin inserts origin paper; a mark inside the right or bottom
 * margin extends that edge. Existing strokes keep their page-pixel position.
 */
fun growDocument(document: InkDocument, pageX: Double, pageY: Double): GrownInk {
    val width = document.sourceWidth
    val height = document.sourceHeight
    if (width < 1.0 || height < 1.0 || !pageX.isFinite() || !pageY.isFinite()) return GrownInk(document, 0.0, 0.0)
    val grown = growPageFromMark(width, height, document.originX, document.originY, pageX / width, pageY / height)
    if (grown.padX == 0.0 && grown.padY == 0.0 && grown.width == width && grown.height == height) {
        return GrownInk(document, 0.0, 0.0)
    }
    val remapped = document.copy(
        sourceWidth = grown.width,
        sourceHeight = grown.height,
        originX = document.originX + grown.padX.coerceAtLeast(0.0),
        originY = document.originY + grown.padY.coerceAtLeast(0.0),
        strokes = document.strokes.map { stroke ->
            stroke.copy(points = stroke.points.map { point ->
                point.copy(
                    x = keepMarkOnPage(point.x, width, grown.width, grown.padX),
                    y = keepMarkOnPage(point.y, height, grown.height, grown.padY),
                )
            })
        },
    )
    return GrownInk(remapSectionBands(remapped, height, grown.height, grown.padY), grown.padX, grown.padY)
}

private fun remapSectionBands(document: InkDocument, prevHeight: Double, nextHeight: Double, padY: Double): InkDocument {
    val sections = sectionsOf(document)
    if (sections.isEmpty()) return document
    return withSections(document, sections.map { section ->
        section.copy(
            top = keepMarkOnPage(section.top, prevHeight, nextHeight, padY),
            bodyTop = keepMarkOnPage(section.bodyTop, prevHeight, nextHeight, padY),
        )
    })
}

fun rescale(document: InkDocument, width: Double, height: Double): InkDocument {
    val scaleX = document.sourceWidth / width
    val scaleY = document.sourceHeight / height
    return document.copy(
        sourceWidth = width,
        sourceHeight = height,
        strokes = document.strokes.map { stroke ->
            stroke.copy(points = stroke.points.map { it.copy(x = it.x * scaleX, y = it.y * scaleY) })
        },
    )
}

fun rescalePoints(points: List<StrokePoint>, scaleX: Double, scaleY: Double) =
    points.map { it.copy(x = it.x * scaleX, y = it.y * scaleY) }
