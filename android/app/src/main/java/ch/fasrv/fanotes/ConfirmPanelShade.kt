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
import ch.fasrv.fanotes.desk.ConfirmShadowFrame
import ch.fasrv.fanotes.desk.confirmShadowFrame
import kotlin.math.roundToInt

/**
 * `.confirm-dialog` box-shadow resolves to `0 12px 40px rgba(15, 15, 15, .08)`.
 * Compose elevation is even on every side. The shifted rectangle is blurred
 * on a software bitmap, then drawn behind the dialog. A hardware canvas would
 * ignore [BlurMaskFilter], which is why the worksheet field uses the same split.
 */
fun Modifier.directionalConfirmShade(themeId: String): Modifier = this.then(ConfirmShadeElement(themeId))

private data class ConfirmShadeElement(val themeId: String) : ModifierNodeElement<ConfirmShadeNode>() {
    override fun create(): ConfirmShadeNode = ConfirmShadeNode(themeId)
    override fun update(node: ConfirmShadeNode) {
        node.themeId = themeId
    }
}

private class ConfirmShadeNode(var themeId: String) : Modifier.Node(), DrawModifierNode {
    private val raster = ConfirmShadeRaster()

    override fun onDetach() {
        raster.clear()
        super.onDetach()
    }

    override fun ContentDrawScope.draw() {
        val frame = confirmShadowFrame(size.width, size.height, density, themeId)
        val image = frame?.let { raster.imageFor(it, themeId) }
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

private class ConfirmShadeRaster {
    private var bitmap: Bitmap? = null
    private var image: ImageBitmap? = null
    private var key: String = ""
    var stretched: Boolean = false
        private set

    fun imageFor(frame: ConfirmShadowFrame, themeId: String): ImageBitmap? {
        val direct = frame.bitmapWidthPx <= SHADE_BITMAP_LIMIT && frame.bitmapHeightPx <= SHADE_BITMAP_LIMIT
        val source = if (direct) frame else sampleFrame(frame, themeId) ?: return null
        return obtain(source, stretch = !direct)
    }

    fun clear() {
        image = null
        bitmap?.recycle()
        bitmap = null
        key = ""
        stretched = false
    }

    private fun obtain(frame: ConfirmShadowFrame, stretch: Boolean): ImageBitmap? {
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

    private fun sampleFrame(frame: ConfirmShadowFrame, themeId: String): ConfirmShadowFrame? {
        val shadow = ch.fasrv.fanotes.desk.confirmDialogShadow(themeId)
        if (shadow.blurDp == 0) return null
        val heightPx = frame.shapeBottomPx - frame.shapeTopPx
        val density = frame.blurPx / shadow.blurDp
        val sampleWidth = (frame.blurPx * 8f).coerceIn(64f, 720f)
        val sample = confirmShadowFrame(sampleWidth, heightPx, density, themeId) ?: return null
        if (sample.bitmapWidthPx > SHADE_BITMAP_LIMIT || sample.bitmapHeightPx > SHADE_BITMAP_LIMIT) return null
        return sample
    }

    private fun render(frame: ConfirmShadowFrame): Bitmap? {
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
