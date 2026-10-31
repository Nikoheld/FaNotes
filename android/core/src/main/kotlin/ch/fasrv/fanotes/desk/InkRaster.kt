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
