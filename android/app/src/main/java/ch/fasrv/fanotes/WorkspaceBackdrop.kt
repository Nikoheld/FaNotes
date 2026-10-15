package ch.fasrv.fanotes

import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Desktop workspace backgrounds from `styles.css`: a flat field, an accent glow,
 * two soft orbs, or a faint grid.
 */
fun Modifier.workspaceBackdrop(kind: String, base: Color, accent: Color, secondary: Color): Modifier = drawBehind {
    drawRect(base)
    when (kind) {
        "gradient" -> drawCircle(
            brush = Brush.radialGradient(
                colors = listOf(accent.copy(alpha = 0.09f), Color.Transparent),
                center = Offset(size.width * 0.82f, size.height * -0.2f),
                radius = size.maxDimension * 0.55f,
            ),
            radius = size.maxDimension * 0.55f,
            center = Offset(size.width * 0.82f, size.height * -0.2f),
        )
        "mesh" -> {
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(accent.copy(alpha = 0.14f), Color.Transparent),
                    center = Offset(size.width * 0.09f, size.height * 0.04f),
                    radius = size.maxDimension * 0.42f,
                ),
                radius = size.maxDimension * 0.42f,
                center = Offset(size.width * 0.09f, size.height * 0.04f),
            )
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(secondary.copy(alpha = 0.13f), Color.Transparent),
                    center = Offset(size.width * 0.88f, size.height * 0.86f),
                    radius = size.maxDimension * 0.42f,
                ),
                radius = size.maxDimension * 0.42f,
                center = Offset(size.width * 0.88f, size.height * 0.86f),
            )
        }
        "paper" -> {
            val step = 24.dp.toPx()
            val line = accent.copy(alpha = 0.07f)
            var x = step
            while (x < size.width) {
                drawLine(line, Offset(x, 0f), Offset(x, size.height), strokeWidth = 1.dp.toPx())
                x += step
            }
            var y = step
            while (y < size.height) {
                drawLine(line, Offset(0f, y), Offset(size.width, y), strokeWidth = 1.dp.toPx())
                y += step
            }
        }
    }
}
