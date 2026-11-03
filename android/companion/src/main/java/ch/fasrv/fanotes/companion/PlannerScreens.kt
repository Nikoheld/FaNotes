@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package ch.fasrv.fanotes.companion

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ch.fasrv.fanotes.desk.*
import ch.fasrv.fanotes.schulnetz.*
import ch.fasrv.fanotes.sync.SyncStatus
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.time.*
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.delay

@Composable
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
        (0L..14L).flatMap { agendaForDay(today.plusDays(it), model.snapshot, model.calendar, model.tasks, model.hidden) }
    }
    val next = if ("lessons" in cards) nextCommitment(agenda, now, zone) else null
    val urgent = sortHomeworkTasks(model.tasks.filter { !it.done }).sortedBy { when (taskBucket(it, today)) { "Overdue" -> 0; "Today" -> 1; "Upcoming" -> 2; else -> 3 } }
    var selected by remember { mutableStateOf<AgendaEntry?>(null) }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    val recent = flattenNotes(model.tree).sortedByDescending { it.modifiedAt }.take(3)
    ScreenList {
        item {
            Text(dateLabel(today), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val firstName = model.snapshot.profile?.firstName.orEmpty()
            Text(if (firstName.isNotBlank()) "Hello, $firstName." else "A little more in focus.", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 8.dp, bottom = 20.dp))
        }
        if (model.link.needsReauth) item { InfoBanner("Reconnect your school", "Your last school data is still here.", "Sign in", onAction = { model.navigate(Page.Connections) }) }
        else if (sync.status == SyncStatus.OFFLINE || sync.status == SyncStatus.ERROR) item {
            InfoBanner(if (sync.status == SyncStatus.OFFLINE) "You're offline" else "Sync needs attention", "Keep working. Changes are saved on this device.", "Account & sync", onAction = { model.navigate(Page.Connections) })
        }
        if ("lessons" in cards) item {
            if (next != null) {
                Surface(onClick = { selected = next }, color = MaterialTheme.colorScheme.primaryContainer, shape = MaterialTheme.shapes.large, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(20.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (next.day == today) "UP NEXT" else dueLabel(next.day.toString()).uppercase(Locale.ENGLISH), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.weight(1f))
                            Icon(Icons.Outlined.ArrowOutward, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                        }
                        Text(courseAlias(next.title, model.desk.courseAliases), style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(top = 14.dp, bottom = 4.dp))
                        Text(listOf(next.time, next.detail).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodyMedium)
                        if (next.school?.isSubstitution() == true) Tag("Substitution", LocalCompanionSemantics.current.warning)
                    }
                }
            } else {
                Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.large) {
                    Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Icon(Icons.Outlined.WbSunny, null, tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f)) {
                            Text("Room to breathe", style = MaterialTheme.typography.titleMedium)
                            Text("No upcoming commitments in your planner.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            TextButton(onClick = { model.openPlanner() }, modifier = Modifier.fillMaxWidth()) { Text("Open today's schedule", Modifier.weight(1f)); Spacer(Modifier.width(6.dp)); Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp)) }
        }
        if ("tasks" in cards) {
            item { SectionLabel("On your list", if (urgent.isEmpty()) "Tasks" else "All ${urgent.size}") { model.openPlanner(true) } }
            if (urgent.isEmpty()) item {
                Row(Modifier.padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Icon(Icons.Outlined.CheckCircleOutline, null, tint = LocalCompanionSemantics.current.success)
                    Text("You're all caught up.", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
            items(urgent.take(3), key = { "today-task:${it.id}" }) { item -> TaskRow(item, today, { model.toggleTask(item) }) { task = item } }
            if (model.snapshot.homework.isNotEmpty()) item { TextButton(onClick = { model.openPlanner(true); model.taskSource = "school" }) { Text("${model.snapshot.homework.size} school assignments to review") } }
        }
        item { SectionLabel("Pick up a note", "Library") { model.select(Destination.Notes) } }
        if (recent.isEmpty()) item { Text("Your notes will be waiting here. Capture an idea with Create.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
        items(recent, key = { "recent:${it.path}" }) { node -> NoteRow(model, node) { model.openNote(node.path) } }
        if ("exam" in cards) {
            val exam = nextCommitment(agenda.filter { it.kind == AgendaKind.Exam && it.key != next?.key }, now, zone)
            if (exam != null) {
                item { SectionLabel("Coming into view") }
                item { AgendaRow(model, exam) { selected = exam } }
            }
        }
        if ("grades" in cards && model.snapshot.grades.isNotEmpty()) item {
            SectionLabel("From school")
            SettingRow(Icons.Outlined.Insights, "Your grades", "${courseSummaries(model.snapshot.grades, model.hypothetical).size} subjects · review your progress") { model.navigate(Page.Grades) }
        }
        if ("pluspunkte" in cards && model.desk.showPluspunkte && model.snapshot.grades.isNotEmpty()) item {
            val total = promotionTotals(courseSummaries(model.snapshot.grades, model.hypothetical))
            Text("Promotion points ${formatPluspunkte(total.total)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
        }
        if ("events" in cards && (model.snapshot.messages.isNotEmpty() || model.snapshot.startMessages.isNotEmpty())) item {
            SettingRow(Icons.Outlined.NotificationsNone, "School updates", "${model.snapshot.messages.size + model.snapshot.startMessages.size} messages & announcements") { model.navigate(Page.Updates) }
        }
    }
    selected?.let { AgendaDetails(model, it) { selected = null } }
    task?.let { TaskForm(model, it) { task = null } }
}

@Composable
fun PlannerScreen(model: CompanionModel) {
    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = Space.page, vertical = 8.dp)) {
            listOf("Schedule", "Tasks").forEachIndexed { index, title ->
                SegmentedButton(selected = model.plannerTasks == (index == 1), onClick = { model.plannerTasks = index == 1 }, shape = SegmentedButtonDefaults.itemShape(index, 2)) { Text(title) }
            }
        }
        if (model.plannerTasks) TasksScreen(model) else ScheduleScreen(model)
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
        days.associateWith { agendaForDay(it, model.snapshot, model.calendar, model.tasks, model.hidden, zone) }
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
    val compact = maxHeight < 350.dp
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            ActionIcon(Icons.Outlined.ChevronLeft, if (compact) "Previous day" else "Previous week") { model.day = if (compact) model.day.minusDays(1) else model.day.minusWeeks(1) }
            TextButton(onClick = { picker = true }, modifier = Modifier.weight(1f)) {
                Text(model.day.format(DateTimeFormatter.ofPattern(if (compact) "EEE, d MMM" else "MMMM yyyy", Locale.ENGLISH)), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(18.dp))
            }
            if (compact) Box {
                ActionIcon(Icons.Outlined.FilterList, "Schedule sources: $source") { sourceMenu = true }
                DropdownMenu(sourceMenu, { sourceMenu = false }) {
                    listOf("all" to "All entries", "school" to "School", "personal" to "Personal", "due" to "Deadlines").forEach { (id, label) ->
                        DropdownMenuItem(text = { Text(label) }, leadingIcon = { if (source == id) Icon(Icons.Outlined.Check, null) }, onClick = { source = id; sourceMenu = false })
                    }
                }
            }
            TextButton(onClick = { model.day = today; model.planWeek = false }) { Text("Today") }
            ActionIcon(Icons.Outlined.ChevronRight, if (compact) "Next day" else "Next week") { model.day = if (compact) model.day.plusDays(1) else model.day.plusWeeks(1) }
        }
        if (!compact) {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Space.page), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            days.forEach { day ->
                val chosen = day == model.day
                Column(Modifier.widthIn(min = 44.dp).clip(MaterialTheme.shapes.medium).background(if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.background)
                    .clickable { model.day = day; model.planWeek = false }
                    .semantics { contentDescription = dateLabel(day); this.selected = chosen }
                    .padding(vertical = 8.dp, horizontal = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(day.dayOfWeek.getDisplayName(java.time.format.TextStyle.NARROW, Locale.ENGLISH), style = MaterialTheme.typography.labelMedium,
                        color = if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(day.dayOfMonth.toString(), style = MaterialTheme.typography.titleMedium, color = if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface)
                    Box(Modifier.padding(top = 4.dp).size(4.dp).background(if (agenda[day].orEmpty().isNotEmpty()) { if (chosen) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.primary } else androidx.compose.ui.graphics.Color.Transparent, CircleShape))
                }
            }
        }
        ChoiceRow(listOf("all" to "All", "school" to "School", "personal" to "Personal", "due" to "Deadlines"), source, { source = it }, Modifier.padding(horizontal = Space.page, vertical = 4.dp))
        }
        FineDivider()
        ScreenList {
            item { Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(if (model.planWeek) "This week" else dateLabel(model.day), style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { model.planWeek = !model.planWeek }) { Text(if (model.planWeek) "Day view" else "Week view") }
            } }
            val shownDays = if (model.planWeek) days.filter { model.desk.showWeekend || it.dayOfWeek.value < 6 || agenda[it].orEmpty().isNotEmpty() } else listOf(model.day)
            shownDays.forEach { day ->
                val entries = agenda[day].orEmpty().filter { entry -> when (source) { "school" -> entry.school != null; "personal" -> entry.local != null; "due" -> entry.kind == AgendaKind.Task || entry.kind == AgendaKind.Exam; else -> true } }
                    .filter { it.school == null || !it.school.isLesson() || eventInHours(it.school, model.desk.dayStartHour, model.desk.dayEndHour, zone) }
                if (model.planWeek) item(key = "date:$day") { SectionLabel(dateLabel(day)) }
                if (entries.isEmpty()) item(key = "empty:$day") {
                    if (model.planWeek) Text("No commitments", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 16.dp))
                    else EmptyState(Icons.Outlined.EventAvailable, "A clear day", if (source == "school" && model.snapshot.fetchedAt.isBlank()) "Connect Schulnetz in Settings to see your lessons here." else "No ${if (source == "all") "commitments" else source} entries for this date.")
                }
                items(entries, key = { it.key }) { entry -> AgendaRow(model, entry) { selected = entry } }
            }
            if (model.snapshot.readErrors.any { it.startsWith("Stundenplan:") }) item { InfoBanner("Timetable unavailable", "The last school refresh could not read the timetable.", "Connection details", onAction = { model.navigate(Page.Connections) }) }
        }
    }
    }
    if (picker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = model.day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { picker = false }, confirmButton = { TextButton(onClick = { state.selectedDateMillis?.let { model.day = Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate() }; picker = false }) { Text("Go to date") } }, dismissButton = { TextButton(onClick = { picker = false }) { Text("Cancel") } }) { DatePicker(state) }
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
                Text(entry.start.ifBlank { if (entry.kind == AgendaKind.Task) "Due" else "All day" }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (entry.end.isNotBlank() && entry.end != entry.start) Text(entry.end, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box(Modifier.width(3.dp).height(40.dp).background(if (cancelled) MaterialTheme.colorScheme.error else accent, CircleShape))
            Column(Modifier.weight(1f)) {
                Text(courseAlias(entry.title, model.desk.courseAliases), style = MaterialTheme.typography.titleMedium,
                    textDecoration = if (cancelled) TextDecoration.LineThrough else TextDecoration.None, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (cancelled) Text("Cancelled", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                else if (entry.school?.isSubstitution() == true) Text("Substitution", style = MaterialTheme.typography.labelMedium, color = LocalCompanionSemantics.current.warning)
                else if (entry.kind != AgendaKind.Lesson) Text(entry.kind.label, style = MaterialTheme.typography.labelSmall, color = accent)
            }
            Icon(Icons.Outlined.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        FineDivider()
    }
}

@Composable
fun TaskRow(task: HomeworkTask, today: LocalDate, onToggle: () -> Unit, onOpen: () -> Unit) {
    val overdue = taskBucket(task, today) == "Overdue"
    Row(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.small).clickable(onClick = onOpen).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked = task.done, onCheckedChange = { onToggle() }, modifier = Modifier.semantics { contentDescription = "${if (task.done) "Reopen" else "Complete"} ${task.title}" })
        Column(Modifier.weight(1f).padding(start = 4.dp, end = 8.dp)) {
            Text(task.title, style = MaterialTheme.typography.bodyLarge, textDecoration = if (task.done) TextDecoration.LineThrough else TextDecoration.None, color = if (task.done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
            Text(listOf(task.subject, dueLabel(task.dueDate), task.dueTime.orEmpty()).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
            if (task.notes.isNotBlank()) Text(plainPreview(task.notes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (task.priority == "high") Icon(Icons.Outlined.Flag, "Important", Modifier.size(18.dp), tint = LocalCompanionSemantics.current.warning)
    }
    FineDivider()
}

@Composable
private fun TasksScreen(model: CompanionModel) {
    var query by rememberSaveable { mutableStateOf("") }
    var task by remember { mutableStateOf<HomeworkTask?>(null) }
    var schoolTask by remember { mutableStateOf<SchoolHomework?>(null) }
    val today = rememberNow().atZone(ZoneId.systemDefault()).toLocalDate()
    Column {
        SearchField(query, { query = it }, "Find an assignment", Modifier.padding(horizontal = Space.page, vertical = 8.dp))
        ChoiceRow(listOf("open" to "Open", "done" to "Completed", "school" to "From school"), model.taskSource, { model.taskSource = it }, Modifier.padding(horizontal = Space.page))
        ScreenList {
            if (model.taskSource == "school") {
                item { Text("School assignments are read-only. Add one to your tasks to track your own progress.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                val tasks = model.snapshot.homework.filter { "${it.title} ${it.courseName} ${it.description}".contains(query, true) }.sortedBy { it.dueDate }
                if (tasks.isEmpty()) item { EmptyState(Icons.AutoMirrored.Outlined.Assignment, "No school assignments", if (query.isNotBlank()) "Try another search." else "Assignments appear after a school refresh, when your school provides them.") }
                items(tasks, key = { "school-task:${it.id}" }) { item ->
                    Column(Modifier.fillMaxWidth().clickable { schoolTask = item }.padding(vertical = 16.dp)) {
                        Text(item.title, style = MaterialTheme.typography.titleMedium)
                        Text(listOf(item.courseName, dueLabel(item.dueDate)).filter { it.isNotBlank() }.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }) Tag("Added to tasks")
                    }
                    FineDivider()
                }
            } else {
                val tasks = sortHomeworkTasks(model.tasks).filter { it.done == (model.taskSource == "done") && "${it.title} ${it.subject} ${it.notes}".contains(query, true) }
                if (tasks.isEmpty()) item { EmptyState(Icons.Outlined.CheckCircleOutline, if (query.isNotBlank()) "Nothing matches" else if (model.taskSource == "done") "A fresh start" else "Nothing left on your list", if (query.isNotBlank()) "Try a subject or a shorter search." else if (model.taskSource == "done") "Finished tasks will be kept here." else "Add homework with New task, or review assignments from school.") }
                listOf("Overdue", "Today", "Upcoming", "No due date", "Completed").forEach { bucket ->
                    val group = tasks.filter { taskBucket(it, today) == bucket }
                    if (group.isNotEmpty()) {
                        item(key = "bucket:$bucket") { SectionLabel("$bucket · ${group.size}") }
                        items(group, key = { "task:${it.id}" }) { item -> TaskRow(item, today, { model.toggleTask(item) }) { task = item } }
                    }
                }
            }
        }
    }
    task?.let { TaskForm(model, it) { task = null } }
    schoolTask?.let { item ->
        ModalBottomSheet(onDismissRequest = { schoolTask = null }) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Space.page).navigationBarsPadding().padding(bottom = Space.xl)) {
                SheetTitle(item.title) { schoolTask = null }
                Tag("Schulnetz · read-only")
                Text("${item.courseName} · ${dueLabel(item.dueDate)}", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(vertical = 12.dp))
                Text(item.description, style = MaterialTheme.typography.bodyLarge)
                val imported = model.tasks.any { it.title == item.title && it.subject == item.courseName && it.dueDate == parseDisplayDate(item.dueDate)?.toString() }
                Button(onClick = { model.importHomework(item.title, item.courseName, item.dueDate, item.description); schoolTask = null }, enabled = !imported, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) { Text(if (imported) "Already in your tasks" else "Add to my tasks") }
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
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Space.page).navigationBarsPadding().padding(bottom = Space.xl)) {
            SheetTitle(courseAlias(entry.title, model.desk.courseAliases), onDismiss)
            Tag(if (entry.school != null) "Schulnetz · ${entry.kind.label.lowercase()}" else "FaNotes calendar")
            Text(dateLabel(entry.day), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 20.dp))
            Text(entry.time, style = MaterialTheme.typography.bodyLarge)
            if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
            val description = entry.school?.comment ?: entry.local?.notes.orEmpty()
            if (description.isNotBlank()) Text(description, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 16.dp))
            if (entry.school?.isCancelled() == true) Text("This lesson is cancelled.", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp))
            if (entry.local != null) {
                Button(onClick = { edit = true }, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) { Text("Edit event") }
                if (entry.local.notePath.isNotBlank()) TextButton(onClick = { onDismiss(); model.openNote(entry.local.notePath) }, modifier = Modifier.fillMaxWidth()) { Text("Open linked note") }
            }
            if (entry.school != null && entry.kind == AgendaKind.Exam) {
                val imported = model.calendar.events.any { it.id == "schulnetz-${entry.school.id}" }
                Button(onClick = { model.importExam(entry.school); onDismiss() }, enabled = !imported, modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
                    Text(if (imported) "Already in your calendar" else "Add to my calendar")
                }
            }
            if (entry.school?.isLesson() == true && entry.kind == AgendaKind.Lesson) {
                SectionLabel("Personal timetable")
                Text("Hidden lessons can be restored in Planning settings.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { model.hideLesson(entry.school, false); onDismiss() }) { Text("Hide this lesson") }
                TextButton(onClick = { model.hideLesson(entry.school, true); onDismiss() }) { Text("Hide this weekly lesson") }
            }
        }
    }
}
