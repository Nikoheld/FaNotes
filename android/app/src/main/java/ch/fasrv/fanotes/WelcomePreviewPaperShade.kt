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
import ch.fasrv.fanotes.desk.FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP
import ch.fasrv.fanotes.desk.FirstRunPreviewPaperShadowFrame
import ch.fasrv.fanotes.desk.firstRunPreviewPaperShadowFrame
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * `.first-run-preview-paper` box-shadow: `0 10px 30px rgba(0,0,0,.14)`.
 * Compose elevation is even on every side. The shifted rounded sheet is blurred
 * on a software bitmap, then drawn behind the paper. A hardware canvas would
 * ignore [BlurMaskFilter], which is why the worksheet field uses the same split.
 *
 * The sheet's parent `.first-run-preview-body` does not clip, so this draws outside
 * the paper. `.first-run-preview-window` is `overflow: hidden` and still cuts blur
 * that leaves the window. The subject column is left at its own size.
 */
fun Modifier.welcomePreviewPaperShade(): Modifier = this.then(WelcomePreviewPaperShadeElement)

private object WelcomePreviewPaperShadeElement : ModifierNodeElement<WelcomePreviewPaperShadeNode>() {
    override fun create(): WelcomePreviewPaperShadeNode = WelcomePreviewPaperShadeNode()
    override fun update(node: WelcomePreviewPaperShadeNode) = Unit
    override fun equals(other: Any?): Boolean = other === this
    override fun hashCode(): Int = "welcomePreviewPaperShade".hashCode()
}

private class WelcomePreviewPaperShadeNode : Modifier.Node(), DrawModifierNode {
    private val raster = WelcomePreviewPaperShadeRaster()

    override fun onDetach() {
        raster.clear()
        super.onDetach()
    }

    override fun ContentDrawScope.draw() {
        val frame = firstRunPreviewPaperShadowFrame(size.width, size.height, density)
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

private class WelcomePreviewPaperShadeRaster {
    private var bitmap: Bitmap? = null
    private var image: ImageBitmap? = null
    private var key: String = ""
    var stretched: Boolean = false
        private set

    fun imageFor(frame: FirstRunPreviewPaperShadowFrame): ImageBitmap? {
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

    private fun obtain(frame: FirstRunPreviewPaperShadowFrame, stretch: Boolean): ImageBitmap? {
        val token = "$stretch|${frame.bitmapWidthPx}|${frame.bitmapHeightPx}|${frame.shapeLeftPx}|${frame.shapeTopPx}|${frame.shapeRightPx}|${frame.shapeBottomPx}|${frame.topRadiusPx}|${frame.blurPx}|${frame.color}"
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

    private fun sampleFrame(frame: FirstRunPreviewPaperShadowFrame): FirstRunPreviewPaperShadowFrame? {
        if (FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP == 0) return null
        val heightPx = frame.shapeBottomPx - frame.shapeTopPx
        val density = frame.blurPx / FIRST_RUN_PREVIEW_PAPER_SHADOW_BLUR_DP
        val sampleWidth = (frame.blurPx * 8f).coerceIn(64f, 720f)
        val sample = firstRunPreviewPaperShadowFrame(sampleWidth, heightPx, density) ?: return null
        if (sample.bitmapWidthPx > SHADE_BITMAP_LIMIT || sample.bitmapHeightPx > SHADE_BITMAP_LIMIT) return null
        return sample
    }

    private fun render(frame: FirstRunPreviewPaperShadowFrame): Bitmap? {
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
            val radius = frame.topRadiusPx.coerceAtLeast(0f).coerceAtMost(min(width, height) / 2f)
            val path = Path()
            path.addRoundRect(
                frame.shapeLeftPx,
                frame.shapeTopPx,
                frame.shapeRightPx,
                frame.shapeBottomPx,
                floatArrayOf(radius, radius, radius, radius, 0f, 0f, 0f, 0f),
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
