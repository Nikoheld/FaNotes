package ch.fasrv.fanotes

import android.graphics.Bitmap
import android.graphics.BlurMaskFilter
import android.graphics.Paint
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.node.invalidateDraw
import ch.fasrv.fanotes.desk.FirstRunPreviewGlowFrame
import ch.fasrv.fanotes.desk.firstRunPreviewGlowFrame

/**
 * `.first-run-preview-glow`: an accent ellipse behind the welcome window, blurred by 65px.
 * Compose blur needs a hardware effect that this minSdk does not guarantee, so the ellipse
 * is painted on a software bitmap the same way as the paper shadow.
 */
fun Modifier.welcomePreviewGlow(accentArgb: Int): Modifier = this.then(WelcomePreviewGlowElement(accentArgb))

private data class WelcomePreviewGlowElement(val accentArgb: Int) : ModifierNodeElement<WelcomePreviewGlowNode>() {
    override fun create(): WelcomePreviewGlowNode = WelcomePreviewGlowNode(accentArgb)

    override fun update(node: WelcomePreviewGlowNode) {
        if (node.accentArgb == accentArgb) return
        node.accentArgb = accentArgb
        node.invalidateDraw()
    }

    override fun equals(other: Any?): Boolean = other is WelcomePreviewGlowElement && other.accentArgb == accentArgb

    override fun hashCode(): Int = accentArgb
}

private class WelcomePreviewGlowNode(var accentArgb: Int) : Modifier.Node(), DrawModifierNode {
    private val raster = WelcomePreviewGlowRaster()

    override fun onDetach() {
        raster.clear()
        super.onDetach()
    }

    override fun ContentDrawScope.draw() {
        val frame = firstRunPreviewGlowFrame(size.width, size.height, density, accentArgb)
        val image = frame?.let { raster.imageFor(it) }
        if (frame != null && image != null) {
            drawImage(image, topLeft = Offset(-frame.padPx, -frame.padPx))
        }
        drawContent()
    }
}

private const val GLOW_BITMAP_LIMIT = 8192

private class WelcomePreviewGlowRaster {
    private var bitmap: Bitmap? = null
    private var image: ImageBitmap? = null
    private var key: String = ""

    fun imageFor(frame: FirstRunPreviewGlowFrame): ImageBitmap? {
        if (frame.bitmapWidthPx !in 1..GLOW_BITMAP_LIMIT || frame.bitmapHeightPx !in 1..GLOW_BITMAP_LIMIT) return null
        return obtain(frame)
    }

    fun clear() {
        image = null
        bitmap?.recycle()
        bitmap = null
        key = ""
    }

    private fun obtain(frame: FirstRunPreviewGlowFrame): ImageBitmap? {
        val token = "${frame.bitmapWidthPx}|${frame.bitmapHeightPx}|${frame.ovalLeftPx}|${frame.ovalTopPx}|${frame.ovalRightPx}|${frame.ovalBottomPx}|${frame.blurPx}|${frame.color}"
        val existing = image
        if (token == key && existing != null && bitmap?.isRecycled == false) return existing
        clear()
        val next = render(frame) ?: return null
        bitmap = next
        val wrapped = next.asImageBitmap()
        image = wrapped
        key = token
        return wrapped
    }

    private fun render(frame: FirstRunPreviewGlowFrame): Bitmap? {
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
            software.drawOval(frame.ovalLeftPx, frame.ovalTopPx, frame.ovalRightPx, frame.ovalBottomPx, paint)
            image
        } catch (_: OutOfMemoryError) {
            image.recycle()
            null
        }
    }
}
