@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronLeft
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.*
import ch.fasrv.fanotes.schulnetz.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.*
import kotlinx.coroutines.delay

@Composable
/** Times Heute and Planer on the main thread. Recording stays off until diagnostic mode is on. */
private inline fun <T> traceAgenda(name: String, block: () -> T): T {
    if (!DiagnosticTrace.enabled) return block()
    val main = android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
    val started = System.nanoTime()
    return try {
        val value = DiagnosticTrace.span("tab", name, block)
        if (main) {
            val elapsed = (System.nanoTime() - started) / 1_000_000L
            if (elapsed >= DiagnosticTrace.STALL_MS) DiagnosticTrace.record("main", name, elapsed, "slow")
        }
        value
    } catch (error: Throwable) {
        if (main) DiagnosticTrace.record("main", name, (System.nanoTime() - started) / 1_000_000L, "error", error.javaClass.simpleName)
        throw error
    }
}

fun rememberNow(): Instant {
    val now by produceState(Instant.now()) { while (true) { delay(30_000); value = Instant.now() } }
    return now
}

@Composable
fun TodayScreen(model: CompanionModel) {
    val now = rememberNow()
    val zone = ZoneId.systemDefault()
    val today = now.atZone(zone).toLocalDate()
    val sync by model.graph.engine.state.collectAsStateWithLifecycle()
    val cards = shownTodayCards(model.desk)
    val agenda = remember(model.snapshot, model.calendar, model.tasks, model.hidden, today) {
        traceAgenda("today") {
            agendaForDays((0L..14L).map { today.plusDays(it) }, model.snapshot, model.calendar, model.tasks, model.hidden, zone).values.flatten()
        }
    }
    val next = if ("lessons" in cards) nextCommitment(agenda, now, zone) else null
    val urgent = sortHomeworkTasks(model.tasks.filter { !it.done }).sortedBy { when (taskBucket(it, today)) { "Overdue" -> 0; "Today" -> 1; "Upcoming" -> 2; else -> 3 } }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    val recent = remember(model.tree) { flattenNotes(model.tree).sortedByDescending { it.modifiedAt }.take(3) }
    ScreenList {
        item {
            Text(dateLabel(today), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val firstName = model.snapshot.profile?.firstName.orEmpty()
            Text(if (firstName.isNotBlank()) t(R.string.hello, firstName) else t(R.string.a_little_more_in_focus), style = MaterialTheme.typography.headlineMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
        }
        if (!model.notesAccount && !model.link.linked && model.snapshot.fetchedAt.isBlank() && !model.link.needsReauth) item {
            Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Column(Modifier.padding(20.dp)) {
                    Text(t(R.string.your_school_day), style = MaterialTheme.typography.titleLarge)
                    Text(t(R.string.connect_schulnetz_to_see_grades_the_timetable_ex), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 8.dp, bottom = 16.dp))
                    Button(onClick = { model.requestVisibleLogin("today") }, enabled = !model.busy) { Text(t(R.string.connect_schulnetz)) }
                }
            }
        }
        val syncCopy = faNotesSyncCopy(sync.status, model.notesAccount)
        if (model.link.needsReauth) item { InfoBanner(t(R.string.reconnect_your_school), t(R.string.your_last_school_data_is_still_here), t(R.string.sign_in), onAction = { model.navigate(Page.Connections) }) }
        else if (syncCopy != null) item {
            InfoBanner(t(syncCopy.first), t(syncCopy.second), t(R.string.account_sync), error = syncCopy.third, onAction = { model.navigate(Page.Connections) })
        }
        if ("lessons" in cards) item {
            if (next != null) {
                Surface(onClick = { selected = next }, color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (next.day == today) t(R.string.up_next) else dueLabel(next.day.toString()).uppercase(AppLanguage.formatLocale()), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                            Icon(Icons.Outlined.ArrowOutward, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        }
                        Text(courseAlias(next.title, model.desk.courseAliases), style = MaterialTheme.typography.headlineSmall, maxLines = 3, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
                        Text(listOf(next.time, next.detail).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
                        if (next.school?.isSubstitution() == true) Tag(t(R.string.substitution), LocalCompanionSemantics.current.warning)
                    }
                }
            } else {
                Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large) {
                    Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Icon(Icons.Outlined.WbSunny, null, tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f)) {
                            Text(t(R.string.room_to_breathe), style = MaterialTheme.typography.titleMedium)
                            Text(t(R.string.no_upcoming_commitments_in_your_planner), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            TextButton(onClick = { model.openPlanner() }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.open_today_s_schedule), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis); Spacer(Modifier.width(6.dp)); Icon(Icons.Outlined.ChevronRight, t(R.string.open_schedule), Modifier.size(16.dp)) }
        }
        if ("tasks" in cards) {
            item { SectionLabel(t(R.string.on_your_list), if (urgent.isEmpty()) t(R.string.tasks) else t(R.string.all_2, urgent.size)) { model.openPlanner(true) } }
            if (urgent.isEmpty()) item {
                Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Icons.Outlined.CheckCircleOutline, null, tint = LocalCompanionSemantics.current.success)
                    Text(t(R.string.you_re_all_caught_up), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
            items(urgent.take(3), key = { "today-task:${it.id}" }) { item -> TaskRow(item, today, { model.toggleTask(item) }) { task = item } }
            if (model.snapshot.homework.isNotEmpty()) item { TextButton(onClick = { model.openPlanner(true); model.taskSource = "school" }) { Text(tp(R.plurals.assignments_review, model.snapshot.homework.size, model.snapshot.homework.size)) } }
        }
        if (model.notesAccount) {
            item { SectionLabel(t(R.string.pick_up_a_note), t(R.string.library)) { model.select(Destination.Notes) } }
            if (recent.isEmpty()) item { Text(t(R.string.your_notes_will_be_waiting_here_capture_an_idea), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
            items(recent, key = { "recent:${it.path}" }) { node -> NoteRow(model, node) { model.openNote(node.path) } }
        }
        if ("exam" in cards) {
            val exam = nextCommitment(agenda.filter { it.kind == AgendaKind.Exam && it.key != next?.key }, now, zone)
            if (exam != null) {
                item { SectionLabel(t(R.string.coming_into_view)) }
                item { AgendaRow(model, exam) { selected = exam } }
            }
        }
        if ("grades" in cards && model.snapshot.grades.isNotEmpty()) item {
            SectionLabel(t(R.string.from_school))
            val gradeCourses = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook)) }
            SettingRow(Icons.Outlined.Insights, t(R.string.your_grades), tp(R.plurals.subjects_review, gradeCourses.size, gradeCourses.size)) { model.navigate(Page.Grades) }
        }
        if ("pluspunkte" in cards && model.desk.showPluspunkte && model.snapshot.grades.isNotEmpty()) item {
            val total = remember(model.snapshot.grades, model.gradeBook, model.unrevealedIds, model.settings.guessGrades) { promotionTotals(activeCourses(courseSummaries(model.snapshot.grades, hiddenTargetIds = model.hiddenGradeIds(), book = model.gradeBook))) }
            Text(t(R.string.promotion_points, uiPlus(total.total)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
        if ("events" in cards && (model.snapshot.messages.isNotEmpty() || model.snapshot.startMessages.isNotEmpty())) item {
            SettingRow(Icons.Outlined.NotificationsNone, t(R.string.school_updates), tp(R.plurals.messages_announcements, model.snapshot.messages.size + model.snapshot.startMessages.size, model.snapshot.messages.size + model.snapshot.startMessages.size)) { model.navigate(Page.Updates) }
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
    task?.let { TaskForm(model, it) { task = null } }
}

@Composable
fun PlannerScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp)) {
            listOf(t(R.string.schedule_tab), t(R.string.tasks)).forEachIndexed { index, title ->
                SegmentedButton(selected = model.plannerTasks == (index == 1), onClick = { model.plannerTasks = index == 1 }, shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(title) }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (model.plannerTasks) TasksScreen(model) else ScheduleScreen(model)
        }
    }
}

@Composable
private fun ScheduleScreen(model: CompanionModel) {
    var source by rememberSaveable { mutableStateOf("all") }
    var picker by remember { mutableStateOf(false) }
    var sourceMenu by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    val zone = ZoneId.systemDefault()
    val today = rememberNow().atZone(zone).toLocalDate()
    val days = schoolWeek(model.day, true)
    val agenda = remember(model.day, model.snapshot, model.calendar, model.tasks, model.hidden) {
        traceAgenda("schedule") {
            agendaForDays(days, model.snapshot, model.calendar, model.tasks, model.hidden, zone)
        }
    }
    val listState = rememberLazyListState()
    val dayKey = model.day.toString()
    // The last selected day and its scroll position are restored on purpose.
    // Changing the day must not keep the previous day's offset, which clips the new top row.
    var scrolledDay by rememberSaveable { mutableStateOf(dayKey) }
    LaunchedEffect(dayKey) {
        if (scrolledDay != dayKey) {
            scrolledDay = dayKey
            listState.scrollToItem(0)
        }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val compact = maxHeight < 350.dp
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ChevronLeft, if (compact) t(R.string.previous_day) else t(R.string.previous_week)) { model.day = if (compact) model.day.minusDays(1) else model.day.minusWeeks(1) }
            TextButton(onClick = { picker = true }, modifier = Modifier.weight(1f)) {
                Text(formatSchoolDate(model.day, if (compact) "EEE, d MMM" else "MMMM yyyy"), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(18.dp))
            }
            if (compact) Box {
                ActionIcon(Icons.Outlined.FilterList, t(R.string.schedule_sources, source)) { sourceMenu = true }
                DropdownMenu(sourceMenu, { sourceMenu = false }) {
                    listOf("all" to t(R.string.all_entries), "school" to t(R.string.school), "personal" to t(R.string.personal), "due" to t(R.string.deadlines)).forEach { (id, label) ->
                        DropdownMenuItem(text = { Text(label) }, leadingIcon = { if (source == id) Icon(Icons.Outlined.Check, null) }, onClick = { source = id; sourceMenu = false })
                    }
                }
            }
            TextButton(onClick = { model.day = today; model.planWeek = false }) { Text(t(R.string.today)) }
            ActionIcon(Icons.Outlined.ChevronRight, if (compact) t(R.string.next_day) else t(R.string.next_week)) { model.day = if (compact) model.day.plusDays(1) else model.day.plusWeeks(1) }
        }
        if (!compact) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Space.page), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            days.forEach { day ->
                val chosen = day == model.day
                Column(Modifier.widthIn(min = 44.dp).clip(MaterialTheme.shapes.medium).background(if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.background)
                    .clickable { model.day = day; model.planWeek = false }
                    .semantics { contentDescription = dateLabel(day); this.selected = chosen }
                    .padding(vertical = 8.dp, horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(day.dayOfWeek.getDisplayName(java.time.format.TextStyle.NARROW, AppLanguage.formatLocale()), style = MaterialTheme.typography.labelMedium,
                        color = if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(day.dayOfMonth.toString(), style = MaterialTheme.typography.titleMedium, color = if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
                    Box(Modifier.padding(top = 4.dp).size(4.dp).background(if (agenda[day].orEmpty().isNotEmpty()) { if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.primary } else androidx.compose.ui.graphics.Color.Transparent, CircleShape))
                }
            }
        }
        ChoiceRow(listOf("all" to t(R.string.all), "school" to t(R.string.school), "personal" to t(R.string.personal), "due" to t(R.string.deadlines)), source, { source = it }, Modifier.padding(horizontal = Space.page, vertical = 4.dp))
        }
        FineDivider()
        // weight keeps the list in the space under the week header. fillMaxSize alone
        // extends past the screen, so the bottom padding never clears "Neuer Termin".
        ScreenList(Modifier.weight(1f).pointerInput(compact, model.day) {
            var drag = 0f
            detectHorizontalDragGestures(
                onHorizontalDrag = { _, amount -> drag += amount },
                onDragEnd = {
                    val threshold = 72.dp.toPx()
                    if (drag <= -threshold) model.day = if (compact) model.day.plusDays(1) else model.day.plusWeeks(1)
                    else if (drag >= threshold) model.day = if (compact) model.day.minusDays(1) else model.day.minusWeeks(1)
                    drag = 0f
                },
                onDragCancel = { drag = 0f },
            )
        }, listState) {
            item { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(if (model.planWeek) t(R.string.this_week) else dateLabel(model.day), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { model.planWeek = !model.planWeek }) { Text(if (model.planWeek) t(R.string.day_view) else t(R.string.week_view)) }
            } }
            val shownDays = if (model.planWeek) days.filter { model.desk.showWeekend || it.dayOfWeek.value < 6 || agenda[it].orEmpty().isNotEmpty() } else listOf(model.day)
            shownDays.forEach { day ->
                val entries = agenda[day].orEmpty().filter { entry -> when (source) { "school" -> entry.school != null; "personal" -> entry.local != null; "due" -> entry.kind == AgendaKind.Task || entry.kind == AgendaKind.Exam; else -> true } }
                    .filter { it.school == null || !it.school.isLesson() || eventInHours(it.school, model.desk.dayStartHour, model.desk.dayEndHour, zone) }
                if (model.planWeek) item(key = "date:$day") { SectionLabel(dateLabel(day)) }
                if (entries.isEmpty()) item(key = "empty:$day") {
                    if (model.planWeek) Text(t(R.string.no_commitments), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                    else EmptyState(Icons.Outlined.EventAvailable, t(R.string.a_clear_day), if (source == "school" && model.snapshot.fetchedAt.isBlank()) t(R.string.connect_schulnetz_in_settings_to_see_your_lesson) else when (source) { "school" -> t(R.string.no_school_entries_for_date); "personal" -> t(R.string.no_personal_entries_for_date); "due" -> t(R.string.no_deadline_entries_for_date); else -> t(R.string.no_entries_for_date) })
                }
                items(entries, key = { it.key }) { entry -> AgendaRow(model, entry) { selected = entry } }
            }
            if (model.snapshot.readErrors.any { it.startsWith("Stundenplan:") }) item { InfoBanner(t(R.string.timetable_unavailable), t(R.string.the_last_school_refresh_could_not_read_the_timet), t(R.string.connection_details), onAction = { model.navigate(Page.Connections) }) }
        }
    }
    }
    if (picker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = model.day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { picker = false }, confirmButton = { TextButton(onClick = { state.selectedDateMillis?.let { model.day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }; picker = false }) { Text(t(R.string.go_to_date)) } }, dismissButton = { TextButton(onClick = { picker = false }) { Text(t(R.string.cancel)) } }) { DatePicker(state) }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
}

@Composable
fun AgendaRow(model: CompanionModel, entry: AgendaEntry, onClick: () -> Unit) {
    val highlighted = entry.school?.let { lessonTargetId(it) in model.highlightIds } == true
    val cancelled = entry.school?.isCancelled() == true
    val accent = when (entry.kind) {
        AgendaKind.Exam -> LocalCompanionSemantics.current.warning
        AgendaKind.Task -> MaterialTheme.colorScheme.primary
        else -> entry.school?.let { paletteColor(it.displayColor(model.colors)) } ?: MaterialTheme.colorScheme.primary
    }
    Column {
        Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).background(if (highlighted) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onClick).padding(vertical = if (model.desk.planCompact) 10.dp else 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.width(54.dp)) {
                Text(entry.start.ifBlank { if (entry.kind == AgendaKind.Task) t(R.string.due) else t(R.string.all_day) }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (entry.end.isNotBlank() && entry.end != entry.start) Text(entry.end, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(Modifier.width(3.dp).height(40.dp).background(if (cancelled) MaterialTheme.colorScheme.error else accent, CircleShape))
            Column(Modifier.weight(1f)) {
                Text(courseAlias(entry.title, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium,
                    textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (cancelled) Text(t(R.string.cancelled), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                else if (entry.school?.isSubstitution() == true) Text(t(R.string.substitution), style = MaterialTheme.typography.labelMedium, color = LocalCompanionSemantics.current.warning)
                else if (entry.kind != AgendaKind.Lesson) Text(entry.kind.uiLabel(), style = MaterialTheme.typography.labelSmall, color = accent)
            }
            Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        FineDivider()
    }
}

@Composable
fun TaskRow(task: HomeworkTask, today: LocalDate, onToggle: () -> Unit, onOpen: () -> Unit) {
    val overdue = taskBucket(task, today) == "Overdue"
    val haptic = LocalHapticFeedback.current
    Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(role = Role.Button, onClick = onOpen).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = task.done, onCheckedChange = {
            haptic.performHapticFeedback(if (task.done) HapticFeedbackType.ToggleOff else HapticFeedbackType.ToggleOn)
            onToggle()
        }, modifier = Modifier.semantics { contentDescription = t(R.string.text, if (task.done) t(R.string.reopen) else t(R.string.complete_action), task.title) })
        Column(Modifier.weight(1f).padding(start = 4.dp, end = 8.dp)) {
            Text(task.title, style = MaterialTheme.typography.bodyLarge, textDecoration = if (task.done) TextDecoration.LineThrough else TextDecoration.None, color = if (task.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(listOf(task.subject, dueLabel(task.dueDate), task.dueTime.orEmpty()).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            if (task.notes.isNotBlank()) Text(plainPreview(task.notes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (task.priority == "high") Icon(Icons.Outlined.Flag, t(R.string.important), Modifier.size(18.dp), tint = LocalCompanionSemantics.current.warning)
    }
    FineDivider()
}

@Composable
private fun TasksScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    var schoolTask by remember { mutableStateOf<SchoolHomework?>(null) }
    val today = rememberNow().atZone(ZoneId.systemDefault()).toLocalDate()
    Column(Modifier.fillMaxSize()) {
        SearchField(query, { query = it }, t(R.string.find_an_assignment), Modifier.padding(horizontal = Space.page, vertical = 8.dp))
        ChoiceRow(listOf("open" to t(R.string.open), "done" to t(R.string.completed), "school" to t(R.string.from_school)), model.taskSource, { model.taskSource = it }, Modifier.padding(horizontal = Space.page))
        ScreenList(Modifier.weight(1f)) {
            if (model.taskSource == "school") {
                item { Text(t(R.string.school_assignments_are_read_only_add_one_to_your), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                val tasks = model.snapshot.homework.filter { "${it.title} ${it.courseName} ${it.description}".contains(query, true) }.sortedBy { it.dueDate }
                if (tasks.isEmpty()) item { EmptyState(Icons.AutoMirrored.Outlined.Assignment, t(R.string.no_school_assignments), if (query.isNotBlank()) t(R.string.try_another_search) else t(R.string.assignments_appear_after_a_school_refresh_when_y)) }
                items(tasks, key = { "school-task:${it.id}" }) { item ->
                    Column(Modifier.fillMaxWidth().clickable { schoolTask = item }.padding(vertical = 16.dp)) {
                        Text(item.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text(listOf(item.courseName, dueLabel(item.dueDate)).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }) Tag(t(R.string.added_to_tasks))
                    }
                    FineDivider()
                }
            } else {
                val tasks = sortHomeworkTasks(model.tasks).filter { it.done == (model.taskSource == "done") && "${it.title} ${it.subject} ${it.notes}".contains(query, true) }
                if (tasks.isEmpty()) item { EmptyState(Icons.Outlined.CheckCircleOutline, if (query.isNotBlank()) t(R.string.nothing_matches_2) else if (model.taskSource == "done") t(R.string.a_fresh_start) else t(R.string.nothing_left_on_your_list), if (query.isNotBlank()) t(R.string.try_a_subject_or_a_shorter_search) else if (model.taskSource == "done") t(R.string.finished_tasks_will_be_kept_here) else t(R.string.add_homework_with_new_task_or_review_assignments)) }
                listOf("Overdue", "Today", "Upcoming", "No due date", "Completed").forEach { bucket ->
                    val group = tasks.filter { taskBucket(it, today) == bucket }
                    if (group.isNotEmpty()) {
                        item(key = "bucket:$bucket") { SectionLabel(t(R.string.bucket_count, bucketLabel(bucket), group.size)) }
                        items(group, key = { "task:${it.id}" }) { item -> TaskRow(item, today, { model.toggleTask(item) }) { task = item } }
                    }
                }
            }
        }
    }
    task?.let { TaskForm(model, it) { task = null } }
    schoolTask?.let { item ->
        ModalBottomSheet(onDismissRequest = { schoolTask = null }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).sheetKeyboardPadding().padding(horizontal = Space.page).padding(bottom = Space.xl)) {
                SheetTitle(item.title) { schoolTask = null }
                Tag(t(R.string.schulnetz_read_only))
                Text("${item.courseName} · ${dueLabel(item.dueDate)}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 12.dp))
                Text(item.description, style = MaterialTheme.typography.bodyLarge)
                val imported = model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }
                Button(onClick = { model.importHomework(item.title, item.courseName, item.dueDate, item.description); schoolTask = null }, enabled = !imported, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) { Text(if (imported) t(R.string.already_in_your_tasks) else t(R.string.add_to_my_tasks)) }
            }
        }
    }
}

@Composable
fun AgendaDetails(model: CompanionModel, entry: AgendaEntry, onDismiss: () -> Unit) {
    var edit by remember { mutableStateOf(false) }
    if (entry.task != null) { TaskForm(model, entry.task, onDismiss); return }
    if (edit && entry.local != null) { EventForm(model, entry.local, onDismiss); return }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).sheetKeyboardPadding().padding(horizontal = Space.page).padding(bottom = Space.xl)) {
            SheetTitle(courseAlias(entry.title, model.desk.courseAliases), onDismiss)
            Tag(if (entry.school != null) t(R.string.schulnetz_kind, entry.kind.uiLabel()) else t(R.string.app_name))
            val schoolStart = entry.school?.start.orEmpty()
            Text(if (entry.school != null && !examHasDate(schoolStart)) t(R.string.no_due_date) else dateLabel(entry.day), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 20.dp))
            Text(entry.time, style = MaterialTheme.typography.bodyLarge)
            if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
            val description = entry.school?.comment ?: entry.local?.notes.orEmpty()
            if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 16.dp))
            if (entry.school?.isCancelled() == true) Text(t(R.string.this_lesson_is_cancelled), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
            if (entry.local != null) {
                Button(onClick = { edit = true }, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) { Text(t(R.string.edit_event)) }
                if (entry.local.notePath.isNotBlank()) TextButton(onClick = { onDismiss(); model.openNote(entry.local.notePath) }, modifier = Modifier.fillMaxWidth()) { Text(t(R.string.open_linked_note)) }
            }
            if (entry.school != null && entry.kind == AgendaKind.Exam) {
                val imported = model.calendar.events.any { it.id == "schulnetz-${entry.school.id}" }
                Button(onClick = { model.importExam(entry.school); onDismiss() }, enabled = !imported, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
                    Text(if (imported) t(R.string.already_in_your_calendar) else t(R.string.add_to_my_calendar))
                }
            }
            if (entry.school?.isLesson() == true && entry.kind == AgendaKind.Lesson) {
                SectionLabel(t(R.string.personal_timetable))
                Text(t(R.string.hidden_lessons_can_be_restored_in_planning_setti), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { model.hideLesson(entry.school, false); onDismiss() }) { Text(t(R.string.hide_this_lesson)) }
                TextButton(onClick = { model.hideLesson(entry.school, true); onDismiss() }) { Text(t(R.string.hide_this_weekly_lesson)) }
            }
        }
    }
}
