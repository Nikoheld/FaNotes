package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Paint
import android.graphics.Path
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_SEARCH_SHADOW_BLUR_DP
import ch.fasrv.fanotes.desk.FirstRunPreviewSearchShadowFrame
import ch.fasrv.fanotes.desk.firstRunPreviewSearchShadowFrame
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * `.first-run-preview-search` box-shadow: `0 5px 15px rgba(0,0,0,.06)`.
 * Compose elevation is even on every side. The shifted rounded chip is blurred
 * on a software bitmap, then drawn behind the chip. A hardware canvas would
 * ignore [BlurMaskFilter], which is why the welcome sheet uses the same split.
 *
 * The sheet is `overflow: hidden`, so blur that leaves the paper is cut there.
 * The chip itself is not clipped, so the shadow can sit on the paper around it.
 */
fun Modifier.welcomePreviewSearchShade(): Modifier = this.then(WelcomePreviewSearchShadeElement)

private object WelcomePreviewSearchShadeElement : ModifierNodeElement<WelcomePreviewSearchShadeNode>() {
    override fun create(): WelcomePreviewSearchShadeNode = WelcomePreviewSearchShadeNode()
    override fun update(node: WelcomePreviewSearchShadeNode) = Unit
    override fun equals(other: Any?): Boolean = other === this
    override fun hashCode(): Int = "welcomePreviewSearchShade".hashCode()
}

private class WelcomePreviewSearchShadeNode : Modifier.Node(), DrawModifierNode {
    private val raster = WelcomePreviewSearchShadeRaster()

    override fun onDetach() {
        raster.clear()
        super.onDetach()
    }

    override fun ContentDrawScope.draw() {
        val frame = firstRunPreviewSearchShadowFrame(size.width, size.height, density)
        val image = frame?.let { raster.imageFor(it) }
        if (frame != null && image != null) {
            if (raster.stretched) {
                val column = image.width / 2
                drawImage(
                    image,
                    srcOffset = IntOffset(column, 0),
                    srcSize = IntSize(1, image.height),
                    dstOffset = IntOffset((-frame.padPx).roundToInt(), (-frame.padPx).roundToInt()),
                    dstSize = IntSize(frame.bitmapWidthPx, frame.bitmapHeightPx),
                    filterQuality = FilterQuality.None,
                )
            } else {
                drawImage(image, topLeft = Offset(-frame.padPx, -frame.padPx))
            }
        }
        drawContent()
    }
}

private const val SHADE_BITMAP_LIMIT = 8192

private class WelcomePreviewSearchShadeRaster {
    private var bitmap: Bitmap? = null
    private var image: ImageBitmap? = null
    private var key: String = ""
    var stretched: Boolean = false
        private set

    fun imageFor(frame: FirstRunPreviewSearchShadowFrame): ImageBitmap? {
        val direct = frame.bitmapWidthPx <= SHADE_BITMAP_LIMIT && frame.bitmapHeightPx <= SHADE_BITMAP_LIMIT
        val source = if (direct) frame else sampleFrame(frame) ?: return null
        return obtain(source, stretch = !direct)
    }

    fun clear() {
        image = null
        bitmap?.recycle()
        bitmap = null
        key = ""
        stretched = false
    }

    private fun obtain(frame: FirstRunPreviewSearchShadowFrame, stretch: Boolean): ImageBitmap? {
        val token = "$stretch|${frame.bitmapWidthPx}|${frame.bitmapHeightPx}|${frame.shapeLeftPx}|${frame.shapeTopPx}|${frame.shapeRightPx}|${frame.shapeBottomPx}|${frame.radiusPx}|${frame.blurPx}|${frame.color}"
        val existing = image
        if (token == key && existing != null && bitmap?.isRecycled == false) {
            stretched = stretch
            return existing
        }
        clear()
        val next = render(frame) ?: return null
        bitmap = next
        val wrapped = next.asImageBitmap()
        image = wrapped
        key = token
        stretched = stretch
        return wrapped
    }

    private fun sampleFrame(frame: FirstRunPreviewSearchShadowFrame): FirstRunPreviewSearchShadowFrame? {
        if (FIRST_RUN_PREVIEW_SEARCH_SHADOW_BLUR_DP == 0) return null
        val heightPx = frame.shapeBottomPx - frame.shapeTopPx
        val density = frame.blurPx / FIRST_RUN_PREVIEW_SEARCH_SHADOW_BLUR_DP
        val sampleWidth = (frame.blurPx * 8f).coerceIn(64f, 720f)
        val sample = firstRunPreviewSearchShadowFrame(sampleWidth, heightPx, density) ?: return null
        if (sample.bitmapWidthPx > SHADE_BITMAP_LIMIT || sample.bitmapHeightPx > SHADE_BITMAP_LIMIT) return null
        return sample
    }

    private fun render(frame: FirstRunPreviewSearchShadowFrame): Bitmap? {
        if (frame.bitmapWidthPx !in 1..SHADE_BITMAP_LIMIT || frame.bitmapHeightPx !in 1..SHADE_BITMAP_LIMIT) return null
        val image = try {
            Bitmap.createBitmap(frame.bitmapWidthPx, frame.bitmapHeightPx, Bitmap.Config.ARGB_8888)
        } catch (_: OutOfMemoryError) {
            return null
        }
        return try {
            val software = android.graphics.Canvas(image)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            paint.color = frame.color
            paint.maskFilter = BlurMaskFilter(frame.blurPx, BlurMaskFilter.Blur.NORMAL)
            val width = frame.shapeRightPx - frame.shapeLeftPx
            val height = frame.shapeBottomPx - frame.shapeTopPx
            val radius = frame.radiusPx.coerceAtLeast(0f).coerceAtMost(min(width, height) / 2f)
            val path = Path()
            path.addRoundRect(
                frame.shapeLeftPx,
                frame.shapeTopPx,
                frame.shapeRightPx,
                frame.shapeBottomPx,
                floatArrayOf(radius, radius, radius, radius, radius, radius, radius, radius),
                Path.Direction.CW,
            )
            software.drawPath(path, paint)
            image
        } catch (_: OutOfMemoryError) {
            image.recycle()
            null
        }
    }
}
