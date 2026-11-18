package ch.fasrv.fanotes.desk

import kotlin.math.ceil

/**
 * Committed ink is rasterized at the scale it is shown. The cache never drops
 * below that scale, and a pen move only rebuilds tiles the stroke touches.
 */

const val COMMITTED_INK_ANTIALIAS = true

/** A pen move paints into existing tiles. It does not allocate a page bitmap. */
const val inkMoveAllocatesFullPage = false

fun committedRasterScale(displayedPixelsPerPageUnit: Float): Float {
    if (!displayedPixelsPerPageUnit.isFinite() || displayedPixelsPerPageUnit <= 0f) return 1f
    return displayedPixelsPerPageUnit
}

/** Zooming in raises the cache. Zooming out keeps the sharper tiles. */
fun nextCacheScale(cache: Float, displayedPixelsPerPageUnit: Float): Float {
    val shown = committedRasterScale(displayedPixelsPerPageUnit)
    if (cache <= 0f || shown > cache) return shown
    return cache
}

/** Bitmap edge in pixels. Not clamped below the displayed tile. */
fun tileBitmapSide(tilePage: Int, rasterScale: Float): Int {
    val side = ceil(tilePage.toDouble() * rasterScale.toDouble()).toInt()
    return side.coerceAtLeast(1)
}

data class PageTile(val x: Int, val y: Int)

data class TileRect(val left: Float, val top: Float, val right: Float, val bottom: Float)

fun tilesToRebuild(existing: Collection<PageTile>, stroke: TileRect?, tile: Int): Set<PageTile> {
    if (stroke == null || tile <= 0) return existing.toSet()
    return existing.filter { pageTile -> tileHits(pageTile, stroke, tile) }.toSet()
}

fun tileHits(tile: PageTile, stroke: TileRect, size: Int): Boolean {
    val right = tile.x + size
    val bottom = tile.y + size
    return stroke.right >= tile.x && stroke.left <= right && stroke.bottom >= tile.y && stroke.top <= bottom
}

/**
 * Sample bounds of a stroke in its 0–1 page space: [minX, minY, maxX, maxY], or null without samples.
 * Cached per stroke, so testing a tile against every stroke stays one box check each.
 */
fun strokeSampleBounds(points: List<ch.fasrv.fanotes.ink.StrokePoint>): DoubleArray? {
    if (points.isEmpty()) return null
    var left = Double.POSITIVE_INFINITY
    var top = Double.POSITIVE_INFINITY
    var right = Double.NEGATIVE_INFINITY
    var bottom = Double.NEGATIVE_INFINITY
    for (index in points.indices) {
        val point = points[index]
        if (point.x < left) left = point.x
        if (point.x > right) right = point.x
        if (point.y < top) top = point.y
        if (point.y > bottom) bottom = point.y
    }
    return doubleArrayOf(left, top, right, bottom)
}

/**
 * Whether a stroke whose samples lie in [bounds] (0–1 page space, see [strokeSampleBounds]) may paint into the
 * tile at page px ([tileX], [tileY]) of side [tile], with the stroke reaching [pad] page px past its samples.
 * True for every stroke that has a sample inside the padded tile, and also for one that only crosses it between
 * two samples, so a tile never misses a long straight segment.
 */
fun boundsNearTile(bounds: DoubleArray, pageWidth: Double, pageHeight: Double, pad: Double, tileX: Int, tileY: Int, tile: Int): Boolean {
    val left = bounds[0] * pageWidth
    val top = bounds[1] * pageHeight
    val right = bounds[2] * pageWidth
    val bottom = bounds[3] * pageHeight
    return right >= tileX - pad && left <= tileX + tile + pad && bottom >= tileY - pad && top <= tileY + tile + pad
}

/** How far past its samples a stroke may paint, in page px, for the tile test. Symbols and figures reach their size. */
fun tileStrokePad(stroke: ch.fasrv.fanotes.ink.InkStroke): Double =
    if (stroke.symbolId != null || stroke.figurePaths.isNotEmpty()) stroke.baseWidth + (stroke.figureLineWidth ?: 0.0) else 40.0

/**
 * [strokeSampleBounds] for every stroke of a document, rebuilt only for strokes that are new since the last call.
 * Documents are immutable and keep their stroke objects across edits, so a commit or an erase reuses the boxes
 * of every stroke it left alone.
 */
class StrokeBoundsCache {
    private var strokes: List<ch.fasrv.fanotes.ink.InkStroke> = emptyList()
    private var bounds: List<DoubleArray?> = emptyList()

    fun table(next: List<ch.fasrv.fanotes.ink.InkStroke>): List<DoubleArray?> {
        if (next === strokes) return bounds
        val previous = strokes
        val previousBounds = bounds
        var keep = 0
        val limit = minOf(previous.size, next.size)
        while (keep < limit && previous[keep] === next[keep]) keep += 1
        var known: java.util.IdentityHashMap<ch.fasrv.fanotes.ink.InkStroke, DoubleArray?>? = null
        val table = ArrayList<DoubleArray?>(next.size)
        for (index in next.indices) {
            if (index < keep) {
                table += previousBounds[index]
                continue
            }
            val stroke = next[index]
            if (known == null && keep < previous.size) {
                known = java.util.IdentityHashMap<ch.fasrv.fanotes.ink.InkStroke, DoubleArray?>(previous.size - keep)
                for (old in keep until previous.size) known[previous[old]] = previousBounds[old]
            }
            table += if (known != null && known.containsKey(stroke)) known[stroke] else strokeSampleBounds(stroke.points)
        }
        strokes = next
        bounds = table
        return table
    }

    fun clear() {
        strokes = emptyList()
        bounds = emptyList()
    }
}
