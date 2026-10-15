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
    for (orb in ch.fasrv.fanotes.desk.backdropOrbs(kind)) {
        val center = Offset(size.width * orb.x, size.height * orb.y)
        val radius = ch.fasrv.fanotes.desk.farthestCorner(size.width, size.height, center.x, center.y)
        if (radius <= 0f) continue
        val color = (if (orb.secondary) secondary else accent).copy(alpha = orb.alpha)
        drawCircle(
            brush = Brush.radialGradient(
                colorStops = arrayOf(0f to color, orb.stop to Color.Transparent, 1f to Color.Transparent),
                center = center,
                radius = radius,
            ),
            radius = radius,
            center = center,
        )
    }
    if (kind != "paper") return@drawBehind
    val hair = 1.dp.toPx()
    val line = accent.copy(alpha = ch.fasrv.fanotes.desk.PAPER_LINE_ALPHA)
    val lineStep = ch.fasrv.fanotes.desk.PAPER_LINE_STEP.dp.toPx()
    var x = 0f
    while (x < size.width) {
        drawLine(line, Offset(x, 0f), Offset(x, size.height), strokeWidth = hair)
        x += lineStep
    }
    var y = 0f
    while (y < size.height) {
        drawLine(line, Offset(0f, y), Offset(size.width, y), strokeWidth = hair)
        y += lineStep
    }
    val dot = accent.copy(alpha = ch.fasrv.fanotes.desk.PAPER_DOT_ALPHA)
    val dotStep = ch.fasrv.fanotes.desk.PAPER_DOT_STEP.dp.toPx()
    val dotRadius = ch.fasrv.fanotes.desk.PAPER_DOT_RADIUS.dp.toPx()
    var dotY = dotStep / 2f
    while (dotY < size.height) {
        var dotX = dotStep / 2f
        while (dotX < size.width) {
            drawCircle(dot, dotRadius, Offset(dotX, dotY))
            dotX += dotStep
        }
        dotY += dotStep
    }
}
