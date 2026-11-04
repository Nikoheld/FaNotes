package ch.fasrv.fanotes.ink

/**
 * Phone paper camera. [pageX]/[pageY] are page pixels of the viewport origin so
 * rotation can reclamp without jumping the ink under the pen.
 */
data class InkCamera(
    val zoom: Float = 1f,
    val pageX: Float = 0f,
    val pageY: Float = 0f,
)

const val INK_ZOOM_MIN = 1f
const val INK_ZOOM_MAX = 6f

fun fitScale(viewWidth: Float, sourceWidth: Double): Float =
    viewWidth.coerceAtLeast(1f) / sourceWidth.toFloat().coerceAtLeast(1f)

fun displayedScale(viewWidth: Float, sourceWidth: Double, zoom: Float): Float =
    fitScale(viewWidth, sourceWidth) * zoom.coerceIn(INK_ZOOM_MIN, INK_ZOOM_MAX)

/** Page point (0–1) under a view pixel. */
fun screenToNormalized(
    viewX: Float,
    viewY: Float,
    camera: InkCamera,
    viewWidth: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): Pair<Double, Double> {
    val scale = displayedScale(viewWidth, sourceWidth, camera.zoom).toDouble().coerceAtLeast(1e-6)
    val nx = ((camera.pageX + viewX / scale) / sourceWidth.coerceAtLeast(1.0)).coerceIn(0.0, 1.0)
    val ny = ((camera.pageY + viewY / scale) / sourceHeight.coerceAtLeast(1.0)).coerceIn(0.0, 1.0)
    return nx to ny
}

fun normalizedToScreen(
    nx: Double,
    ny: Double,
    camera: InkCamera,
    viewWidth: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): Pair<Float, Float> {
    val scale = displayedScale(viewWidth, sourceWidth, camera.zoom)
    return ((nx * sourceWidth - camera.pageX) * scale).toFloat() to
        ((ny * sourceHeight - camera.pageY) * scale).toFloat()
}

/** Zoom around a focus point in view pixels, keeping that page point under the focus. */
fun zoomAtFocus(
    camera: InkCamera,
    focusX: Float,
    focusY: Float,
    nextZoom: Float,
    viewWidth: Float,
    viewHeight: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): InkCamera {
    val oldScale = displayedScale(viewWidth, sourceWidth, camera.zoom).coerceAtLeast(1e-6f)
    val pageAtFocusX = camera.pageX + focusX / oldScale
    val pageAtFocusY = camera.pageY + focusY / oldScale
    val zoom = nextZoom.coerceIn(INK_ZOOM_MIN, INK_ZOOM_MAX)
    val newScale = displayedScale(viewWidth, sourceWidth, zoom).coerceAtLeast(1e-6f)
    return clampInkCamera(
        InkCamera(zoom, pageAtFocusX - focusX / newScale, pageAtFocusY - focusY / newScale),
        viewWidth,
        viewHeight,
        sourceWidth,
        sourceHeight,
    )
}

/**
 * Two-finger pan and pinch as one gesture. The page point under [oldCentroid]
 * stays under [newCentroid]; zoom follows the span ratio.
 */
fun pinchPan(
    camera: InkCamera,
    oldCentroidX: Float,
    oldCentroidY: Float,
    oldSpan: Float,
    newCentroidX: Float,
    newCentroidY: Float,
    newSpan: Float,
    viewWidth: Float,
    viewHeight: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): InkCamera {
    val oldScale = displayedScale(viewWidth, sourceWidth, camera.zoom).coerceAtLeast(1e-6f)
    val pageX = camera.pageX + oldCentroidX / oldScale
    val pageY = camera.pageY + oldCentroidY / oldScale
    val ratio = if (oldSpan <= 1e-3f) 1f else newSpan / oldSpan
    val zoom = (camera.zoom * ratio).coerceIn(INK_ZOOM_MIN, INK_ZOOM_MAX)
    val newScale = displayedScale(viewWidth, sourceWidth, zoom).coerceAtLeast(1e-6f)
    return clampInkCamera(
        InkCamera(zoom, pageX - newCentroidX / newScale, pageY - newCentroidY / newScale),
        viewWidth,
        viewHeight,
        sourceWidth,
        sourceHeight,
    )
}

fun panInkCamera(
    camera: InkCamera,
    dxView: Float,
    dyView: Float,
    viewWidth: Float,
    viewHeight: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): InkCamera {
    val scale = displayedScale(viewWidth, sourceWidth, camera.zoom).coerceAtLeast(1e-6f)
    return clampInkCamera(
        camera.copy(pageX = camera.pageX - dxView / scale, pageY = camera.pageY - dyView / scale),
        viewWidth,
        viewHeight,
        sourceWidth,
        sourceHeight,
    )
}

fun clampInkCamera(
    camera: InkCamera,
    viewWidth: Float,
    viewHeight: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): InkCamera {
    val zoom = if (camera.zoom.isFinite()) camera.zoom.coerceIn(INK_ZOOM_MIN, INK_ZOOM_MAX) else INK_ZOOM_MIN
    val scale = displayedScale(viewWidth, sourceWidth, zoom).coerceAtLeast(1e-6f)
    val width = viewWidth.coerceAtLeast(1f)
    val height = viewHeight.coerceAtLeast(1f)
    val maxX = (sourceWidth.toFloat() - width / scale).coerceAtLeast(0f)
    val maxY = (sourceHeight.toFloat() - height / scale).coerceAtLeast(0f)
    val pageX = if (camera.pageX.isFinite()) camera.pageX.coerceIn(0f, maxX) else 0f
    val pageY = if (camera.pageY.isFinite()) camera.pageY.coerceIn(0f, maxY) else 0f
    return InkCamera(zoom, pageX, pageY)
}

fun doubleTapZoom(
    camera: InkCamera,
    focusX: Float,
    focusY: Float,
    viewWidth: Float,
    viewHeight: Float,
    sourceWidth: Double,
    sourceHeight: Double,
): InkCamera {
    val next = if (camera.zoom > 1.05f) INK_ZOOM_MIN else 2.5f
    return zoomAtFocus(camera, focusX, focusY, next, viewWidth, viewHeight, sourceWidth, sourceHeight)
}

fun fingerCentroid(points: Collection<Pair<Float, Float>>): Pair<Float, Float> {
    if (points.isEmpty()) return 0f to 0f
    var x = 0.0
    var y = 0.0
    for (point in points) {
        x += point.first
        y += point.second
    }
    val n = points.size.toFloat()
    return (x / n).toFloat() to (y / n).toFloat()
}

fun fingerSpan(points: List<Pair<Float, Float>>): Float {
    if (points.size < 2) return 0f
    val dx = points[0].first - points[1].first
    val dy = points[0].second - points[1].second
    return kotlin.math.hypot(dx, dy)
}
