package ch.fasrv.fanotes.companion

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ch.fasrv.fanotes.schulnetz.TrendPoint
import ch.fasrv.fanotes.schulnetz.formatGradeDate
import ch.fasrv.fanotes.schulnetz.trendDomain

/**
 * Compact chart of a subject's counted marks over time with the running weighted average.
 * [points] come from trendPoints(), so unrevealed and excluded marks never reach it.
 */
@Composable
fun GradeTrendChart(points: List<TrendPoint>, label: String, decimals: Int, modifier: Modifier = Modifier) {
    val scheme = MaterialTheme.colorScheme
    val semantics = LocalCompanionSemantics.current
    val measurer = rememberTextMeasurer()
    val axisStyle = TextStyle(color = scheme.onSurfaceVariant, fontSize = 11.sp)
    val markColor = scheme.onSurfaceVariant
    val runColor = scheme.primary
    val passColor = semantics.warning
    val grid = scheme.outlineVariant
    val average = points.lastOrNull()?.running
    val description = tp(R.plurals.trend_description, points.size, label, points.size, uiMark(average, decimals))
    Surface(color = scheme.surface, shape = MaterialTheme.shapes.extraLarge, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
            if (points.isEmpty()) {
                Text(t(R.string.trend_needs_marks), style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                return@Column
            }
            Canvas(Modifier.fillMaxWidth().height(150.dp).semantics { contentDescription = description }) {
                val (low, high) = trendDomain(points)
                val left = 26.dp.toPx(); val right = size.width - 8.dp.toPx(); val top = 8.dp.toPx(); val bottom = size.height - 20.dp.toPx()
                fun y(value: Double) = (bottom - ((value.coerceIn(low.toDouble(), high.toDouble()) - low) / (high - low)) * (bottom - top)).toFloat()
                val inset = minOf(14.dp.toPx(), (right - left) / 4f)
                val dayOf = points.map { runCatching { java.time.LocalDate.parse(it.date).toEpochDay() }.getOrNull() }
                val timed = points.size > 1 && dayOf.all { it != null } && dayOf.last()!! > dayOf.first()!!
                fun x(i: Int): Float {
                    if (points.size == 1) return (left + right) / 2f
                    val share = if (timed) (dayOf[i]!! - dayOf.first()!!).toFloat() / (dayOf.last()!! - dayOf.first()!!).toFloat() else i.toFloat() / (points.size - 1)
                    return left + inset + share * (right - left - inset * 2)
                }
                for (tick in low..high) {
                    val ty = y(tick.toDouble())
                    drawLine(grid, Offset(left, ty), Offset(right, ty), strokeWidth = 1.dp.toPx())
                    val text = measurer.measure(tick.toString(), axisStyle)
                    drawText(text, topLeft = Offset(left - 6.dp.toPx() - text.size.width, ty - text.size.height / 2f))
                }
                drawLine(passColor, Offset(left, y(4.0)), Offset(right, y(4.0)), strokeWidth = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f)))
                val first = formatGradeDate(points.first().date).takeIf { points.first().date.isNotBlank() }
                val last = formatGradeDate(points.last().date).takeIf { points.size > 1 && points.last().date.isNotBlank() }
                first?.let { drawText(measurer.measure(it, axisStyle), topLeft = Offset(left, size.height - 16.dp.toPx())) }
                last?.let { val m = measurer.measure(it, axisStyle); drawText(m, topLeft = Offset(right - m.size.width, size.height - 16.dp.toPx())) }
                val run = Path()
                points.forEachIndexed { i, p -> if (i == 0) run.moveTo(x(i), y(p.running)) else run.lineTo(x(i), y(p.running)) }
                if (points.size > 1) drawPath(run, runColor, style = Stroke(width = 2.5.dp.toPx(), cap = StrokeCap.Round))
                points.forEachIndexed { i, p ->
                    drawCircle(scheme.surface, 5.dp.toPx(), Offset(x(i), y(p.mark)))
                    drawCircle(markColor, 3.5.dp.toPx(), Offset(x(i), y(p.mark)))
                }
                drawCircle(runColor, 4.dp.toPx(), Offset(x(points.lastIndex), y(points.last().running)))
            }
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                LegendDot(markColor, t(R.string.grades))
                LegendDot(runColor, t(R.string.running_average))
                LegendDot(passColor, t(R.string.pass_mark_4))
            }
        }
    }
}

@Composable
private fun LegendDot(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, androidx.compose.foundation.shape.CircleShape))
        Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 5.dp))
    }
}
