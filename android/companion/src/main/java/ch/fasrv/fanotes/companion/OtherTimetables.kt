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
import ch.fasrv.fanotes.schulnetz.RoomWeek
import ch.fasrv.fanotes.schulnetz.roomWeekByDay
import java.io.File
import java.time.DayOfWeek
import java.time.format.TextStyle
import java.util.Locale

/**
 * Other classes and rooms of the Alte Kanti, from the school's timetable PDF (kept on the server,
 * shown only to Alte Kanti users). Classes open the class page as PDF; rooms show their week.
 */
@Composable
fun OtherTimetablesScreen(graph: CompanionGraph, summary: ClassTimetableSummary, onClose: () -> Unit) {
    var segment by rememberSaveable { mutableStateOf(if (summary.classes.isNotEmpty()) "classes" else "rooms") }
    var openClass by rememberSaveable { mutableStateOf<String?>(null) }
    var openRoom by rememberSaveable { mutableStateOf<String?>(null) }
    val inDetail = openClass != null || openRoom != null
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
            ClassPage(graph, summary, code)
        } ?: openRoom?.let { room -> RoomPage(graph, room) }
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

@Composable
private fun ClassPage(graph: CompanionGraph, summary: ClassTimetableSummary, code: String) {
    var file by remember(code) { mutableStateOf<File?>(null) }
    var failed by remember(code) { mutableStateOf(false) }
    LaunchedEffect(code, summary.uploadedAt) {
        failed = false
        file = null
        runCatching { graph.classTimetableFile(code, summary.uploadedAt) }.onSuccess { file = it }.onFailure { if (it is kotlinx.coroutines.CancellationException) throw it; failed = true }
    }
    val teacher = summary.classes.firstOrNull { it.code == code }?.teacher.orEmpty()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.page)) {
        if (teacher.isNotBlank()) Text(t(R.string.class_teacher_label, teacher), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = Space.sm))
        when {
            failed -> EmptyState(Icons.Outlined.EventBusy, t(R.string.other_timetables_failed), "")
            file == null -> SkeletonRows(3)
            else -> PdfReader(file!!)
        }
    }
}

@Composable
private fun RoomPage(graph: CompanionGraph, room: String) {
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
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = Space.page, vertical = 4.dp)) {
            roomWeekByDay(loaded).filter { it.second.isNotEmpty() }.forEach { (day, slots) ->
                item(key = "d:$day") {
                    Text(DayOfWeek.of(day).getDisplayName(TextStyle.FULL, Locale.getDefault()), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = Space.lg, bottom = Space.xs).semantics { heading() })
                }
                items(slots, key = { "s:$day:${it.start}:${it.subject}:${it.teacher}" }) { slot ->
                    Row(Modifier.fillMaxWidth().padding(vertical = Space.sm), verticalAlignment = Alignment.Top) {
                        Text(slot.start, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(56.dp))
                        Column(Modifier.weight(1f)) {
                            Text(listOf(slot.subject, slot.teacher).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodyLarge)
                            if (slot.classes.isNotEmpty()) Text(slot.classes.joinToString(", "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
