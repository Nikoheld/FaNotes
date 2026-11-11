package ch.fasrv.fanotes.companion

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.TimetableCell
import ch.fasrv.fanotes.schulnetz.courseAlias
import ch.fasrv.fanotes.schulnetz.subjectColor
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

/** The shape of the node on the time rail. */
enum class RailNode { Lesson, Cancelled, Exam, Event, Task }

/**
 * One row of the timetable: time column, rail with a node, title, a meta line and tags.
 * The only place this design is drawn, used by the own timetable ([AgendaRow]) and by the
 * timetables of other classes and rooms ([timetableCellItems]), so the two cannot drift apart.
 */
@Composable
fun TimetableRailRow(
    start: String,
    end: String,
    title: String,
    meta: String,
    accent: Color,
    modifier: Modifier = Modifier,
    startIsClock: Boolean = true,
    dayLabel: String? = null,
    node: RailNode = RailNode.Lesson,
    position: RailPosition = RailPosition.Single,
    running: Boolean = false,
    highlighted: Boolean = false,
    compact: Boolean = false,
    tags: List<Pair<String, Color>> = emptyList(),
    onClick: (() -> Unit)? = null,
) {
    val scheme = MaterialTheme.colorScheme
    val line = LocalCompanionSemantics.current.hairline
    val highlight = if (highlighted || running) scheme.primaryContainer else Color.Transparent
    val cancelled = node == RailNode.Cancelled
    // The highlight bleeds 10 dp into the page gutter so the time rail never shifts sideways.
    Row(modifier.fillMaxWidth()
        .drawBehind {
            if (highlight != Color.Transparent) drawRoundRect(highlight, Offset(-10.dp.toPx(), 0f), Size(size.width + 20.dp.toPx(), size.height), androidx.compose.ui.geometry.CornerRadius(16.dp.toPx()))
            val x = (52 + 12 + 7).dp.toPx()
            val nodeY = (if (compact) 10.dp else 14.dp).toPx() + 11.dp.toPx()
            val stroke = 2.dp.toPx()
            if (position == RailPosition.Middle || position == RailPosition.Last) drawLine(line, Offset(x, 0f), Offset(x, nodeY), stroke)
            if (position == RailPosition.Middle || position == RailPosition.First) drawLine(line, Offset(x, nodeY), Offset(x, size.height), stroke)
            val r = 6.dp.toPx()
            when (node) {
                RailNode.Cancelled -> drawCircle(accent, r - stroke / 2, Offset(x, nodeY), style = Stroke(stroke))
                RailNode.Exam -> {
                    val path = Path().apply { moveTo(x, nodeY - r - 1f); lineTo(x + r + 1f, nodeY); lineTo(x, nodeY + r + 1f); lineTo(x - r - 1f, nodeY); close() }
                    drawPath(path, accent)
                }
                RailNode.Event -> drawCircle(accent, r - stroke / 2, Offset(x, nodeY), style = Stroke(stroke + 0.5f))
                RailNode.Task -> drawRect(accent, Offset(x - r + 1f, nodeY - r + 1f), Size((r - 1f) * 2, (r - 1f) * 2))
                RailNode.Lesson -> drawCircle(accent, r, Offset(x, nodeY))
            }
        }
        .let { if (onClick != null) it.clickable(onClick = onClick) else it }
        .heightIn(min = Space.row),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.width(52.dp).padding(top = if (compact) 10.dp else 14.dp), horizontalAlignment = Alignment.End) {
            if (dayLabel != null) Text(dayLabel, style = TimeSmallStyle, color = scheme.onSurfaceVariant, maxLines = 1)
            Text(start, style = if (startIsClock) TimeStyle else MaterialTheme.typography.labelMedium, softWrap = startIsClock, color = if (running) scheme.primary else scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (end.isNotBlank()) Text(end, style = TimeSmallStyle, color = scheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f).padding(vertical = if (compact) 10.dp else 14.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium,
                textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, color = if (cancelled) scheme.onSurfaceVariant else scheme.onSurface, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (meta.isNotBlank() && !compact) Text(meta, style = MaterialTheme.typography.bodySmall, color = scheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            if (tags.isNotEmpty()) Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) { tags.forEach { (label, color) -> Tag(label, color) } }
        }
    }
}

private fun cellMinutes(raw: String): Int? = runCatching { java.time.LocalTime.parse(raw.take(5)).let { it.hour * 60 + it.minute } }.getOrNull()

/**
 * Monday to Friday of a read-only week (another class or a room) in the design of the own timetable:
 * a day heading, then rail rows with subject, room (or class) and teacher, and free periods of 30 minutes or more.
 * [colors] are the user's subject colours, [aliases] the course aliases, so a subject looks the same as in their own plan.
 * [placeIsClass] is true for a room week, where the place column holds class codes instead of a room.
 */
fun LazyListScope.timetableCellItems(cells: List<TimetableCell>, colors: Map<String, String>, aliases: Map<String, String>, compact: Boolean, placeIsClass: Boolean, keyPrefix: String = "tt") {
    (1..5).forEach { day ->
        val dayCells = cells.filter { it.day == day }.sortedBy { it.start }
        if (dayCells.isEmpty()) return@forEach
        item(key = "$keyPrefix:d:$day") {
            Text(DayOfWeek.of(day).getDisplayName(TextStyle.FULL, Locale.getDefault()), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 24.dp, bottom = 6.dp).semantics { heading() })
        }
        var lastEnd: Int? = null
        dayCells.forEachIndexed { index, cell ->
            val start = cellMinutes(cell.start)
            val gap = if (lastEnd != null && start != null && start - lastEnd!! >= 30) start - lastEnd!! else 0
            if (gap > 0) item(key = "$keyPrefix:g:$day:${cell.start}") { GapRow(gap) }
            item(key = "$keyPrefix:c:$day:$index:${cell.start}:${cell.title}") {
                val place = if (placeIsClass) cell.place else cell.place.takeIf { it.isNotBlank() }?.let { t(R.string.room_named, it) }.orEmpty()
                TimetableRailRow(
                    start = cell.start, end = cell.end.takeIf { it.isNotBlank() && it != cell.start }.orEmpty(),
                    title = courseAlias(cell.title, aliases),
                    meta = listOf(place, cell.teacher).filter { it.isNotBlank() }.joinToString("  ·  "),
                    accent = paletteColor(subjectColor(cell.title, "", colors)),
                    position = railPosition(index, dayCells.size), compact = compact,
                )
            }
            cellMinutes(cell.end)?.let { lastEnd = maxOf(lastEnd ?: 0, it) }
        }
    }
}
