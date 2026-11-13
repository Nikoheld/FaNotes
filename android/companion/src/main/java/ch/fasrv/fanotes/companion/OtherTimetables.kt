package ch.fasrv.fanotes.companion

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.EventBusy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.schulnetz.ClassTimetableSummary
import ch.fasrv.fanotes.schulnetz.ClassWeek
import ch.fasrv.fanotes.schulnetz.RoomWeek
import ch.fasrv.fanotes.schulnetz.TimetableCell
import ch.fasrv.fanotes.schulnetz.classWeekCells
import ch.fasrv.fanotes.schulnetz.roomWeekCells

/** The user's look of the own timetable (subject colours, course aliases, compact rows), applied to other weeks too. */
data class TimetableLook(val colors: Map<String, String> = emptyMap(), val aliases: Map<String, String> = emptyMap(), val compact: Boolean = false)

/**
 * Other classes and rooms of the Alte Kanti, from the school's timetable PDF (read by the server,
 * shown only to Alte Kanti users). A class or a room opens its week in the design of the own timetable.
 */
@Composable
fun OtherTimetablesScreen(graph: CompanionGraph, summary: ClassTimetableSummary, look: TimetableLook = TimetableLook(), onClose: () -> Unit) {
    var segment by rememberSaveable { mutableStateOf(if (summary.classes.isNotEmpty()) "classes" else "rooms") }
    var openClass by rememberSaveable { mutableStateOf<String?>(null) }
    var openRoom by rememberSaveable { mutableStateOf<String?>(null) }
    val inDetail = openClass != null || openRoom != null
    // Shown through local state, not a Page: it must always consume back while it is composed.
    BackHandler { if (inDetail) { openClass = null; openRoom = null } else onClose() }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = Space.page - 4.dp, end = Space.page), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ChevronLeft, if (inDetail) t(R.string.back_to_list) else t(R.string.back_to_schedule)) { if (inDetail) { openClass = null; openRoom = null } else onClose() }
            Text(openClass ?: openRoom ?: t(R.string.other_classes_rooms), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).semantics { heading() })
        }
        if (!inDetail) {
            SegmentedTabs(listOf("classes" to t(R.string.classes_segment), "rooms" to t(R.string.rooms_segment)), segment, { segment = it }, Modifier.padding(horizontal = Space.page, vertical = 6.dp))
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(horizontal = Space.page, vertical = 4.dp)) {
                if (segment == "classes") {
                    items(summary.classes, key = { "c:" + it.code }) { entry ->
                        ListRow(entry.code, entry.teacher) { openClass = entry.code }
                    }
                } else {
                    items(summary.rooms, key = { "r:$it" }) { room -> ListRow(room, "") { openRoom = room } }
                }
                item(key = "source") {
                    Text(t(R.string.other_timetables_source, summary.semester), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = Space.md))
                }
            }
        } else openClass?.let { code ->
            ClassPage(graph, summary, code, look)
        } ?: openRoom?.let { room -> RoomPage(graph, room, look) }
    }
}

@Composable
private fun ListRow(title: String, detail: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = Space.row).clickable(role = Role.Button, onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = Space.sm))
        Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider(color = LocalCompanionSemantics.current.hairline)
}

/** Another class or a room as a read-only week, drawn by the same rail rows as the own timetable. */
@Composable
fun OtherWeekView(cells: List<TimetableCell>, colors: Map<String, String>, aliases: Map<String, String>, compact: Boolean, placeIsClass: Boolean, header: String = "", modifier: Modifier = Modifier) {
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = Space.page, vertical = 4.dp)) {
        if (header.isNotBlank()) item(key = "header") {
            Text(header, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = Space.sm))
        }
        timetableCellItems(cells, colors, aliases, compact, placeIsClass)
    }
}

@Composable
private fun ClassPage(graph: CompanionGraph, summary: ClassTimetableSummary, code: String, look: TimetableLook) {
    var week by remember(code) { mutableStateOf<ClassWeek?>(null) }
    var failed by remember(code) { mutableStateOf(false) }
    LaunchedEffect(code, summary.uploadedAt) {
        failed = false
        week = null
        runCatching { graph.classTimetable(code) }.onSuccess { week = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; failed = true }
    }
    val teacher = summary.classes.firstOrNull { it.code == code }?.teacher.orEmpty()
    val loaded = week
    when {
        failed -> EmptyState(Icons.Outlined.EventBusy, t(R.string.other_timetables_failed), "")
        loaded == null -> SkeletonRows(4)
        loaded.lessons.isEmpty() -> Text(t(R.string.room_nothing_scheduled), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.page))
        else -> OtherWeekView(classWeekCells(loaded), look.colors, look.aliases, look.compact, placeIsClass = false, header = if (teacher.isNotBlank()) t(R.string.class_teacher_label, teacher) else "")
    }
}

@Composable
private fun RoomPage(graph: CompanionGraph, room: String, look: TimetableLook) {
    var week by remember(room) { mutableStateOf<RoomWeek?>(null) }
    var failed by remember(room) { mutableStateOf(false) }
    LaunchedEffect(room) {
        failed = false
        week = null
        runCatching { graph.roomTimetable(room) }.onSuccess { week = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; failed = true }
    }
    val loaded = week
    when {
        failed -> EmptyState(Icons.Outlined.EventBusy, t(R.string.other_timetables_failed), "")
        loaded == null -> SkeletonRows(4)
        loaded.lessons.isEmpty() -> Text(t(R.string.room_nothing_scheduled), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(Space.page))
        else -> OtherWeekView(roomWeekCells(loaded), look.colors, look.aliases, look.compact, placeIsClass = true)
    }
}
