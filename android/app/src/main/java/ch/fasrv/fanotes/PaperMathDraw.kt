package ch.fasrv.fanotes

import android.graphics.Canvas
import android.graphics.Paint
import ch.fasrv.fanotes.desk.MathNode

internal data class MathExtent(val width: Float, val ascent: Float, val descent: Float) {
    val height: Float get() = ascent + descent
}

internal fun measureMath(paint: Paint, node: MathNode, textSize: Float): MathExtent {
    val previous = paint.textSize
    val extent = measureNode(paint, node, textSize)
    paint.textSize = previous
    return extent
}

internal fun drawMath(canvas: Canvas, paint: Paint, node: MathNode, x: Float, baseline: Float, textSize: Float) {
    val previous = paint.textSize
    drawNode(canvas, paint, node, x, baseline, textSize)
    paint.textSize = previous
}

private fun measureNode(paint: Paint, node: MathNode, textSize: Float): MathExtent {
    paint.textSize = textSize
    return when (node) {
        is MathNode.Atom -> atomExtent(paint, node.text)
        is MathNode.Row -> {
            var width = 0f
            var ascent = 0f
            var descent = 0f
            node.parts.forEachIndexed { index, part ->
                width += operatorGap(part, textSize, index == 0)
                val box = measureNode(paint, part, textSize)
                width += box.width
                ascent = maxOf(ascent, box.ascent)
                descent = maxOf(descent, box.descent)
            }
            MathExtent(width, ascent, descent)
        }
        is MathNode.Script -> {
            val base = measureNode(paint, node.base, textSize)
            val scriptSize = textSize * SCRIPT
            val sup = node.sup?.let { measureNode(paint, it, scriptSize) }
            val sub = node.sub?.let { measureNode(paint, it, scriptSize) }
            val extraUp = if (sup == null) 0f else textSize * 0.42f
            val extraDown = if (sub == null) 0f else textSize * 0.28f
            MathExtent(
                base.width + maxOf(sup?.width ?: 0f, sub?.width ?: 0f),
                base.ascent + extraUp,
                base.descent + extraDown,
            )
        }
        is MathNode.Frac -> {
            val scale = textSize * 0.9f
            val num = measureNode(paint, node.num, scale)
            val den = measureNode(paint, node.den, scale)
            val gap = textSize * 0.18f
            val bar = (textSize / 16f).coerceAtLeast(1f)
            MathExtent(
                maxOf(num.width, den.width) + textSize * 0.45f,
                num.height + gap + bar / 2f,
                den.height + gap + bar / 2f,
            )
        }
        is MathNode.Radical -> {
            val body = measureNode(paint, node.body, textSize)
            MathExtent(
                textSize * 0.72f + body.width + textSize * 0.12f,
                body.ascent + textSize * 0.14f,
                body.descent,
            )
        }
    }
}

private fun drawNode(canvas: Canvas, paint: Paint, node: MathNode, x: Float, baseline: Float, textSize: Float) {
    paint.textSize = textSize
    when (node) {
        is MathNode.Atom -> if (node.text.isNotEmpty()) canvas.drawText(node.text, x, baseline, paint)
        is MathNode.Row -> {
            var cursor = x
            node.parts.forEachIndexed { index, part ->
                cursor += operatorGap(part, textSize, index == 0)
                drawNode(canvas, paint, part, cursor, baseline, textSize)
                cursor += measureNode(paint, part, textSize).width
            }
        }
        is MathNode.Script -> {
            val base = measureNode(paint, node.base, textSize)
            drawNode(canvas, paint, node.base, x, baseline, textSize)
            val scriptSize = textSize * SCRIPT
            node.sup?.let { sup ->
                val box = measureNode(paint, sup, scriptSize)
                drawNode(canvas, paint, sup, x + base.width, baseline - base.ascent * 0.55f - box.descent, scriptSize)
            }
            node.sub?.let { sub ->
                drawNode(canvas, paint, sub, x + base.width, baseline + base.descent + textSize * 0.08f, scriptSize)
            }
        }
        is MathNode.Frac -> {
            val scale = textSize * 0.9f
            val num = measureNode(paint, node.num, scale)
            val den = measureNode(paint, node.den, scale)
            val width = maxOf(num.width, den.width) + textSize * 0.45f
            val gap = textSize * 0.18f
            val bar = (textSize / 16f).coerceAtLeast(1f)
            drawNode(canvas, paint, node.num, x + (width - num.width) / 2f, baseline - gap - bar / 2f - num.descent, scale)
            drawNode(canvas, paint, node.den, x + (width - den.width) / 2f, baseline + gap + bar / 2f + den.ascent, scale)
            paint.textSize = textSize
            val previous = paint.strokeWidth
            paint.strokeWidth = bar
            canvas.drawLine(x, baseline, x + width, baseline, paint)
            paint.strokeWidth = previous
        }
        is MathNode.Radical -> {
            val body = measureNode(paint, node.body, textSize)
            val sign = textSize * 0.72f
            val top = baseline - body.ascent - textSize * 0.1f
            val previous = paint.strokeWidth
            paint.strokeWidth = (textSize / 16f).coerceAtLeast(1f)
            canvas.drawLine(x, baseline - body.ascent * 0.15f, x + sign * 0.35f, baseline + body.descent * 0.2f, paint)
            canvas.drawLine(x + sign * 0.35f, baseline + body.descent * 0.2f, x + sign * 0.62f, top, paint)
            canvas.drawLine(x + sign * 0.62f, top, x + sign + body.width + textSize * 0.08f, top, paint)
            paint.strokeWidth = previous
            drawNode(canvas, paint, node.body, x + sign, baseline, textSize)
        }
    }
}

private fun atomExtent(paint: Paint, text: String): MathExtent {
    if (text.isEmpty()) {
        val metrics = paint.fontMetrics
        return MathExtent(0f, -metrics.ascent, metrics.descent)
    }
    val metrics = paint.fontMetrics
    return MathExtent(paint.measureText(text), -metrics.ascent, metrics.descent)
}

private fun operatorGap(node: MathNode, textSize: Float, first: Boolean): Float {
    if (first) return 0f
    val text = (node as? MathNode.Atom)?.text ?: return textSize * 0.05f
    return if (text in BINARY_OPERATORS) textSize * 0.28f else textSize * 0.04f
}

private const val SCRIPT = 0.7f

private val BINARY_OPERATORS = setOf("+", "-", "=", "<", ">", "≤", "≥", "≠", "·", "×", "±", "∓", "≈", "≡", "→", "←")
