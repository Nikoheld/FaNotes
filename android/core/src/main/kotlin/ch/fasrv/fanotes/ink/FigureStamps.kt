package ch.fasrv.fanotes.ink

import ch.fasrv.fanotes.json.JsonValue
import ch.fasrv.fanotes.json.jsonNumber
import ch.fasrv.fanotes.json.jsonString

/**
 * Math-figure and function-graph stamps, built like the desktop's pointer-down in `DrawingBoard.tsx`:
 * one point, `baseWidth` = stamp size, `purpose: "art"`. The desktop rebuilds a figure from
 * `figureId` + `figureParams` and a graph from `graphExpression` + domain (with `graphPaths` as the
 * fallback), so those fields are written; Android draws [InkStroke.figurePaths].
 */
const val FIGURE_SIZE_MIN = 40.0
const val FIGURE_SIZE_MAX = 320.0
const val FIGURE_SIZE_DEFAULT = 120.0

fun snapFigureSize(value: Double): Double {
    if (!value.isFinite()) return FIGURE_SIZE_DEFAULT
    val clamped = value.coerceIn(FIGURE_SIZE_MIN, FIGURE_SIZE_MAX)
    return (Math.round(clamped / 2.0) * 2.0).coerceIn(FIGURE_SIZE_MIN, FIGURE_SIZE_MAX)
}

/** Armed figure: what the next pen tap stamps. */
data class FigureStampSpec(
    val figureId: String,
    val params: Map<String, Double>,
    val size: Double = FIGURE_SIZE_DEFAULT,
    val rotation: Double = 0.0,
    val lineWidth: Double = figureLineWidthForSize(FIGURE_SIZE_DEFAULT),
)

/** Armed function graph; [paths] come from [functionGraphPaths] when it was armed. */
data class GraphStampSpec(
    val expression: String,
    val xMin: Double,
    val xMax: Double,
    val paths: List<String>,
    val size: Double = FIGURE_SIZE_DEFAULT,
    val lineWidth: Double = figureLineWidthForSize(FIGURE_SIZE_DEFAULT),
)

private fun stampColor(style: StrokeStyle) = normalizeInkHex(style.color) ?: DEFAULT_PEN_COLOR

/** Desktop opacity: the drawing pen's opacity, 1 for the writing pen. */
private fun stampOpacity(style: StrokeStyle) = if (style.purpose == "art") (style.opacity ?: 1.0).coerceIn(DRAWING_OPACITY_MIN, 1.0) else 1.0

private fun stampEffect(style: StrokeStyle) = if (style.purpose == "art") normalizeInkEffect(style.colorEffect) else "solid"

fun figureStampStroke(spec: FigureStampSpec, x: Double, y: Double, style: StrokeStyle): InkStroke? {
    if (!isMathFigureId(spec.figureId)) return null
    val params = clampFigureParams(spec.figureId, spec.params)
    val size = snapFigureSize(spec.size)
    val paths = mathFigurePaths(spec.figureId, params)
    if (paths.isEmpty()) return null
    val extras = JsonValue.Obj()
    extras.put("figureId", jsonString(spec.figureId))
    val encoded = JsonValue.Obj()
    for ((key, value) in params) encoded.put(key, jsonNumber(value))
    extras.put("figureParams", encoded)
    return InkStroke(
        points = listOf(StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")),
        baseWidth = size,
        pressureEnabled = false,
        color = stampColor(style),
        purpose = "art",
        brush = "fineliner",
        opacity = stampOpacity(style),
        colorEffect = stampEffect(style),
        symbolRotation = spec.rotation.coerceIn(-180.0, 180.0),
        figureLineWidth = clampFigureLineWidth(spec.lineWidth, figureLineWidthForSize(size)),
        figurePaths = paths,
        extras = extras,
    )
}

fun graphStampStroke(spec: GraphStampSpec, x: Double, y: Double, style: StrokeStyle): InkStroke? {
    if (spec.paths.isEmpty()) return null
    val size = snapFigureSize(spec.size)
    val extras = JsonValue.Obj()
    extras.put("graphExpression", jsonString(spec.expression))
    extras.put("graphXMin", jsonNumber(spec.xMin))
    extras.put("graphXMax", jsonNumber(spec.xMax))
    extras.put("graphPaths", JsonValue.Arr(spec.paths.map { jsonString(it) }.toMutableList()))
    return InkStroke(
        points = listOf(StrokePoint(x, y, 0.0, 0.5, 0.0, 0.0, "pen")),
        baseWidth = size,
        pressureEnabled = false,
        color = stampColor(style),
        purpose = "art",
        brush = "fineliner",
        opacity = stampOpacity(style),
        colorEffect = stampEffect(style),
        symbolRotation = 0.0,
        figureLineWidth = clampFigureLineWidth(spec.lineWidth, figureLineWidthForSize(size)),
        figurePaths = spec.paths,
        extras = extras,
    )
}

/** Paths a desktop graph stroke draws: its stored `graphPaths`, rebuilt from the formula when possible. */
internal fun graphPathsOf(obj: JsonValue.Obj): List<String> {
    val stored = obj.array("graphPaths")?.items?.mapNotNull { (it as? JsonValue.Str)?.value }
    val stamp = readFunctionGraphStamp(obj.string("graphExpression"), obj.double("graphXMin"), obj.double("graphXMax"), stored)
    return stamp?.paths.orEmpty()
}
