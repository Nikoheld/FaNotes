package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Paint
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
import ch.fasrv.fanotes.desk.BUG_REPORT_SHADOW_BLUR_DP
import ch.fasrv.fanotes.desk.BugReportShadowFrame
import ch.fasrv.fanotes.desk.bugReportShadowFrame
import kotlin.math.roundToInt

/**
 * `.settings-modal.bug-report-modal` box-shadow: `0 24px 80px rgba(0, 0, 0, .16)`.
 * Compose elevation is even on every side. The shifted rectangle is blurred
 * on a software bitmap, then drawn behind the dialog. A hardware canvas would
 * ignore [BlurMaskFilter], which is why the worksheet field uses the same split.
 */
fun Modifier.directionalBugReportShade(): Modifier = this.then(BugReportShadeElement)

private object BugReportShadeElement : ModifierNodeElement<BugReportShadeNode>() {
    override fun create(): BugReportShadeNode = BugReportShadeNode()
    override fun update(node: BugReportShadeNode) = Unit
    override fun equals(other: Any?): Boolean = other === this
    override fun hashCode(): Int = "directionalBugReportShade".hashCode()
}

private class BugReportShadeNode : Modifier.Node(), DrawModifierNode {
    private val raster = BugReportShadeRaster()

    override fun onDetach() {
        raster.clear()
        super.onDetach()
    }

    override fun ContentDrawScope.draw() {
        val frame = bugReportShadowFrame(size.width, size.height, density)
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

private class BugReportShadeRaster {
    private var bitmap: Bitmap? = null
    private var image: ImageBitmap? = null
    private var key: String = ""
    var stretched: Boolean = false
        private set

    fun imageFor(frame: BugReportShadowFrame): ImageBitmap? {
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

    private fun obtain(frame: BugReportShadowFrame, stretch: Boolean): ImageBitmap? {
        val token = "$stretch|${frame.bitmapWidthPx}|${frame.bitmapHeightPx}|${frame.shapeLeftPx}|${frame.shapeTopPx}|${frame.shapeRightPx}|${frame.shapeBottomPx}|${frame.blurPx}|${frame.color}"
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

    private fun sampleFrame(frame: BugReportShadowFrame): BugReportShadowFrame? {
        if (BUG_REPORT_SHADOW_BLUR_DP == 0) return null
        val heightPx = frame.shapeBottomPx - frame.shapeTopPx
        val density = frame.blurPx / BUG_REPORT_SHADOW_BLUR_DP
        val sampleWidth = (frame.blurPx * 8f).coerceIn(64f, 720f)
        val sample = bugReportShadowFrame(sampleWidth, heightPx, density) ?: return null
        if (sample.bitmapWidthPx > SHADE_BITMAP_LIMIT || sample.bitmapHeightPx > SHADE_BITMAP_LIMIT) return null
        return sample
    }

    private fun render(frame: BugReportShadowFrame): Bitmap? {
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
            software.drawRect(frame.shapeLeftPx, frame.shapeTopPx, frame.shapeRightPx, frame.shapeBottomPx, paint)
            image
        } catch (_: OutOfMemoryError) {
            image.recycle()
            null
        }
    }
}
